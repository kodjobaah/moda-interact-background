import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import {
  MERCHANT_KNOWLEDGE_PROCESS_JOB_NAME,
  type MerchantKnowledgeProcessSourceRevisionJob,
} from "@modainteract/moda-interact-shared/merchant-knowledge";
import { createMerchantKnowledgeProcessJobId } from "@modainteract/moda-interact-shared/merchant-knowledge/node";

import { merchantKnowledgeQueue } from "../entrypoints/merchant-knowledge-resources.js";
import prisma from "../lib/db.js";
import {
  merchantKnowledgeEntitlementService,
  type MerchantKnowledgeEntitlementService,
} from "./merchant-knowledge-entitlement.service.js";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

type ReconciliationDatabase = Pick<PrismaClient, "merchantKnowledgeSourceRevision">;
type ReconciliationQueue = Pick<Queue, "add">;
type SourceEligibilityResolver = Pick<
  MerchantKnowledgeEntitlementService,
  "resolveSourceEligibility"
>;

export class MerchantKnowledgeReconciliationService {
  constructor(
    private readonly database: ReconciliationDatabase = prisma,
    private readonly queue: ReconciliationQueue = merchantKnowledgeQueue,
    private readonly eligibility: SourceEligibilityResolver = merchantKnowledgeEntitlementService,
  ) {}

  async reconcilePendingOnce(input?: { pageSize?: number }): Promise<{
    scanned: number;
    enqueued: number;
    skippedStale: number;
    skippedDormant: number;
  }> {
    const pageSize = input?.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
      throw new RangeError(`pageSize must be an integer from 1 to ${MAX_PAGE_SIZE}`);
    }

    const revisions = await this.database.merchantKnowledgeSourceRevision.findMany({
      where: { status: "PENDING" },
      orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
      take: pageSize,
      select: {
        id: true,
        generation: true,
        requestedAt: true,
        source: {
          select: { id: true, shopId: true, currentGeneration: true },
        },
      },
    });

    let enqueued = 0;
    let skippedStale = 0;
    let skippedDormant = 0;

    for (const revision of revisions) {
      if (revision.generation !== revision.source.currentGeneration) {
        skippedStale += 1;
        continue;
      }

      const eligibility = await this.eligibility.resolveSourceEligibility(
        revision.source.id,
      );
      if (!eligibility.eligible) {
        skippedDormant += 1;
        continue;
      }

      const job: MerchantKnowledgeProcessSourceRevisionJob = {
        schemaVersion: 1,
        shopId: revision.source.shopId,
        sourceRevisionId: revision.id,
        generation: revision.generation,
        requestedAt: revision.requestedAt.toISOString(),
      };
      await this.queue.add(MERCHANT_KNOWLEDGE_PROCESS_JOB_NAME, job, {
        jobId: createMerchantKnowledgeProcessJobId(job),
      });
      enqueued += 1;
    }

    return {
      scanned: revisions.length,
      enqueued,
      skippedStale,
      skippedDormant,
    };
  }
}

export const merchantKnowledgeReconciliationService =
  new MerchantKnowledgeReconciliationService();