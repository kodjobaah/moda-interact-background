import { vi } from "vitest";

import type { PartnerSubscription } from "../../../../src/providers/shopify-partner-billing.provider.js";
import type { GenericExistingSubscription } from "../../../../src/services/billing-reconciliation/generic-subscription-lock.js";
import type { ObservedBillingPlan } from "../../../../src/services/billing-reconciliation/observed-plan-projection.js";

export const now = new Date("2026-09-12T12:00:00.000Z");
export const cycleStart = new Date("2026-09-01T00:00:00.000Z");
export const cycleEnd = new Date("2026-10-01T00:00:00.000Z");

export const provider: PartnerSubscription = {
  planHandle: "paid-2026",
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

export const paidPlan: ObservedBillingPlan = {
  id: "plan-paid",
  active: true,
  name: "Paid",
  kind: "PAID_METERED",
  shopifyPlanHandle: "paid-2026",
  shopifyUsageEventHandle: "recovery-meter",
  shopifyRecoveryCreditPackEventHandle: "pack-meter",
  recoveryCreditPackEnabled: true,
  includedRecoveryConversationAllowance: 100,
};

export const freePlan: ObservedBillingPlan = {
  id: "plan-free",
  active: true,
  name: "Free",
  kind: "FREE",
  shopifyPlanHandle: "free-2026",
  shopifyUsageEventHandle: null,
  shopifyRecoveryCreditPackEventHandle: null,
  recoveryCreditPackEnabled: false,
  includedRecoveryConversationAllowance: null,
};

export function emptySubscription(
  overrides: Partial<GenericExistingSubscription> = {},
): GenericExistingSubscription {
  return {
    id: "subscription-1",
    status: "NO_CONTRACT",
    planId: null,
    pendingPlanId: null,
    pendingShopifyPlanHandle: null,
    pendingEffectiveAt: null,
    billingPeriodId: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    nextReconcileAt: null,
    ...overrides,
  };
}

export function transactionHarness(current: GenericExistingSubscription = emptySubscription()) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    subscription: {
      upsert: vi.fn().mockResolvedValue({ id: current.id }),
      findUnique: vi.fn().mockResolvedValue(current),
      update: vi.fn(),
    },
    billingPeriod: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "period-1" }),
      update: vi.fn(),
    },
    billingPeriodEntitlementCounter: {
      findUnique: vi.fn().mockResolvedValue(null),
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

export function serviceHarness(transaction = transactionHarness()) {
  const database = {
    billingPlan: { findUnique: vi.fn().mockResolvedValue(null) },
    subscription: { upsert: vi.fn() },
    $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)),
  };
  const scheduler = { enqueue: vi.fn().mockResolvedValue(undefined) };
  const logger = { warn: vi.fn(), error: vi.fn() };
  return { database, transaction, scheduler, logger };
}
