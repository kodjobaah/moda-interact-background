import { BillingPeriodEntitlementCounterKind, BillingPeriodStatus, BillingPlanKind, SubscriptionProjectionStatus } from "@prisma/client";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";

import type { PartnerSubscription } from "../../providers/shopify-partner-billing.provider.js";
import { APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS } from "@modainteract/moda-interact-shared/billing";
import { ensureCurrentBillingPeriodProjection } from "../current-billing-period-projection.service.js";
import { lockShopSettings, lockSubscription } from "./locking.js";
import { sameDate, type InitialActivationExpected } from "./classification.js";
import { FREE_CYCLE_DISCOVERY_RETRY_MS, nextSubscriptionReconcileAt, ROLLOVER_RETRY_MS } from "./reconciliation-timing.js";
import type { InitialActivationPlan, OtherCurrentPlan } from "./types.js";

type ReconciliationQueuePublisher = {
  publishNext(shopId: string, subscriptionId: string, next: Date): Promise<void>;
};

type DiscountPublisher = {
  publishDiscountSync(shopId: string, reason: "SUBSCRIPTION_ACTIVATED"): Promise<void>;
};

export class InitialActivationReconciliationService {
  constructor(
    private readonly database: PrismaClient,
    private readonly reconciliationQueue: ReconciliationQueuePublisher,
    private readonly discountPublisher: DiscountPublisher,
    private readonly logger: StructuredLogger,
    private readonly now: () => Date,
  ) {}

  async recordMissingSubscription(shopId: string, expected: InitialActivationExpected): Promise<void> {
    const now = this.now();
    const next = expected.pendingEffectiveAt ? nextSubscriptionReconcileAt(expected.pendingEffectiveAt, now) : null;
    const updated = await this.casPendingUpdate(expected, {
      status: SubscriptionProjectionStatus.NO_CONTRACT,
      lastSyncedAt: now,
      lastSyncErrorCode: null,
      lastSyncErrorAt: null,
      ...(next ? { nextReconcileAt: next } : {
        pendingShopifyPlanHandle: null,
        pendingPlanId: null,
        pendingEffectiveAt: null,
        nextReconcileAt: null,
      }),
    });
    if (updated && next) await this.publishNext(shopId, expected.subscriptionId, next);
  }

  async recordProviderFailure(shopId: string, expected: InitialActivationExpected, error: unknown): Promise<void> {
    const now = this.now();
    const next = expected.pendingEffectiveAt ? nextSubscriptionReconcileAt(expected.pendingEffectiveAt, now) : null;
    this.logger.error("billing.subscription_reconciliation.provider_failed", {
      shopId,
      subscriptionId: expected.subscriptionId,
      errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure",
    });
    const updated = await this.casPendingUpdate(expected, {
        lastSyncErrorCode: "PARTNER_API_ERROR",
        lastSyncErrorAt: now,
        ...(next ? { nextReconcileAt: next } : { pendingShopifyPlanHandle: null, pendingPlanId: null, pendingEffectiveAt: null, nextReconcileAt: null }),
    });
    if (updated && next) await this.publishNext(shopId, expected.subscriptionId, next);
  }

  async completeVerifiedFree(
    shopId: string,
    subscriptionId: string,
    provider: PartnerSubscription,
    planId: string,
    recoveryCreditPackEnabled: boolean,
    expectedNextReconcileAt: string,
    planName: string,
    expected: InitialActivationExpected,
  ): Promise<void> {
    const now = this.now();
    const nextReconcileAt = recoveryCreditPackEnabled
      ? provider.currentPeriodEnd
        ? new Date(Math.max(now.getTime(), provider.currentPeriodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS))
        : new Date(now.getTime() + FREE_CYCLE_DISCOVERY_RETRY_MS)
      : null;
    if (!provider.currentPeriodStart || !provider.currentPeriodEnd) {
      const updated = await this.casPendingUpdate(expected, {
        lastSyncedAt: now,
        lastSyncErrorCode: "MISSING_BILLING_CYCLE",
        lastSyncErrorAt: now,
        nextReconcileAt,
      });
      if (updated && nextReconcileAt) await this.publishNext(shopId, subscriptionId, nextReconcileAt);
      return;
    }
    const committed = await this.database.$transaction(async (transaction: Prisma.TransactionClient) => {
      await lockShopSettings(transaction, shopId);
      await lockSubscription(transaction, subscriptionId);
      const current = await transaction.subscription.findUnique({
        where: { id: subscriptionId },
        select: { status: true, planId: true, pendingPlanId: true, pendingShopifyPlanHandle: true, pendingEffectiveAt: true, nextReconcileAt: true },
      });
      if (
        !current
        || current.status !== SubscriptionProjectionStatus.NO_CONTRACT
        || current.planId !== null
        || current.pendingPlanId !== expected.pendingPlanId
        || current.pendingShopifyPlanHandle !== expected.pendingShopifyPlanHandle
        || current.pendingEffectiveAt?.toISOString() !== expected.pendingEffectiveAt?.toISOString()
        || !sameDate(current.nextReconcileAt, expected.nextReconcileAt)
      ) return { kind: "stale" as const };

      const lifetimeCounter = await transaction.shopEntitlementCounter.findUnique({ where: { shopId_counter: { shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" } }, select: { id: true } });
      const policy = lifetimeCounter
        ? null
        : await transaction.platformBillingPolicy.findUnique({ where: { id: "default" }, select: { lifetimeFreeRecoveryAllowance: true } });
      if (!lifetimeCounter && !policy) throw new Error("PlatformBillingPolicy.default is required for first lifetime Free grant");
      const billingPeriod = await ensureCurrentBillingPeriodProjection(transaction, {
        shopId,
        subscriptionId,
        periodStart: provider.currentPeriodStart!,
        periodEnd: provider.currentPeriodEnd!,
        providerPlanHandle: provider.planHandle,
        plan: { id: planId, name: planName, kind: BillingPlanKind.FREE, shopifyPlanHandle: provider.planHandle, includedRecoveryConversationAllowance: null },
      });
      if (billingPeriod.kind === "CONFLICT") {
        const nextReconcileAt = new Date(now.getTime() + ROLLOVER_RETRY_MS);
        await transaction.subscription.update({ where: { id: subscriptionId }, data: { status: SubscriptionProjectionStatus.SYNC_ERROR, lastSyncErrorCode: "BILLING_PERIOD_PLAN_CONFLICT", lastSyncErrorAt: now, nextReconcileAt } });
        return { kind: "conflict" as const, nextReconcileAt };
      }
      await transaction.subscription.update({
        where: { id: subscriptionId },
        data: {
          planId,
          observedShopifyPlanHandle: provider.planHandle,
          status: provider.status === "TRIALING" ? SubscriptionProjectionStatus.TRIALING : SubscriptionProjectionStatus.ACTIVE,
          billingPeriodId: billingPeriod.billingPeriodId,
          currentPeriodStart: provider.currentPeriodStart,
          currentPeriodEnd: provider.currentPeriodEnd,
          trialEndsAt: provider.trialEndsAt,
          cancelAtPeriodEnd: provider.cancelAtPeriodEnd,
          providerSubscriptionId: provider.providerSubscriptionId,
          pendingShopifyPlanHandle: null,
          pendingPlanId: null,
          pendingEffectiveAt: null,
          nextReconcileAt,
          lastSyncedAt: now,
          lastSyncErrorCode: null,
          lastSyncErrorAt: null,
        },
      });
      await transaction.shopSettings.update({ where: { shopId }, data: { onboardingCompleted: true } });
      if (!lifetimeCounter) {
        if (!policy) throw new Error("PlatformBillingPolicy.default is required for first lifetime Free grant");
        await transaction.shopEntitlementCounter.upsert({
          where: { shopId_counter: { shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" } },
          update: {},
          create: { shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS", grantedQuantity: policy.lifetimeFreeRecoveryAllowance },
        });
      }
      return { kind: "committed" as const };
    });
    if (committed.kind === "conflict") await this.publishNext(shopId, subscriptionId, committed.nextReconcileAt);
    if (committed.kind === "committed") {
      await this.discountPublisher.publishDiscountSync(shopId, "SUBSCRIPTION_ACTIVATED");
      if (nextReconcileAt) await this.publishNext(shopId, subscriptionId, nextReconcileAt);
    }
  }

  async completeVerifiedPaid(
    shopId: string,
    subscriptionId: string,
    provider: PartnerSubscription,
    plan: InitialActivationPlan,
    expected: InitialActivationExpected,
  ): Promise<void> {
    const now = this.now();
    const allowance = plan.includedRecoveryConversationAllowance;
    const isValidAllowance = Number.isSafeInteger(allowance)
      && (allowance ?? -1) >= 0;
    const hasValidCycle = provider.currentPeriodStart !== null
      && provider.currentPeriodEnd !== null
      && provider.currentPeriodStart < provider.currentPeriodEnd;
    const hasMeter = Boolean(plan.shopifyUsageEventHandle && provider.usageEventHandles.includes(plan.shopifyUsageEventHandle));
    if (provider.status === "TRIALING" && provider.trialEndsAt && provider.trialEndsAt > now && !hasValidCycle) {
      await this.recordUnsupportedPaidTrial(shopId, expected);
      return;
    }
    if (!hasValidCycle || !isValidAllowance || !hasMeter) {
      await this.recordPaidActivationFailure(shopId, expected, !hasValidCycle ? "MISSING_BILLING_CYCLE" : !hasMeter ? "MISSING_USAGE_METER" : "INVALID_INCLUDED_ALLOWANCE");
      return;
    }

    const periodStart = provider.currentPeriodStart as Date;
    const periodEnd = provider.currentPeriodEnd as Date;
    const nextReconcileAt = new Date(Math.max(now.getTime(), periodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS));
    const expectedGrant = allowance as number;
    const committed = await this.database.$transaction(async (transaction: Prisma.TransactionClient) => {
      await lockShopSettings(transaction, shopId);
      await lockSubscription(transaction, subscriptionId);
      const current = await transaction.subscription.findUnique({
        where: { id: subscriptionId },
        select: { status: true, planId: true, pendingPlanId: true, pendingShopifyPlanHandle: true, pendingEffectiveAt: true, nextReconcileAt: true },
      });
      if (
        !current
        || current.status !== SubscriptionProjectionStatus.NO_CONTRACT
        || current.planId !== null
        || current.pendingPlanId !== expected.pendingPlanId
        || current.pendingShopifyPlanHandle !== expected.pendingShopifyPlanHandle
        || current.pendingEffectiveAt?.toISOString() !== expected.pendingEffectiveAt.toISOString()
        || !sameDate(current.nextReconcileAt, expected.nextReconcileAt)
      ) return false;

      const currentPlan = await transaction.billingPlan.findUnique({
        where: { id: current.pendingPlanId },
        select: { id: true, active: true, name: true, kind: true, shopifyPlanHandle: true, shopifyUsageEventHandle: true, includedRecoveryConversationAllowance: true },
      });
      const currentAllowance = currentPlan?.includedRecoveryConversationAllowance;
      const currentPlanValid = currentPlan?.id === expected.pendingPlanId
        && currentPlan.shopifyPlanHandle === expected.pendingShopifyPlanHandle
        && currentPlan.shopifyPlanHandle === provider.planHandle
        && currentPlan.active
        && currentPlan.kind === BillingPlanKind.PAID_METERED
        && currentPlan.shopifyUsageEventHandle !== null
        && provider.usageEventHandles.includes(currentPlan.shopifyUsageEventHandle)
        && currentAllowance === allowance
        && Number.isSafeInteger(currentAllowance)
        && (currentAllowance ?? -1) >= 0;
      if (!currentPlanValid) throw new Error("Initial paid activation found an incompatible pending plan");

      const existingPeriod = await transaction.billingPeriod.findUnique({
        where: { shopId_periodStart_periodEnd: { shopId, periodStart, periodEnd } },
      });
      if (existingPeriod?.status === BillingPeriodStatus.CLOSED) {
        throw new Error("Initial paid activation cannot reopen a closed billing period");
      }
      if (existingPeriod && (
        existingPeriod.subscriptionId !== subscriptionId
        || existingPeriod.planId !== currentPlan.id
        || existingPeriod.shopifyPlanHandleSnapshot !== provider.planHandle
        || existingPeriod.planNameSnapshot !== currentPlan.name
        || existingPeriod.planKindSnapshot !== BillingPlanKind.PAID_METERED
        || existingPeriod.includedRecoveryCreditsGranted !== currentAllowance
      )) {
        throw new Error("Initial paid activation found an incompatible billing period");
      }
      const billingPeriod = existingPeriod ?? await transaction.billingPeriod.create({
        data: {
          shopId,
          subscriptionId,
          planId: currentPlan.id,
          shopifyPlanHandleSnapshot: provider.planHandle,
          planNameSnapshot: currentPlan.name,
          planKindSnapshot: BillingPlanKind.PAID_METERED,
          includedRecoveryCreditsGranted: currentAllowance as number,
          periodStart,
          periodEnd,
          status: BillingPeriodStatus.OPEN,
        },
      });
      const existingCounter = await transaction.billingPeriodEntitlementCounter.findUnique({
        where: {
          billingPeriodId_counter: {
            billingPeriodId: billingPeriod.id,
            counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
          },
        },
      });
      if (existingCounter && (
        existingCounter.grantedQuantity !== currentAllowance
        || existingCounter.shopId !== shopId
      )) {
        throw new Error("Initial paid activation found an incompatible included-credit counter");
      }
      await transaction.billingPeriodEntitlementCounter.upsert({
        where: {
          billingPeriodId_counter: {
            billingPeriodId: billingPeriod.id,
            counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
          },
        },
        update: {},
        create: {
          shopId,
          billingPeriodId: billingPeriod.id,
          counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
          grantedQuantity: currentAllowance as number,
          committedQuantity: 0,
          reservedQuantity: 0,
          forfeitedQuantity: 0,
        },
      });
      const lifetimeCounter = await transaction.shopEntitlementCounter.findUnique({
        where: { shopId_counter: { shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" } },
      });
      if (!lifetimeCounter) {
        const policy = await transaction.platformBillingPolicy.findUnique({ where: { id: "default" }, select: { lifetimeFreeRecoveryAllowance: true } });
        if (!policy) throw new Error("PlatformBillingPolicy.default is required for first lifetime Free grant");
        await transaction.shopEntitlementCounter.create({
          data: { shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS", grantedQuantity: policy.lifetimeFreeRecoveryAllowance },
        });
      }
      await transaction.subscription.update({
        where: { id: subscriptionId },
        data: {
          planId: currentPlan.id,
          observedShopifyPlanHandle: provider.planHandle,
          status: SubscriptionProjectionStatus.ACTIVE,
          billingPeriodId: billingPeriod.id,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          trialEndsAt: provider.trialEndsAt,
          cancelAtPeriodEnd: provider.cancelAtPeriodEnd,
          providerSubscriptionId: provider.providerSubscriptionId,
          pendingShopifyPlanHandle: null,
          pendingPlanId: null,
          pendingEffectiveAt: null,
          nextReconcileAt,
          lastSyncedAt: now,
          lastSyncErrorCode: null,
          lastSyncErrorAt: null,
        },
      });
      await transaction.shopSettings.update({ where: { shopId }, data: { onboardingCompleted: true } });
      return true;
    });
    if (committed) {
      await this.discountPublisher.publishDiscountSync(shopId, "SUBSCRIPTION_ACTIVATED");
      await this.publishNext(shopId, subscriptionId, nextReconcileAt);
    }
  }

  async recordPaidActivationFailure(
    shopId: string,
    expected: InitialActivationExpected,
    errorCode: "MISSING_BILLING_CYCLE" | "MISSING_USAGE_METER" | "INVALID_INCLUDED_ALLOWANCE" | "PENDING_PLAN_HANDLE_MISMATCH",
  ): Promise<void> {
    const now = this.now();
    const next = nextSubscriptionReconcileAt(expected.pendingEffectiveAt, now);
    const updated = await this.casPendingUpdate(expected, {
      lastSyncedAt: now,
      lastSyncErrorCode: errorCode,
      lastSyncErrorAt: now,
      ...(next ? { nextReconcileAt: next } : { nextReconcileAt: null }),
    });
    if (updated && next) await this.publishNext(shopId, expected.subscriptionId, next);
  }

  async applyOtherCurrentPlan(
    shopId: string,
    subscriptionId: string,
    provider: PartnerSubscription,
    plan: OtherCurrentPlan | null,
    pendingShopifyPlanHandle: string,
    expectedNextReconcileAt: string,
    expected: InitialActivationExpected,
  ): Promise<void> {
    const now = this.now();
    const planUsable = Boolean(plan?.active);
    const meterUsable = plan?.kind !== BillingPlanKind.PAID_METERED
      || Boolean(plan.shopifyUsageEventHandle && provider.usageEventHandles.includes(plan.shopifyUsageEventHandle));
    const hasValidProviderCycle = provider.currentPeriodStart !== null
      && provider.currentPeriodEnd !== null
      && provider.currentPeriodStart < provider.currentPeriodEnd;
    const status = !planUsable
      ? SubscriptionProjectionStatus.UNMAPPED
      : !meterUsable
        ? SubscriptionProjectionStatus.SYNC_ERROR
        : provider.status === "TRIALING" ? SubscriptionProjectionStatus.TRIALING : SubscriptionProjectionStatus.ACTIVE;
    if (planUsable && meterUsable && !hasValidProviderCycle) {
      const nextReconcileAt = new Date(now.getTime() + ROLLOVER_RETRY_MS);
      const updated = await this.casPendingUpdate(expected, {
        lastSyncedAt: now,
        lastSyncErrorCode: "MISSING_BILLING_CYCLE",
        lastSyncErrorAt: now,
        nextReconcileAt,
      });
      if (updated) await this.publishNext(shopId, subscriptionId, nextReconcileAt);
      return;
    }
    const committed = await this.database.$transaction(async (transaction: Prisma.TransactionClient) => {
      await lockShopSettings(transaction, shopId);
      await lockSubscription(transaction, subscriptionId);
      const current = await transaction.subscription.findUnique({ where: { id: subscriptionId }, select: { status: true, planId: true, pendingPlanId: true, pendingShopifyPlanHandle: true, pendingEffectiveAt: true, nextReconcileAt: true } });
      if (!current || current.status !== SubscriptionProjectionStatus.NO_CONTRACT || current.planId !== null || current.pendingPlanId !== expected.pendingPlanId || current.pendingShopifyPlanHandle !== expected.pendingShopifyPlanHandle || current.pendingEffectiveAt?.toISOString() !== expected.pendingEffectiveAt.toISOString() || !sameDate(current.nextReconcileAt, expected.nextReconcileAt)) return { kind: "stale" as const };
      const billingPeriod = planUsable && meterUsable && plan && provider.currentPeriodStart && provider.currentPeriodEnd
        ? await ensureCurrentBillingPeriodProjection(transaction, {
            shopId,
            subscriptionId,
            periodStart: provider.currentPeriodStart,
            periodEnd: provider.currentPeriodEnd,
            providerPlanHandle: provider.planHandle,
            plan,
          })
        : null;
      if (billingPeriod?.kind === "CONFLICT") {
        const nextReconcileAt = new Date(now.getTime() + ROLLOVER_RETRY_MS);
        await transaction.subscription.update({ where: { id: subscriptionId }, data: { status: SubscriptionProjectionStatus.SYNC_ERROR, lastSyncErrorCode: "BILLING_PERIOD_PLAN_CONFLICT", lastSyncErrorAt: now, lastSyncedAt: now, nextReconcileAt } });
        return { kind: "conflict" as const, nextReconcileAt };
      }
      const pendingPlan = provider.pendingPlanHandle
        ? await transaction.billingPlan.findUnique({ where: { shopifyPlanHandle: provider.pendingPlanHandle }, select: { id: true, active: true } })
        : null;
      await transaction.subscription.update({ where: { id: subscriptionId }, data: { planId: planUsable ? plan?.id ?? null : null, observedShopifyPlanHandle: provider.planHandle, status, billingPeriodId: billingPeriod?.kind === "READY" ? billingPeriod.billingPeriodId : null, currentPeriodStart: provider.currentPeriodStart, currentPeriodEnd: provider.currentPeriodEnd, trialEndsAt: provider.trialEndsAt, cancelAtPeriodEnd: provider.cancelAtPeriodEnd, providerSubscriptionId: provider.providerSubscriptionId, pendingShopifyPlanHandle: provider.pendingPlanHandle, pendingPlanId: pendingPlan?.active ? pendingPlan.id : null, pendingEffectiveAt: provider.pendingEffectiveAt, nextReconcileAt: null, lastSyncedAt: now, lastSyncErrorCode: status === SubscriptionProjectionStatus.UNMAPPED ? "UNMAPPED_PLAN_HANDLE" : status === SubscriptionProjectionStatus.SYNC_ERROR ? "MISSING_USAGE_METER" : null, lastSyncErrorAt: status === SubscriptionProjectionStatus.ACTIVE || status === SubscriptionProjectionStatus.TRIALING ? null : now } });
      return { kind: "committed" as const };
    });
    if (committed.kind === "conflict") await this.publishNext(shopId, subscriptionId, committed.nextReconcileAt);
  }

  private async recordUnsupportedPaidTrial(shopId: string, expected: InitialActivationExpected): Promise<void> {
    const now = this.now();
    const updated = await this.casPendingUpdate(expected, {
      lastSyncedAt: now,
      lastSyncErrorCode: "UNSUPPORTED_PAID_TRIAL",
      lastSyncErrorAt: now,
      nextReconcileAt: null,
    });
    if (updated) {
      this.logger.warn("billing.subscription_reconciliation.unsupported_paid_trial", {
        shopId,
        subscriptionId: expected.subscriptionId,
      });
    }
  }

  private async casPendingUpdate(
    expected: InitialActivationExpected,
    data: Prisma.SubscriptionUpdateManyMutationInput,
  ): Promise<boolean> {
    const result = await this.database.subscription.updateMany({
      where: {
        id: expected.subscriptionId,
        status: SubscriptionProjectionStatus.NO_CONTRACT,
        planId: null,
        pendingPlanId: expected.pendingPlanId,
        pendingShopifyPlanHandle: expected.pendingShopifyPlanHandle,
        pendingEffectiveAt: expected.pendingEffectiveAt,
        nextReconcileAt: expected.nextReconcileAt,
      },
      data,
    });
    return result.count > 0;
  }

  private async publishNext(shopId: string, subscriptionId: string, next: Date): Promise<void> {
    await this.reconciliationQueue.publishNext(shopId, subscriptionId, next);
  }
}