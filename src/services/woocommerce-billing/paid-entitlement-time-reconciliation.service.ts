import {
  BillingPlanKind,
  ShopPlatform,
  SubscriptionProjectionStatus,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import prisma from "../../lib/db.js";
import { recoveryCapacityResumeService } from "../recovery-capacity-resume.service.js";
import { lockShop, lockSubscription } from "../billing-subscription-reconciliation/locking.js";
import { reconcileWooPaidSubscriptionInTransaction } from "./paid-entitlement-transition.js";
import type { WooPaidEntitlementOutcome } from "./paid-entitlement-transition.js";

const logger = createLogger({
  serviceName: "moda-billing-worker",
  environment: resolveDeploymentEnvironmentName(),
});

type ResumeScheduler = Pick<typeof recoveryCapacityResumeService, "schedule">;
type Candidate = { id: string; shopId: string };

export type WooPaidEntitlementReconciliationResult = {
  selected: number;
  rolledOver: number;
  frozen: number;
  ended: number;
  unchanged: number;
  errors: number;
};

export class WooPaidEntitlementTimeReconciliationService {
  private lastSubscriptionId: string | undefined;

  constructor(
    private readonly database: PrismaClient = prisma,
    private readonly resumeService: ResumeScheduler = recoveryCapacityResumeService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reconcileOnce(batchSize: number): Promise<WooPaidEntitlementReconciliationResult> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 200) {
      throw new Error("Woo paid entitlement batch size must be between 1 and 200");
    }
    const now = this.now();
    const candidates = await this.selectDueCandidates(now, batchSize);
    const result: WooPaidEntitlementReconciliationResult = {
      selected: candidates.length,
      rolledOver: 0,
      frozen: 0,
      ended: 0,
      unchanged: 0,
      errors: 0,
    };
    for (const candidate of candidates) {
      try {
        const outcome = await this.reconcileCandidate(candidate, now);
        result[outcome === "rolled-over" ? "rolledOver" : outcome] += 1;
        if (outcome === "rolled-over") {
          try {
            await this.resumeService.schedule({ shopId: candidate.shopId, trigger: "woo-billing-period-rollover" });
          } catch (error) {
            logger.warn("billing.recovery_capacity_resume.enqueue_failed", {
              shopId: candidate.shopId,
              errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure",
            });
          }
        }
      } catch (error) {
        result.errors += 1;
        logger.error("billing.woocommerce.paid_entitlement.reconciliation_failed", {
          subscriptionId: candidate.id,
          shopId: candidate.shopId,
          errorName: error instanceof Error ? error.name.slice(0, 64) : "UnknownError",
          errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure",
        });
      }
    }
    return result;
  }

  private async selectDueCandidates(now: Date, batchSize: number): Promise<Candidate[]> {
    const due = {
      OR: [
        { nextReconcileAt: { lte: now } },
        { nextReconcileAt: null, providerCoverageEndAt: { not: null } },
      ],
    };
    const base = {
      where: {
        status: SubscriptionProjectionStatus.ACTIVE,
        providerSubscriptionId: { not: null },
        plan: { is: { kind: BillingPlanKind.PAID_METERED } },
        shop: { is: { platform: ShopPlatform.WOOCOMMERCE, status: "ACTIVE" as const } },
        ...due,
      },
      orderBy: { id: "asc" as const },
      take: batchSize,
      select: { id: true, shopId: true },
    };
    const afterCursor = this.lastSubscriptionId
      ? await this.database.subscription.findMany({
          ...base,
          where: { ...base.where, id: { gt: this.lastSubscriptionId } },
        })
      : [];
    const candidates = afterCursor.length > 0
      ? afterCursor
      : await this.database.subscription.findMany(base);
    const lastCandidate = candidates.at(-1);
    if (lastCandidate) this.lastSubscriptionId = lastCandidate.id;
    return candidates;
  }

  private async reconcileCandidate(candidate: Candidate, now: Date): Promise<WooPaidEntitlementOutcome> {
    return this.database.$transaction(async (transaction) => {
      await lockShop(transaction, candidate.shopId);
      const shop = await transaction.shop.findUnique({
        where: { id: candidate.shopId },
        select: { platform: true, status: true },
      });
      if (shop?.platform !== ShopPlatform.WOOCOMMERCE || shop.status !== "ACTIVE") return "unchanged";

      await lockSubscription(transaction, candidate.id);
      const current = await transaction.subscription.findUnique({
        where: { id: candidate.id },
        include: { plan: true, billingPeriod: { include: { entitlementCounters: true } } },
      });
      if (!current || current.shopId !== candidate.shopId) return "unchanged";
      return reconcileWooPaidSubscriptionInTransaction(transaction, current, now);
    });
  }
}

export const wooPaidEntitlementTimeReconciliationService =
  new WooPaidEntitlementTimeReconciliationService();