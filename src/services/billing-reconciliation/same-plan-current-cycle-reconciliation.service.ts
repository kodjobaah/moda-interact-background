import { Prisma, SubscriptionProjectionStatus } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";

import { ensureCurrentBillingPeriodProjection } from "../current-billing-period-projection.service.js";
import { ensureLifetimeFreeCounterForMappedSubscription } from "./lifetime-free-counter-repair.js";
import type { BillingReconciliationSchedulerService } from "./reconciliation-scheduler.service.js";
import type {
  SamePlanProjection,
  SamePlanReconciliationInput,
} from "./same-plan-reconciliation.types.js";

type CurrentCycleDatabase = Pick<PrismaClient, "$transaction">;
type ReconciliationScheduler = Pick<BillingReconciliationSchedulerService, "enqueue">;

type CurrentCycleInput = SamePlanReconciliationInput & {
  status: SubscriptionProjectionStatus;
  syncErrorCode: string | null;
};

export type SamePlanCurrentCycleResult =
  | { kind: "continue" }
  | ({ kind: "handled" } & SamePlanProjection);

export class SamePlanCurrentCycleReconciliationService {
  constructor(
    private readonly database: CurrentCycleDatabase,
    private readonly scheduler: ReconciliationScheduler,
    private readonly logger: StructuredLogger,
  ) {}

  async reconcile(input: CurrentCycleInput): Promise<SamePlanCurrentCycleResult> {
    if (!providerMatchesCurrentCycle(input)) return { kind: "continue" };

    const { shopId, provider, plan, existing, now, status, syncErrorCode } = input;
    const projection = await this.database.$transaction(async (transaction: Prisma.TransactionClient) => {
      await transaction.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "billing"."Subscription"
        WHERE "id" = ${existing.id}
        FOR UPDATE
      `);
      const current = await transaction.subscription.findUnique({
        where: { id: existing.id },
        select: {
          id: true,
          status: true,
          planId: true,
          billingPeriodId: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          nextReconcileAt: true,
        },
      });
      if (!current
        || current.status !== existing.status
        || current.planId !== existing.planId
        || current.billingPeriodId !== existing.billingPeriodId
        || current.currentPeriodStart?.getTime() !== existing.currentPeriodStart?.getTime()
        || current.currentPeriodEnd?.getTime() !== existing.currentPeriodEnd?.getTime()
        || current.nextReconcileAt?.getTime() !== existing.nextReconcileAt?.getTime()) {
        return { kind: "stale" as const };
      }

      const lifetimeCounter = await ensureLifetimeFreeCounterForMappedSubscription(transaction, shopId);
      if (lifetimeCounter.kind === "history-conflict") {
        await transaction.subscription.update({
          where: { id: existing.id },
          data: {
            status: SubscriptionProjectionStatus.SYNC_ERROR,
            lastSyncErrorCode: "LIFETIME_FREE_COUNTER_HISTORY_CONFLICT",
            lastSyncErrorAt: now,
            lastSyncedAt: now,
            nextReconcileAt: null,
          },
        });
        return { kind: "lifetime-counter-conflict" as const };
      }

      const result = await ensureCurrentBillingPeriodProjection(transaction, {
        shopId,
        subscriptionId: existing.id,
        periodStart: provider.currentPeriodStart!,
        periodEnd: provider.currentPeriodEnd!,
        providerPlanHandle: provider.planHandle,
        plan,
      });
      if (result.kind === "CONFLICT") {
        const nextReconcileAt = new Date(now.getTime() + 60 * 1000);
        await transaction.subscription.update({
          where: { id: existing.id },
          data: {
            status: SubscriptionProjectionStatus.SYNC_ERROR,
            lastSyncErrorCode: "BILLING_PERIOD_PLAN_CONFLICT",
            lastSyncErrorAt: now,
            lastSyncedAt: now,
            nextReconcileAt,
          },
        });
        return { kind: "conflict" as const, nextReconcileAt };
      }

      await transaction.subscription.update({
        where: { id: existing.id },
        data: {
          status,
          observedShopifyPlanHandle: provider.planHandle,
          billingPeriodId: result.billingPeriodId,
          currentPeriodStart: provider.currentPeriodStart,
          currentPeriodEnd: provider.currentPeriodEnd,
          lastSyncedAt: now,
          lastSyncErrorCode: syncErrorCode,
          lastSyncErrorAt: syncErrorCode ? now : null,
        },
      });
      return { kind: "ready" as const };
    });

    if (projection.kind === "conflict") {
      await this.scheduler.enqueue(shopId, existing.id, projection.nextReconcileAt, now);
      return { kind: "handled", billingPeriodId: existing.billingPeriodId, packMeterHandle: null };
    }
    if (projection.kind === "lifetime-counter-conflict") {
      this.logger.warn("billing.subscription_reconciliation.lifetime_free_counter_history_conflict", { shopId });
      return { kind: "handled", billingPeriodId: existing.billingPeriodId, packMeterHandle: null };
    }
    if (projection.kind === "stale") {
      return { kind: "handled", billingPeriodId: existing.billingPeriodId, packMeterHandle: null };
    }
    return { kind: "continue" };
  }
}

function providerMatchesCurrentCycle(input: SamePlanReconciliationInput): boolean {
  const { provider, existing } = input;
  return Boolean(
    provider.currentPeriodStart
    && provider.currentPeriodEnd
    && existing.currentPeriodStart
    && existing.currentPeriodEnd
    && provider.currentPeriodStart.getTime() === existing.currentPeriodStart.getTime()
    && provider.currentPeriodEnd.getTime() === existing.currentPeriodEnd.getTime()
  );
}
