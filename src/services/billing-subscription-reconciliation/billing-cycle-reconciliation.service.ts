import {
  BillingPlanKind,
  SubscriptionProjectionStatus,
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS } from "@modainteract/moda-interact-shared/billing";
import type { PartnerSubscription } from "../../providers/shopify-partner-billing.provider.js";
import type { BackgroundRuntimeConfigSnapshot } from "../../runtime/background-runtime-config.js";
import { recoveryCapacityResumeService } from "../recovery-capacity-resume.service.js";
import { shopifyUsageEventPublisherService } from "../shopify-usage-event-publisher.service.js";
import { SamePlanBillingPeriodRolloverService } from "../same-plan-billing-period-rollover.service.js";
import { ensureCurrentBillingPeriodProjection } from "../current-billing-period-projection.service.js";
import { lockSubscription } from "./locking.js";
import type { FreeCycleExpected, RolloverExpected } from "./classification.js";
import { FREE_CYCLE_DISCOVERY_RETRY_MS, ROLLOVER_RETRY_MS } from "./reconciliation-timing.js";

type ReconciliationQueuePublisher = {
  publishNext(shopId: string, subscriptionId: string, next: Date): Promise<void>;
};

type UsageEventPublisher = {
  publishDue(options: { billingPeriodId: string; runtimeConfig: BackgroundRuntimeConfigSnapshot }): Promise<unknown>;
};

type CapacityResumeScheduler = {
  schedule(input: { shopId: string; trigger: "billing-period-rollover" }): Promise<unknown>;
};

type CyclePlan = {
  id: string;
  active: boolean;
  name: string;
  kind: BillingPlanKind;
  shopifyPlanHandle: string;
  recoveryCreditPackEnabled: boolean;
  shopifyUsageEventHandle: string | null;
  shopifyRecoveryCreditPackEventHandle: string | null;
  includedRecoveryConversationAllowance: number | null;
};

export type BillingCycleReconciliationInput = {
  shopId: string;
  kind: "cycle-discovery" | "rollover";
  expected: RolloverExpected;
  provider: PartnerSubscription | null;
  plan: CyclePlan;
  runtimeConfig: BackgroundRuntimeConfigSnapshot;
  subscription: {
    planId: string | null;
    billingPeriodId: string | null;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
    lastSyncErrorCode: string | null;
  };
};

export class BillingCycleReconciliationService {
  constructor(
    private readonly database: PrismaClient,
    private readonly reconciliationQueue: ReconciliationQueuePublisher,
    private readonly logger: StructuredLogger,
    private readonly now: () => Date,
    private readonly usagePublisher: UsageEventPublisher = shopifyUsageEventPublisherService,
    private readonly capacityResumeScheduler: CapacityResumeScheduler = recoveryCapacityResumeService,
  ) {}

  async recordProviderFailure(
    shopId: string,
    kind: "cycle-discovery" | "rollover",
    expected: RolloverExpected,
    error: unknown,
  ): Promise<void> {
    if (kind === "cycle-discovery") {
      await this.recordCycleDiscoveryFailure(shopId, expected, error);
    } else {
      await this.recordRolloverRetry(shopId, expected, error);
    }
  }

  async reconcileAccepted(input: BillingCycleReconciliationInput): Promise<void> {
    const { shopId, kind, expected, provider, plan, runtimeConfig, subscription } = input;

    if (kind === "rollover" && provider && this.isSameCurrentCycleWithProviderChange(provider, plan, subscription)) {
      await this.reconcileCurrentCycleProviderTruth(input, provider);
      return;
    }

    if (kind === "rollover" && subscription.currentPeriodEnd) {
      const now = this.now();
      const preCloseAt = new Date(subscription.currentPeriodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS);
      if (now < subscription.currentPeriodEnd) {
        await this.reconcilePreClose(shopId, expected, preCloseAt, runtimeConfig);
        return;
      }
    }

    if (!provider) {
      if (kind === "cycle-discovery") {
        await this.recordMissingCycle(shopId, expected);
      } else {
        await this.recordRolloverRetry(shopId, expected);
      }
      return;
    }

    if (kind === "cycle-discovery") {
      await this.reconcileFreeCycle(shopId, expected, provider, plan);
    } else {
      await this.reconcileRollover(shopId, expected, provider, plan);
    }
  }

  private isSameCurrentCycleWithProviderChange(
    provider: PartnerSubscription,
    plan: CyclePlan,
    subscription: BillingCycleReconciliationInput["subscription"],
  ): boolean {
    return (provider.pendingPlanHandle !== null || provider.cancelAtPeriodEnd || subscription.cancelAtPeriodEnd)
      && provider.planHandle === plan.shopifyPlanHandle
      && provider.currentPeriodStart?.getTime() === subscription.currentPeriodStart?.getTime()
      && provider.currentPeriodEnd?.getTime() === subscription.currentPeriodEnd?.getTime()
      && provider.currentPeriodEnd !== null
      && provider.currentPeriodEnd > this.now();
  }

  private async reconcileCurrentCycleProviderTruth(
    input: BillingCycleReconciliationInput,
    provider: PartnerSubscription,
  ): Promise<void> {
    const { shopId, expected, runtimeConfig, subscription } = input;
    const pendingPlan = provider.pendingPlanHandle
      ? await this.database.billingPlan.findUnique({
          where: { shopifyPlanHandle: provider.pendingPlanHandle },
          select: { id: true, active: true },
        })
      : null;
    const periodEnd = provider.currentPeriodEnd!;
    const preCloseAt = new Date(periodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS);
    const next = this.now() < preCloseAt ? preCloseAt : periodEnd;
    if (this.now() >= preCloseAt && this.now() < periodEnd) {
      try {
        await this.usagePublisher.publishDue({ billingPeriodId: subscription.billingPeriodId!, runtimeConfig });
      } catch {
        const retryAt = new Date(Math.min(this.now().getTime() + ROLLOVER_RETRY_MS, periodEnd.getTime()));
        const failed = await this.database.subscription.updateMany({
          where: {
            id: expected.subscriptionId,
            planId: subscription.planId,
            billingPeriodId: subscription.billingPeriodId,
            nextReconcileAt: expected.nextReconcileAt,
          },
          data: {
            pendingShopifyPlanHandle: provider.pendingPlanHandle,
            pendingPlanId: pendingPlan?.active ? pendingPlan.id : null,
            pendingEffectiveAt: provider.pendingEffectiveAt,
            cancelAtPeriodEnd: provider.pendingPlanHandle ? false : provider.cancelAtPeriodEnd,
            currentPeriodEnd: periodEnd,
            nextReconcileAt: retryAt,
            lastSyncedAt: this.now(),
            lastSyncErrorCode: "PRE_CLOSE_USAGE_FLUSH_FAILED",
            lastSyncErrorAt: this.now(),
          },
        });
        if (failed.count > 0) await this.reconciliationQueue.publishNext(shopId, expected.subscriptionId, retryAt);
        return;
      }
    }

    const updated = await this.database.subscription.updateMany({
      where: {
        id: expected.subscriptionId,
        planId: subscription.planId,
        billingPeriodId: subscription.billingPeriodId,
        nextReconcileAt: expected.nextReconcileAt,
      },
      data: {
        pendingShopifyPlanHandle: provider.pendingPlanHandle,
        pendingPlanId: pendingPlan?.active ? pendingPlan.id : null,
        pendingEffectiveAt: provider.pendingEffectiveAt,
        cancelAtPeriodEnd: provider.pendingPlanHandle ? false : provider.cancelAtPeriodEnd,
        currentPeriodEnd: periodEnd,
        nextReconcileAt: next,
        lastSyncedAt: this.now(),
        ...(this.now() >= preCloseAt && subscription.lastSyncErrorCode === "PRE_CLOSE_USAGE_FLUSH_FAILED"
          ? { lastSyncErrorCode: null, lastSyncErrorAt: null }
          : {}),
      },
    });
    if (updated.count > 0 && next) await this.reconciliationQueue.publishNext(shopId, expected.subscriptionId, next);
  }

  private async recordMissingCycle(shopId: string, expected: FreeCycleExpected | RolloverExpected): Promise<void> {
    const next = new Date(this.now().getTime() + FREE_CYCLE_DISCOVERY_RETRY_MS);
    const result = await this.database.subscription.updateMany({
      where: {
        id: expected.subscriptionId,
        status: { in: [SubscriptionProjectionStatus.ACTIVE, SubscriptionProjectionStatus.TRIALING] },
        planId: expected.currentPlanId,
        billingPeriodId: null,
        pendingPlanId: null,
        pendingShopifyPlanHandle: null,
        pendingEffectiveAt: null,
        nextReconcileAt: expected.nextReconcileAt,
      },
      data: { nextReconcileAt: next, lastSyncedAt: this.now(), lastSyncErrorCode: null, lastSyncErrorAt: null },
    });
    if (result.count > 0) await this.reconciliationQueue.publishNext(shopId, expected.subscriptionId, next);
  }

  private async recordCycleDiscoveryFailure(shopId: string, expected: FreeCycleExpected | RolloverExpected, error: unknown): Promise<void> {
    const next = new Date(this.now().getTime() + FREE_CYCLE_DISCOVERY_RETRY_MS);
    this.logger.error("billing.subscription_reconciliation.provider_failed", {
      shopId,
      subscriptionId: expected.subscriptionId,
      errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure",
    });
    const result = await this.database.subscription.updateMany({
      where: {
        id: expected.subscriptionId,
        status: { in: [SubscriptionProjectionStatus.ACTIVE, SubscriptionProjectionStatus.TRIALING] },
        planId: expected.currentPlanId,
        billingPeriodId: null,
        pendingPlanId: null,
        pendingShopifyPlanHandle: null,
        pendingEffectiveAt: null,
        nextReconcileAt: expected.nextReconcileAt,
      },
      data: { nextReconcileAt: next, lastSyncErrorCode: "PARTNER_API_ERROR", lastSyncErrorAt: this.now() },
    });
    if (result.count > 0) await this.reconciliationQueue.publishNext(shopId, expected.subscriptionId, next);
  }

  private async reconcileRollover(
    shopId: string,
    expected: RolloverExpected,
    provider: PartnerSubscription,
    plan: CyclePlan,
  ): Promise<void> {
    try {
      const result = await new SamePlanBillingPeriodRolloverService(this.database, async (rolloverInput, transitionResult) => {
        if (transitionResult.planKind !== BillingPlanKind.PAID_METERED) return;
        try {
          await this.capacityResumeScheduler.schedule({ shopId: rolloverInput.shopId, trigger: "billing-period-rollover" });
        } catch (error) {
          this.logger.warn("billing.recovery_capacity_resume.enqueue_failed", {
            shopId: rolloverInput.shopId,
            errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure",
          });
        }
      }).transition({ shopId, subscriptionId: expected.subscriptionId, provider, plan, now: this.now() });
      if (result.kind === "provider-cycle-lag") {
        await this.recordRolloverRetry(shopId, expected, undefined, "PROVIDER_CYCLE_LAG");
        return;
      }
      if (result.kind !== "not-applicable") {
        if (result.nextReconcileAt) await this.reconciliationQueue.publishNext(shopId, expected.subscriptionId, result.nextReconcileAt);
        return;
      }
    } catch (error) {
      this.logger.warn("billing.subscription_reconciliation.rollover_retry", {
        shopId,
        subscriptionId: expected.subscriptionId,
        errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure",
      });
      await this.recordRolloverRetry(shopId, expected, error);
      return;
    }
    await this.recordRolloverRetry(shopId, expected);
  }

  private async recordRolloverRetry(
    shopId: string,
    expected: RolloverExpected,
    error?: unknown,
    errorCode = "PARTNER_API_ERROR",
  ): Promise<void> {
    const now = this.now();
    const next = new Date(now.getTime() + ROLLOVER_RETRY_MS);
    const updated = await this.database.subscription.updateMany({
      where: {
        id: expected.subscriptionId,
        status: { in: [SubscriptionProjectionStatus.ACTIVE, SubscriptionProjectionStatus.TRIALING] },
        planId: expected.currentPlanId,
        billingPeriodId: expected.billingPeriodId,
        currentPeriodStart: expected.currentPeriodStart,
        currentPeriodEnd: expected.currentPeriodEnd,
        nextReconcileAt: expected.nextReconcileAt,
      },
      data: {
        nextReconcileAt: next,
        lastSyncedAt: now,
        ...(error || errorCode === "PROVIDER_CYCLE_LAG"
          ? { lastSyncErrorCode: errorCode, lastSyncErrorAt: now }
          : {}),
      },
    });
    if (updated.count > 0) await this.reconciliationQueue.publishNext(shopId, expected.subscriptionId, next);
  }

  private async reconcilePreClose(
    shopId: string,
    expected: RolloverExpected,
    preCloseAt: Date,
    runtimeConfig: BackgroundRuntimeConfigSnapshot,
  ): Promise<void> {
    const now = this.now();
    const scheduled = await this.database.subscription.findUnique({
      where: { id: expected.subscriptionId },
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
    if (
      !scheduled
      || scheduled.id !== expected.subscriptionId
      || (scheduled.status !== SubscriptionProjectionStatus.ACTIVE && scheduled.status !== SubscriptionProjectionStatus.TRIALING)
      || scheduled.planId !== expected.currentPlanId
      || scheduled.billingPeriodId !== expected.billingPeriodId
      || scheduled.currentPeriodStart?.getTime() !== expected.currentPeriodStart.getTime()
      || scheduled.currentPeriodEnd?.getTime() !== expected.currentPeriodEnd.getTime()
      || scheduled.nextReconcileAt?.getTime() !== expected.nextReconcileAt.getTime()
    ) return;
    const periodEnd = expected.currentPeriodEnd;
    const next = now < preCloseAt ? preCloseAt : periodEnd;
    if (next.getTime() !== periodEnd.getTime()) {
      const updated = await this.database.subscription.updateMany({
        where: {
          id: expected.subscriptionId,
          status: { in: [SubscriptionProjectionStatus.ACTIVE, SubscriptionProjectionStatus.TRIALING] },
          planId: expected.currentPlanId,
          billingPeriodId: expected.billingPeriodId,
          currentPeriodStart: expected.currentPeriodStart,
          currentPeriodEnd: expected.currentPeriodEnd,
          nextReconcileAt: expected.nextReconcileAt,
        },
        data: { nextReconcileAt: next },
      });
      if (updated.count > 0) await this.reconciliationQueue.publishNext(shopId, expected.subscriptionId, next);
      return;
    }
    let flushFailed = false;
    try {
      await this.usagePublisher.publishDue({ billingPeriodId: expected.billingPeriodId, runtimeConfig });
    } catch (error) {
      flushFailed = true;
      this.logger.warn("billing.subscription_reconciliation.pre_close_publish_failed", {
        shopId,
        subscriptionId: expected.subscriptionId,
        errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure",
      });
    }
    if (flushFailed) {
      const retryAt = new Date(Math.min(now.getTime() + ROLLOVER_RETRY_MS, periodEnd.getTime()));
      const updated = await this.database.subscription.updateMany({
        where: {
          id: expected.subscriptionId,
          status: { in: [SubscriptionProjectionStatus.ACTIVE, SubscriptionProjectionStatus.TRIALING] },
          planId: expected.currentPlanId,
          billingPeriodId: expected.billingPeriodId,
          currentPeriodStart: expected.currentPeriodStart,
          currentPeriodEnd: expected.currentPeriodEnd,
          nextReconcileAt: expected.nextReconcileAt,
        },
        data: {
          nextReconcileAt: retryAt,
          lastSyncedAt: now,
          lastSyncErrorCode: "PRE_CLOSE_USAGE_FLUSH_FAILED",
          lastSyncErrorAt: now,
        },
      });
      if (updated.count > 0) await this.reconciliationQueue.publishNext(shopId, expected.subscriptionId, retryAt);
      return;
    }
    const updated = await this.database.subscription.updateMany({
      where: {
        id: expected.subscriptionId,
        status: { in: [SubscriptionProjectionStatus.ACTIVE, SubscriptionProjectionStatus.TRIALING] },
        planId: expected.currentPlanId,
        billingPeriodId: expected.billingPeriodId,
        currentPeriodStart: expected.currentPeriodStart,
        currentPeriodEnd: expected.currentPeriodEnd,
        nextReconcileAt: expected.nextReconcileAt,
      },
      data: { nextReconcileAt: periodEnd, lastSyncedAt: now, lastSyncErrorCode: null, lastSyncErrorAt: null },
    });
    if (updated.count > 0) await this.reconciliationQueue.publishNext(shopId, expected.subscriptionId, periodEnd);
  }

  private async reconcileFreeCycle(
    shopId: string,
    expected: FreeCycleExpected | RolloverExpected,
    provider: PartnerSubscription,
    plan: CyclePlan,
  ): Promise<void> {
    if (provider.planHandle !== plan.shopifyPlanHandle || !provider.currentPeriodStart || !provider.currentPeriodEnd) {
      await this.recordMissingCycle(shopId, expected);
      return;
    }
    const now = this.now();
    const periodStart = provider.currentPeriodStart;
    const periodEnd = provider.currentPeriodEnd;
    const next = new Date(Math.max(now.getTime(), provider.currentPeriodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS));
    const committed = await this.database.$transaction(async (transaction: Prisma.TransactionClient) => {
      await lockSubscription(transaction, expected.subscriptionId);
      const current = await transaction.subscription.findUnique({
        where: { id: expected.subscriptionId },
        select: { status: true, planId: true, billingPeriodId: true, pendingPlanId: true, pendingShopifyPlanHandle: true, pendingEffectiveAt: true, nextReconcileAt: true },
      });
      if (!current || (current.status !== SubscriptionProjectionStatus.ACTIVE && current.status !== SubscriptionProjectionStatus.TRIALING) || current.planId !== expected.currentPlanId || current.billingPeriodId !== null || current.pendingPlanId !== null || current.pendingShopifyPlanHandle !== null || current.pendingEffectiveAt !== null || current.nextReconcileAt?.toISOString() !== expected.nextReconcileAt.toISOString()) return { kind: "stale" as const };
      const billingPeriod = await ensureCurrentBillingPeriodProjection(transaction, {
        shopId,
        subscriptionId: expected.subscriptionId,
        periodStart,
        periodEnd,
        providerPlanHandle: provider.planHandle,
        plan,
      });
      if (billingPeriod.kind === "CONFLICT") {
        const nextReconcileAt = new Date(now.getTime() + ROLLOVER_RETRY_MS);
        await transaction.subscription.update({
          where: { id: expected.subscriptionId },
          data: { status: SubscriptionProjectionStatus.SYNC_ERROR, lastSyncedAt: now, lastSyncErrorCode: "BILLING_PERIOD_PLAN_CONFLICT", lastSyncErrorAt: now, nextReconcileAt },
        });
        return { kind: "conflict" as const, nextReconcileAt };
      }
      await transaction.subscription.update({
        where: { id: expected.subscriptionId },
        data: { billingPeriodId: billingPeriod.billingPeriodId, currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, providerSubscriptionId: provider.providerSubscriptionId, trialEndsAt: provider.trialEndsAt, cancelAtPeriodEnd: provider.cancelAtPeriodEnd, nextReconcileAt: next, lastSyncedAt: now, lastSyncErrorCode: null, lastSyncErrorAt: null },
      });
      return { kind: "committed" as const };
    });
    if (committed.kind === "conflict") await this.reconciliationQueue.publishNext(shopId, expected.subscriptionId, committed.nextReconcileAt);
    if (committed.kind === "committed") await this.reconciliationQueue.publishNext(shopId, expected.subscriptionId, next);
  }
}