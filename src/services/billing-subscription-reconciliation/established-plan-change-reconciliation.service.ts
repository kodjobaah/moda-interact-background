import {
  APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS,
} from "@modainteract/moda-interact-shared/billing";
import { BillingPlanMaterializationService } from "../billing-plan-materialization.service.js";
import { BillingPlanKind, Prisma, SubscriptionProjectionStatus, type PrismaClient } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { PartnerSubscription } from "../../providers/shopify-partner-billing.provider.js";
import { recoveryCapacityResumeService } from "../recovery-capacity-resume.service.js";
import { ShopifyPlanChangeTransitionService, type ShopifyPlanChangePlan } from "../shopify-plan-change-transition.service.js";
import type { EstablishedPlanChangeExpected } from "./classification.js";
import { RETRYABLE_PLAN_CHANGE_SYNC_ERRORS } from "./classification.js";
import { ROLLOVER_RETRY_MS } from "./reconciliation-timing.js";
import { resolveShopifyUsageEventMapping } from "../billing-reconciliation/shopify-usage-event-mapping.js";
import { retireUnmappedCurrentPeriod } from "../billing-period-transition/retire-unmapped-current-period.js";

type ReconciliationQueuePublisher = {
  publishNext(shopId: string, subscriptionId: string, next: Date): Promise<void>;
  publishCommittedFailure?(shopId: string, subscriptionId: string): Promise<void>;
};

type CapacityResumeScheduler = Pick<typeof recoveryCapacityResumeService, "schedule">;

export class EstablishedPlanChangeReconciliationService {
  constructor(
    private readonly database: PrismaClient,
    private readonly reconciliationQueue: ReconciliationQueuePublisher,
    private readonly logger: StructuredLogger,
    private readonly now: () => Date,
    private readonly capacityResumeScheduler: CapacityResumeScheduler = recoveryCapacityResumeService,
  ) {}

  async reconcile(
    shopId: string,
    expected: EstablishedPlanChangeExpected,
    provider: PartnerSubscription,
    currentPlan: ShopifyPlanChangePlan,
    targetPlan: ShopifyPlanChangePlan | null,
  ): Promise<void> {
    const now = this.now();
    const providerIsCurrent = provider.planHandle === currentPlan.shopifyPlanHandle;
    const providerIsPendingTarget = targetPlan?.id === expected.pendingPlanId
      && targetPlan.shopifyPlanHandle === expected.pendingShopifyPlanHandle
      && provider.planHandle === expected.pendingShopifyPlanHandle;
    if (providerIsCurrent) {
      const pendingHandle = provider.pendingPlanHandle;
      const existingPending = pendingHandle
        ? await this.database.billingPlan.findUnique({ where: { shopifyPlanHandle: pendingHandle }, select: { id: true, active: true } })
        : null;
      const pendingPlan = existingPending ?? (pendingHandle
        ? await new BillingPlanMaterializationService(this.database, this.logger).materializeIfMissing(pendingHandle)
        : null);
      const next = pendingHandle && provider.pendingEffectiveAt
        ? provider.pendingEffectiveAt
        : this.nextPlanReconcileAt(currentPlan, expected.currentPeriodEnd, now);
      const data = {
        lastSyncedAt: now,
        lastSyncErrorCode: null,
        lastSyncErrorAt: null,
        nextReconcileAt: next,
        pendingShopifyPlanHandle: pendingHandle,
        pendingPlanId: pendingPlan?.active ? pendingPlan.id : null,
        pendingEffectiveAt: provider.pendingEffectiveAt,
      } as Prisma.SubscriptionUpdateManyMutationInput & { pendingPlanId?: string | null };
      const updated = await this.updateWithUsageEventMapping(expected, provider, data);
      if (updated > 0 && next) await this.reconciliationQueue.publishNext(shopId, expected.subscriptionId, next);
      return;
    }
    if (providerIsPendingTarget) {
      const sameCycle = expected.currentPeriodStart !== null
        && expected.currentPeriodEnd !== null
        && provider.currentPeriodStart?.getTime() === expected.currentPeriodStart.getTime()
        && provider.currentPeriodEnd?.getTime() === expected.currentPeriodEnd.getTime();
      if (sameCycle) {
        await this.recordFailure(shopId, expected, "UNEXPECTED_IMMEDIATE_PLAN_CHANGE", false, provider.planHandle, provider);
        return;
      }
      if (now < expected.pendingEffectiveAt) {
        const updated = await this.updateWithUsageEventMapping(expected, provider, {
          nextReconcileAt: expected.pendingEffectiveAt,
          lastSyncedAt: now,
          lastSyncErrorCode: null,
          lastSyncErrorAt: null,
        });
        if (updated > 0) await this.reconciliationQueue.publishNext(shopId, expected.subscriptionId, expected.pendingEffectiveAt);
        return;
      }
      if (!targetPlan) return;
      if (targetPlan.kind === BillingPlanKind.PAID_METERED || (targetPlan.kind === BillingPlanKind.FREE && targetPlan.recoveryCreditPackEnabled)) {
        if (!provider.currentPeriodStart || !provider.currentPeriodEnd || provider.currentPeriodStart >= provider.currentPeriodEnd) {
          await this.recordRetry(shopId, expected, "MISSING_BILLING_CYCLE", undefined, true, provider);
          return;
        }
      }
      if (targetPlan.kind === BillingPlanKind.PAID_METERED) {
        if (!Number.isSafeInteger(targetPlan.includedRecoveryConversationAllowance) || (targetPlan.includedRecoveryConversationAllowance ?? -1) < 0) {
          await this.recordRetry(shopId, expected, "INVALID_INCLUDED_ALLOWANCE", undefined, true, provider);
          return;
        }
      }
      if (targetPlan.recoveryCreditPackEnabled && (!targetPlan.shopifyRecoveryCreditPackEventHandle || !provider.usageEventHandles.includes(targetPlan.shopifyRecoveryCreditPackEventHandle))) {
        await this.recordRetry(shopId, expected, "MISSING_USAGE_METER", undefined, true, provider);
        return;
      }
      const result = await new ShopifyPlanChangeTransitionService(this.database).transition({
        shopId,
        subscriptionId: expected.subscriptionId,
        provider,
        plan: targetPlan,
        expectedCurrentPlanId: expected.currentPlanId,
        now,
      });
      if (result.kind === "transitioned") {
        if (result.nextReconcileAt) await this.reconciliationQueue.publishNext(shopId, expected.subscriptionId, result.nextReconcileAt);
        await this.schedulePlanChangeCapacityResume(shopId, result.planKind);
      } else {
        await this.recordFailure(shopId, expected, "UNEXPECTED_IMMEDIATE_PLAN_CHANGE", false, provider.planHandle, provider);
      }
      return;
    }
    if (!targetPlan) {
      await this.recordFailure(shopId, expected, "UNMAPPED_PLAN_HANDLE", true, provider.planHandle, provider);
      return;
    }
    await this.recordFailure(shopId, expected, "UNEXPECTED_IMMEDIATE_PLAN_CHANGE", false, provider.planHandle, provider);
  }

  private async updateWithUsageEventMapping(
    expected: EstablishedPlanChangeExpected,
    provider: PartnerSubscription | null,
    data: Prisma.SubscriptionUpdateManyMutationInput,
  ): Promise<number> {
    return this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`SELECT "id" FROM "billing"."Subscription" WHERE "id" = ${expected.subscriptionId} FOR UPDATE`);
      const mapping = provider
        ? await resolveShopifyUsageEventMapping(transaction, provider.planHandle, provider.usageEventHandles)
        : null;
      if (data.status === SubscriptionProjectionStatus.UNMAPPED) {
        // The subscription lock alone is insufficient: a stale scheduled job
        // must not close a period if its expected state no longer matches.
        const current = await transaction.subscription.findFirst({
          where: this.establishedPlanChangeWhere(expected),
          select: { id: true, billingPeriodId: true },
        });
        if (!current) return 0;
        await retireUnmappedCurrentPeriod(transaction, {
          subscriptionId: current.id, billingPeriodId: current.billingPeriodId, now: this.now(),
        });
      }
      const result = await transaction.subscription.updateMany({
        where: this.establishedPlanChangeWhere(expected),
        data: { ...data, ...(mapping ? { unmappedShopifyUsageEventHandles: mapping.unmappedProviderHandles } : {}) },
      });
      return result.count;
    });
  }

  private establishedPlanChangeWhere(expected: EstablishedPlanChangeExpected) {
    return {
      id: expected.subscriptionId,
      OR: [
        { status: { in: [SubscriptionProjectionStatus.ACTIVE, SubscriptionProjectionStatus.TRIALING] } },
        { status: SubscriptionProjectionStatus.SYNC_ERROR, lastSyncErrorCode: { in: [...RETRYABLE_PLAN_CHANGE_SYNC_ERRORS] } },
      ],
      planId: expected.currentPlanId,
      pendingPlanId: expected.pendingPlanId,
      pendingShopifyPlanHandle: expected.pendingShopifyPlanHandle,
      pendingEffectiveAt: expected.pendingEffectiveAt,
      nextReconcileAt: expected.nextReconcileAt,
    };
  }

  private nextPlanReconcileAt(plan: ShopifyPlanChangePlan, periodEnd: Date | null, now: Date): Date | null {
    if (plan.kind === BillingPlanKind.FREE && !plan.recoveryCreditPackEnabled) return null;
    return periodEnd ? new Date(Math.max(now.getTime(), periodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS)) : null;
  }

  async recordFailure(
    shopId: string,
    expected: EstablishedPlanChangeExpected,
    errorCode: "UNEXPECTED_IMMEDIATE_PLAN_CHANGE" | "UNMAPPED_PLAN_HANDLE",
    unmapped: boolean,
    observedHandle: string | undefined,
    provider: PartnerSubscription,
  ): Promise<void> {
    const now = this.now();
    const next = unmapped ? null : new Date(now.getTime() + ROLLOVER_RETRY_MS);
    const updated = await this.updateWithUsageEventMapping(expected, provider, {
      ...(unmapped ? {
        planId: null, billingPeriodId: null,
        currentPeriodStart: null, currentPeriodEnd: null,
        trialEndsAt: null, status: SubscriptionProjectionStatus.UNMAPPED,
      } : { status: SubscriptionProjectionStatus.SYNC_ERROR }),
      ...(observedHandle ? { observedShopifyPlanHandle: observedHandle } : {}),
      nextReconcileAt: next,
      lastSyncedAt: now,
      lastSyncErrorCode: unmapped ? null : errorCode,
      lastSyncErrorAt: unmapped ? null : now,
    });
    if (updated > 0) {
      if (next) await this.reconciliationQueue.publishNext(shopId, expected.subscriptionId, next);
      await this.reconciliationQueue.publishCommittedFailure?.(shopId, expected.subscriptionId);
    }
  }

  async recordRetry(
    shopId: string,
    expected: EstablishedPlanChangeExpected,
    errorCode: "PARTNER_API_ERROR" | "PROVIDER_STATE_UNRESOLVED" | "MISSING_BILLING_CYCLE" | "MISSING_USAGE_METER" | "INVALID_INCLUDED_ALLOWANCE",
    error?: unknown,
    failClosed = false,
    provider?: PartnerSubscription,
  ): Promise<void> {
    const now = this.now();
    const next = new Date(now.getTime() + ROLLOVER_RETRY_MS);
    if (error) {
      this.logger.error("billing.subscription_reconciliation.provider_failed", {
        shopId,
        subscriptionId: expected.subscriptionId,
        errorMessage: error instanceof Error ? error.message : "unknown failure",
        error: error,
      });
    }
    const updated = await this.updateWithUsageEventMapping(expected, provider ?? null, {
      ...(failClosed ? { status: SubscriptionProjectionStatus.SYNC_ERROR } : {}),
      nextReconcileAt: next,
      lastSyncedAt: now,
      lastSyncErrorCode: errorCode,
      lastSyncErrorAt: now,
    });
    if (updated > 0) {
      await this.reconciliationQueue.publishNext(shopId, expected.subscriptionId, next);
      await this.reconciliationQueue.publishCommittedFailure?.(shopId, expected.subscriptionId);
    }
  }

  private async schedulePlanChangeCapacityResume(shopId: string, planKind: BillingPlanKind): Promise<void> {
    if (planKind !== BillingPlanKind.PAID_METERED) return;
    try {
      await this.capacityResumeScheduler.schedule({ shopId, trigger: "plan-change" });
    } catch (error) {
      this.logger.warn("billing.recovery_capacity_resume.enqueue_failed", {
        shopId,
        errorMessage: error instanceof Error ? error.message : "unknown failure",
        error: error,
      });
    }
  }
}