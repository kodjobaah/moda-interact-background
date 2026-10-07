import { BillingPlanKind, SubscriptionProjectionStatus } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS } from "@modainteract/moda-interact-shared/billing";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";

import {
  recoveryCapacityResumeService,
  type RecoveryCapacityResumeService,
} from "../recovery-capacity-resume.service.js";
import { SamePlanBillingPeriodRolloverService } from "../same-plan-billing-period-rollover.service.js";
import type { BillingReconciliationSchedulerService } from "./reconciliation-scheduler.service.js";
import type {
  SamePlanProjection,
  SamePlanReconciliationInput,
} from "./same-plan-reconciliation.types.js";

type PeriodProgressionDatabase = Pick<PrismaClient, "$transaction" | "billingPlan" | "subscription">;
type ReconciliationScheduler = Pick<BillingReconciliationSchedulerService, "enqueue">;
type CapacityResumeScheduler = Pick<RecoveryCapacityResumeService, "schedule">;
type SamePlanRollover = Pick<SamePlanBillingPeriodRolloverService, "transition">;

export class SamePlanPeriodProgressionService {
  constructor(
    private readonly database: PeriodProgressionDatabase,
    private readonly scheduler: ReconciliationScheduler,
    private readonly logger: StructuredLogger,
    private readonly capacityResume: CapacityResumeScheduler = recoveryCapacityResumeService,
    private readonly rollover: SamePlanRollover = new SamePlanBillingPeriodRolloverService(database),
  ) {}

  async reconcile(input: SamePlanReconciliationInput): Promise<SamePlanProjection> {
    const scheduledIntent = await this.persistFutureIntent(input);
    if (scheduledIntent) return scheduledIntent;

    const { shopId, provider, plan, existing, now } = input;
    const result = await this.rollover.transition({
      shopId,
      subscriptionId: existing.id,
      provider,
      plan,
      now,
    });

    if (result.kind === "transitioned") {
      if (result.planKind === BillingPlanKind.PAID_METERED) {
        try {
          await this.capacityResume.schedule({ shopId, trigger: "billing-period-rollover" });
        } catch (error) {
          this.logger.warn("billing.recovery_capacity_resume.enqueue_failed", {
            shopId,
            errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure",
          });
        }
      }
      return {
        billingPeriodId: result.billingPeriodId,
        packMeterHandle: plan.shopifyRecoveryCreditPackEventHandle ?? null,
      };
    }

    if (result.kind === "unchanged") {
      return {
        billingPeriodId: result.billingPeriodId,
        packMeterHandle: plan.shopifyRecoveryCreditPackEventHandle ?? null,
      };
    }

    if (result.kind === "provider-cycle-lag" && providerCycleLagIsRetryable(input)) {
      const nextReconcileAt = new Date(now.getTime() + 60 * 1000);
      const updated = await this.database.subscription.updateMany({
        where: {
          id: existing.id,
          status: {
            in: [SubscriptionProjectionStatus.ACTIVE, SubscriptionProjectionStatus.TRIALING],
          },
          planId: existing.planId,
          billingPeriodId: existing.billingPeriodId,
          currentPeriodStart: existing.currentPeriodStart,
          currentPeriodEnd: existing.currentPeriodEnd,
          nextReconcileAt: existing.nextReconcileAt,
        },
        data: {
          nextReconcileAt,
          lastSyncedAt: now,
          lastSyncErrorCode: "PROVIDER_CYCLE_LAG",
          lastSyncErrorAt: now,
        },
      });
      if (updated.count > 0) {
        await this.scheduler.enqueue(shopId, existing.id, nextReconcileAt, now);
      }
    }

    const current = await this.database.subscription.findUnique({
      where: { id: existing.id },
      select: { billingPeriodId: true },
    });
    return {
      billingPeriodId: current?.billingPeriodId ?? null,
      packMeterHandle: plan.shopifyRecoveryCreditPackEventHandle ?? null,
    };
  }

  private async persistFutureIntent(
    input: SamePlanReconciliationInput,
  ): Promise<SamePlanProjection | null> {
    const { shopId, provider, plan, existing, now } = input;
    const currentPeriodStart = provider.currentPeriodStart;
    const currentPeriodEnd = provider.currentPeriodEnd;
    if (
      !(provider.pendingPlanHandle !== null || provider.cancelAtPeriodEnd || existing.cancelAtPeriodEnd)
      || !currentPeriodEnd
      || currentPeriodEnd <= now
      || currentPeriodStart?.getTime() !== existing.currentPeriodStart?.getTime()
      || currentPeriodEnd.getTime() !== existing.currentPeriodEnd?.getTime()
    ) {
      return null;
    }

    const pendingPlan = provider.pendingPlanHandle
      ? await this.database.billingPlan.findUnique({
          where: { shopifyPlanHandle: provider.pendingPlanHandle },
          select: { id: true, active: true },
        })
      : null;
    const next = provider.pendingPlanHandle && provider.pendingEffectiveAt
      ? provider.pendingEffectiveAt
      : now < new Date(currentPeriodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS)
        ? new Date(currentPeriodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS)
        : currentPeriodEnd;
    const updated = await this.database.subscription.updateMany({
      where: {
        id: existing.id,
        planId: existing.planId,
        billingPeriodId: existing.billingPeriodId,
        nextReconcileAt: existing.nextReconcileAt,
      },
      data: {
        pendingShopifyPlanHandle: provider.pendingPlanHandle,
        pendingPlanId: pendingPlan?.active ? pendingPlan.id : null,
        pendingEffectiveAt: provider.pendingEffectiveAt,
        cancelAtPeriodEnd: provider.pendingPlanHandle ? false : provider.cancelAtPeriodEnd,
        currentPeriodEnd,
        nextReconcileAt: next,
        lastSyncedAt: now,
      },
    });
    if (updated.count > 0) {
      await this.scheduler.enqueue(shopId, existing.id, next, now);
    }
    return {
      billingPeriodId: existing.billingPeriodId,
      packMeterHandle: plan.shopifyRecoveryCreditPackEventHandle ?? null,
    };
  }
}

function providerCycleLagIsRetryable(input: SamePlanReconciliationInput): boolean {
  const { plan, existing } = input;
  return Boolean(
    existing.billingPeriodId
    && existing.currentPeriodStart
    && existing.currentPeriodEnd
    && (
      plan.kind === BillingPlanKind.PAID_METERED
      || (plan.kind === BillingPlanKind.FREE && plan.recoveryCreditPackEnabled === true)
    )
  );
}
