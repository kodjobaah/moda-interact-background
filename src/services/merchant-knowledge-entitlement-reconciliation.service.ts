import { Prisma, SubscriptionProjectionStatus, type PrismaClient } from "@prisma/client";
import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import {
  MERCHANT_KNOWLEDGE_PROCESS_JOB_NAME,
  MERCHANT_KNOWLEDGE_PROCESS_SCHEMA_VERSION,
  type MerchantKnowledgeProcessSourceRevisionJob,
} from "@modainteract/moda-interact-shared/merchant-knowledge";
import { createMerchantKnowledgeProcessJobId } from "@modainteract/moda-interact-shared/merchant-knowledge/node";
import { resolveDeploymentEnvironmentName } from "@modainteract/moda-interact-shared/observability/node";
import type { Queue } from "bullmq";

import { merchantKnowledgeQueue } from "../entrypoints/merchant-knowledge-resources.js";
import prisma from "../lib/db.js";
import { MerchantKnowledgeEntitlementService } from "./merchant-knowledge-entitlement.service.js";

const DEFAULT_SHOP_PAGE_SIZE = 100;
const MAX_SHOP_PAGE_SIZE = 500;

type ReconciliationDatabase = Pick<
  PrismaClient,
  "$transaction" | "subscription" | "merchantKnowledgeSource"
>;
type ReconciliationQueue = Pick<Queue, "add">;

export interface MerchantKnowledgeEntitlementReconciliationResult {
  shopsScanned: number;
  sourcesScanned: number;
  contentLimitRevisionsCreated: number;
  sourceTypeDormant: number;
  sourceCountDormant: number;
  enqueueFailures: number;
}

interface ReconciliationDependencies {
  database?: ReconciliationDatabase;
  queue?: ReconciliationQueue;
  logger?: StructuredLogger;
  now?: () => Date;
}

interface ReplacementJob {
  id: string;
  shopId: string;
  generation: number;
  requestedAt: Date;
}

const logger = createLogger({
  serviceName: "moda-merchant-knowledge-worker",
  environment: resolveDeploymentEnvironmentName(),
});

export class MerchantKnowledgeEntitlementReconciliationService {
  private readonly database: ReconciliationDatabase;
  private readonly queue: ReconciliationQueue;
  private readonly log: StructuredLogger;
  private readonly now: () => Date;
  private lastShopId: string | undefined;

  constructor(dependencies: ReconciliationDependencies = {}) {
    this.database = dependencies.database ?? prisma;
    this.queue = dependencies.queue ?? merchantKnowledgeQueue;
    this.log = dependencies.logger ?? logger;
    this.now = dependencies.now ?? (() => new Date());
  }

  async reconcileOnce(input?: { shopPageSize?: number }): Promise<MerchantKnowledgeEntitlementReconciliationResult> {
    const shopPageSize = input?.shopPageSize ?? DEFAULT_SHOP_PAGE_SIZE;
    if (!Number.isInteger(shopPageSize) || shopPageSize < 1 || shopPageSize > MAX_SHOP_PAGE_SIZE) {
      throw new RangeError(`shopPageSize must be an integer from 1 to ${MAX_SHOP_PAGE_SIZE}`);
    }

    const where: Prisma.SubscriptionWhereInput = {
      status: {
        in: [SubscriptionProjectionStatus.ACTIVE, SubscriptionProjectionStatus.TRIALING],
      },
      plan: {
        is: {
          features: {
            some: {
              enabled: true,
              feature: {
                is: {
                  key: "merchant_knowledge",
                  active: true,
                  activationMode: "MERCHANT_OPT_IN",
                },
              },
            },
          },
        },
      },
      shop: {
        is: {
          featurePreferences: {
            some: {
              enabled: true,
              feature: {
                is: {
                  key: "merchant_knowledge",
                  active: true,
                  activationMode: "MERCHANT_OPT_IN",
                },
              },
            },
          },
        },
      },
    };
    if (this.lastShopId) where.shopId = { gt: this.lastShopId };

    const subscriptions = await this.database.subscription.findMany({
      where,
      orderBy: { shopId: "asc" },
      take: shopPageSize,
      select: { shopId: true },
    });

    const result: MerchantKnowledgeEntitlementReconciliationResult = {
      shopsScanned: subscriptions.length,
      sourcesScanned: 0,
      contentLimitRevisionsCreated: 0,
      sourceTypeDormant: 0,
      sourceCountDormant: 0,
      enqueueFailures: 0,
    };

    if (subscriptions.length === 0) {
      this.lastShopId = undefined;
      this.logResult(result);
      return result;
    }

    this.lastShopId = subscriptions.at(-1)?.shopId;
    for (const { shopId } of subscriptions) {
      const sources = await this.database.merchantKnowledgeSource.findMany({
        where: { shopId },
        orderBy: [{ position: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      const eligibilityService = new MerchantKnowledgeEntitlementService(this.database);

      for (const source of sources) {
        result.sourcesScanned += 1;
        const eligibility = await eligibilityService.resolveSourceEligibility(source.id);
        if (!eligibility.entitlement || !eligibility.activationModeEligible || !eligibility.merchantEnabled) {
          continue;
        }
        if (!eligibility.globallySupported || !eligibility.sourceTypeAllowed) {
          result.sourceTypeDormant += 1;
          continue;
        }
        if (!eligibility.withinSourceAllowance) {
          result.sourceCountDormant += 1;
          continue;
        }
        if (!eligibility.eligible) continue;

        const replacement = await this.createReplacementIfRequired(source.id);
        if (!replacement) continue;
        result.contentLimitRevisionsCreated += 1;
        try {
          const job: MerchantKnowledgeProcessSourceRevisionJob = {
            schemaVersion: MERCHANT_KNOWLEDGE_PROCESS_SCHEMA_VERSION,
            shopId: replacement.shopId,
            sourceRevisionId: replacement.id,
            generation: replacement.generation,
            requestedAt: replacement.requestedAt.toISOString(),
          };
          await this.queue.add(MERCHANT_KNOWLEDGE_PROCESS_JOB_NAME, job, {
            jobId: createMerchantKnowledgeProcessJobId(job),
          });
        } catch {
          result.enqueueFailures += 1;
        }
      }
    }

    this.logResult(result);
    return result;
  }

  private logResult(result: MerchantKnowledgeEntitlementReconciliationResult): void {
    this.log.info("merchant_knowledge.entitlement_reconciliation.completed", {
      shopsScanned: result.shopsScanned,
      sourcesScanned: result.sourcesScanned,
      contentLimitRevisionsCreated: result.contentLimitRevisionsCreated,
      sourceTypeDormant: result.sourceTypeDormant,
      sourceCountDormant: result.sourceCountDormant,
      enqueueFailures: result.enqueueFailures,
    });
  }

  private async createReplacementIfRequired(sourceId: string): Promise<ReplacementJob | null> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "commerce"."MerchantKnowledgeSource"
        WHERE "id" = ${sourceId}
        FOR UPDATE
      `);
      if (locked.length === 0) return null;

      const source = await transaction.merchantKnowledgeSource.findUnique({
        where: { id: sourceId },
        select: {
          id: true,
          shopId: true,
          currentGeneration: true,
          dataFormat: { select: { key: true } },
        },
      });
      if (!source) return null;

      const eligibility = await new MerchantKnowledgeEntitlementService(transaction)
        .resolveSourceEligibility(sourceId);
      if (!eligibility.eligible || !eligibility.entitlement) return null;

      const activeRevision = await transaction.merchantKnowledgeSourceRevision.findFirst({
        where: { sourceId, status: "ACTIVE" },
        orderBy: { generation: "desc" },
        select: {
          id: true,
          generation: true,
          contentUnits: true,
          requestedUrl: true,
          uploadedAssetId: true,
        },
      });
      if (
        !activeRevision
        || activeRevision.contentUnits === null
        || activeRevision.contentUnits <= eligibility.entitlement.maxContentUnitsPerSource
      ) {
        return null;
      }

      const newerWork = await transaction.merchantKnowledgeSourceRevision.findFirst({
        where: {
          sourceId,
          generation: { gt: activeRevision.generation },
          status: { in: ["PENDING", "PROCESSING"] },
        },
        select: { id: true },
      });
      if (newerWork || source.currentGeneration !== activeRevision.generation) return null;

      let requestedUrl: string | null;
      let uploadedAssetId: string | null;
      if (source.dataFormat.key === "WEB_PAGE") {
        requestedUrl = activeRevision.requestedUrl;
        uploadedAssetId = null;
      } else if (source.dataFormat.key === "CSV" || source.dataFormat.key === "XLSX") {
        requestedUrl = null;
        uploadedAssetId = activeRevision.uploadedAssetId;
      } else {
        return null;
      }

      const generation = source.currentGeneration + 1;
      const update = await transaction.merchantKnowledgeSource.updateMany({
        where: { id: sourceId, currentGeneration: activeRevision.generation },
        data: { currentGeneration: { increment: 1 } },
      });
      if (update.count !== 1) return null;

      const requestedAt = this.now();
      const revision = await transaction.merchantKnowledgeSourceRevision.create({
        data: {
          sourceId,
          generation,
          reason: "ENTITLEMENT_CHANGE",
          status: "PENDING",
          requestedAt,
          requestedUrl,
          uploadedAssetId,
        },
        select: { id: true, generation: true, requestedAt: true },
      });
      return { ...revision, shopId: source.shopId };
    });
  }
}

export const merchantKnowledgeEntitlementReconciliationService =
  new MerchantKnowledgeEntitlementReconciliationService();