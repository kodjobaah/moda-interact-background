import { vi } from "vitest";
import type { PartnerSubscription } from "../../../../src/providers/shopify-partner-billing.provider.js";
import type { SamePlanRolloverPlan } from "../../../../src/services/same-plan-billing-period-rollover.service.js";
import type { SamePlanExistingSubscription } from "../../../../src/services/billing-reconciliation/same-plan-reconciliation.types.js";

export const cycleStart = new Date("2026-09-01T00:00:00.000Z");
export const cycleEnd = new Date("2026-10-01T00:00:00.000Z");
export const now = new Date("2026-09-12T12:00:00.000Z");

export const provider: PartnerSubscription = {
  planHandle: "pro-2026",
  usageEventHandles: ["recovery-meter", "pack-meter"],
  pendingPlanHandle: null,
  pendingEffectiveAt: null,
  status: "ACTIVE",
  currentPeriodStart: cycleStart,
  currentPeriodEnd: cycleEnd,
  trialEndsAt: null,
  cancelAtPeriodEnd: false,
  providerSubscriptionId: "provider-subscription-1",
  providerUsageSnapshot: [],
  providerUsagePricingSnapshot: [],
};

export const paidPlan: SamePlanRolloverPlan = {
  id: "plan-paid",
  active: true,
  name: "Pro",
  kind: "PAID_METERED",
  shopifyPlanHandle: "pro-2026",
  includedRecoveryConversationAllowance: 100,
  recoveryCreditPackEnabled: true,
  shopifyUsageEventHandle: "recovery-meter",
  shopifyRecoveryCreditPackEventHandle: "pack-meter",
};

export const freePlan: SamePlanRolloverPlan = {
  id: "plan-free",
  active: true,
  name: "Free",
  kind: "FREE",
  shopifyPlanHandle: "free-2026",
  includedRecoveryConversationAllowance: null,
  recoveryCreditPackEnabled: false,
  shopifyUsageEventHandle: null,
  shopifyRecoveryCreditPackEventHandle: null,
};

export function existingSubscription(
  overrides: Partial<SamePlanExistingSubscription> = {},
): SamePlanExistingSubscription {
  return {
    id: "subscription-1",
    status: "ACTIVE",
    planId: "plan-paid",
    pendingPlanId: null,
    pendingShopifyPlanHandle: null,
    pendingEffectiveAt: null,
    billingPeriodId: "period-1",
    currentPeriodStart: cycleStart,
    currentPeriodEnd: cycleEnd,
    cancelAtPeriodEnd: false,
    nextReconcileAt: null,
    ...overrides,
  };
}

export function currentCycleTransaction(existing: SamePlanExistingSubscription) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    subscription: {
      findUnique: vi.fn().mockResolvedValue(existing),
      update: vi.fn(),
    },
    billingPeriod: {
      findUnique: vi.fn().mockResolvedValue({
        id: existing.billingPeriodId ?? "period-1",
        shopId: "shop-1",
        subscriptionId: existing.id,
        planId: existing.planId,
        shopifyPlanHandleSnapshot: "pro-2026",
        planNameSnapshot: "Pro",
        planKindSnapshot: "PAID_METERED",
        includedRecoveryCreditsGranted: 100,
        periodStart: cycleStart,
        periodEnd: cycleEnd,
        status: "OPEN",
      }),
      create: vi.fn().mockResolvedValue({ id: "period-1" }),
      update: vi.fn(),
    },
    billingPeriodEntitlementCounter: {
      findUnique: vi.fn().mockResolvedValue({
        shopId: "shop-1",
        billingPeriodId: existing.billingPeriodId ?? "period-1",
        grantedQuantity: 100,
        committedQuantity: 0,
        reservedQuantity: 0,
        forfeitedQuantity: 0,
      }),
      create: vi.fn(),
    },
    shopEntitlementCounter: {
      findUnique: vi.fn().mockResolvedValue({ id: "lifetime-1" }),
      upsert: vi.fn(),
    },
    usageEvent: { count: vi.fn().mockResolvedValue(0) },
    platformBillingPolicy: {
      findUnique: vi.fn().mockResolvedValue({ lifetimeFreeRecoveryAllowance: 5 }),
    },
  };
}

export function serviceDependencies() {
  return {
    scheduler: { enqueue: vi.fn().mockResolvedValue(undefined) },
    logger: { warn: vi.fn(), error: vi.fn() },
    capacityResume: { schedule: vi.fn().mockResolvedValue(undefined) },
  };
}
