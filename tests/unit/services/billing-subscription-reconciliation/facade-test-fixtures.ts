import { expect, vi } from "vitest";
import { BillingSubscriptionReconciliationService, createSubscriptionReconcilePayload } from "../../../../src/services/billing-subscription-reconciliation.service.js";

export const now = new Date("2026-09-12T12:00:00.000Z");
export const pendingEffectiveAt = new Date("2026-09-12T11:00:00.000Z");
export const defaultRuntimeConfig = {
  billingFrozenRecheckSeconds: 3600,
  billingProviderRetrySeconds: 300,
  shopifyUsagePublishBatchSize: 50,
  shopifyUsageRetryBaseSeconds: 60,
  shopifyUsageRetryMaxSeconds: 3600,
} as const;

export function harness({
  row,
  providerResult = null,
  providerError,
  plan = null,
  policy = { lifetimeFreeRecoveryAllowance: 7 },
  lifetimeCounter = null,
  nowValue = now,
  runtimeConfig = defaultRuntimeConfig,
  runtimeConfigReader = { current: () => runtimeConfig },
} = {}) {
  const selectFields = (value: any, select: any): any => {
    if (!value || !select) return value;
    return Object.fromEntries(Object.entries(select).flatMap(([key, selection]) => {
      if (!selection) return [];
      if (selection === true) return [[key, value[key]]];
      return [[key, selectFields(value[key], (selection as any).select)]];
    }));
  };
  const subscriptionUpdate = vi.fn();
  const queue = { add: vi.fn().mockResolvedValue({}) };
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    billingPeriod: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: "period-1" }),
      create: vi.fn().mockResolvedValue({ id: "period-1" }),
      update: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(),
    },
    billingPeriodEntitlementCounter: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(), upsert: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(),
    },
    billingPlan: { findUnique: vi.fn().mockResolvedValue(plan) },
    subscription: {
      findUnique: vi.fn().mockResolvedValue({
        id: "subscription-1",
        status: "NO_CONTRACT",
        planId: null,
        pendingPlanId: "plan-free",
        pendingShopifyPlanHandle: "free-2026",
        pendingEffectiveAt,
        nextReconcileAt: new Date("2026-09-12T12:00:00.000Z"),
      }),
      update: vi.fn(),
    },
    shopSettings: { update: vi.fn() },
    shop: {
      findUnique: vi.fn(async ({ select }: any) => selectFields(row, select)),
      update: vi.fn(),
    },
    platformBillingPolicy: {
      findUnique: vi.fn().mockResolvedValue(policy),
    },
    shopEntitlementCounter: {
      findUnique: vi.fn().mockResolvedValue(lifetimeCounter),
      create: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(),
    },
    recoveryCreditPurchase: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    recoveryCreditRefund: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    promotionalCreditGrant: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    merchantPromotionSelection: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
  };
  const database = {
    shop: {
      findUnique: vi.fn(async ({ select }: any) => selectFields(row, select)),
      findMany: vi.fn().mockResolvedValue([]),
    },
    billingPlan: { findUnique: vi.fn().mockResolvedValue(plan) },
    subscription: {
      findUnique: vi.fn(),
      update: subscriptionUpdate,
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn(async (callback) => callback(transaction)),
  };
  const partner = {
    getActiveSubscription: vi.fn().mockImplementation(async () => {
      if (providerError) throw providerError;
      return providerResult;
    }),
    getSubscriptionReconciliationSnapshot: vi.fn().mockImplementation(async () => {
      return { activeSubscription: await partner.getActiveSubscription("gid://shopify/Shop/1"), latestLifecycleEvent: null };
    }),
  };
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  const service = new BillingSubscriptionReconciliationService(
    database as never,
    partner,
    queue,
    logger as never,
    () => nowValue,
    runtimeConfigReader,
  );
  return { database, partner, queue, logger, transaction, service, runtimeConfig, runtimeConfigReader };
}

export function pendingRow(overrides = {}) {
  return {
    id: "shop-1",
    status: "ACTIVE",
    shopifyShopId: "gid://shopify/Shop/1",
    onboardingCompleted: false,
    subscription: {
      id: "subscription-1",
      status: "NO_CONTRACT",
      planId: null,
      pendingPlanId: "plan-free",
      pendingShopifyPlanHandle: "free-2026",
      pendingEffectiveAt,
      nextReconcileAt: new Date("2026-09-12T12:00:00.000Z"),
      billingPeriodId: null,
    },
    ...overrides,
  };
}

export const freeProvider = {
  planHandle: "free-2026",
  usageEventHandles: [],
  pendingPlanHandle: null,
  pendingEffectiveAt: null,
  status: "ACTIVE" as const,
  currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
  currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
  trialEndsAt: null,
  cancelAtPeriodEnd: false,
  providerSubscriptionId: "sub-1",
  providerUsageSnapshot: [],
};

export const paidProvider = {
  ...freeProvider,
  planHandle: "paid-2026",
  usageEventHandles: ["recovery-meter"],
  providerSubscriptionId: "paid-sub-1",
};

export const paidPlan = {
  id: "plan-paid",
  active: true,
  name: "Paid",
  kind: "PAID_METERED",
  shopifyPlanHandle: "paid-2026",
  shopifyUsageEventHandle: "recovery-meter",
  recoveryCreditPackEnabled: false,
  shopifyRecoveryCreditPackEventHandle: null,
  includedRecoveryConversationAllowance: 100,
};

export const payload = createSubscriptionReconcilePayload(
  "shop-1",
  "subscription-1",
  new Date("2026-09-12T12:00:00.000Z"),
);

export function cycleRow(overrides = {}) {
  return pendingRow({
    onboardingCompleted: true,
    subscription: {
      id: "subscription-1",
      status: "ACTIVE",
      planId: "plan-free",
      pendingPlanId: null,
      pendingShopifyPlanHandle: null,
      pendingEffectiveAt: null,
      billingPeriodId: null,
      nextReconcileAt: new Date("2026-09-12T12:00:00.000Z"),
    },
    ...overrides,
  });
}

export const cyclePlan = {
  id: "plan-free",
  active: true,
  name: "Free",
  kind: "FREE",
  shopifyPlanHandle: "free-2026",
  recoveryCreditPackEnabled: true,
  shopifyUsageEventHandle: null,
};

export const establishedCurrentPlan = {
  id: "plan-current",
  active: true,
  name: "Current",
  kind: "PAID_METERED",
  shopifyPlanHandle: "paid-current",
  shopifyUsageEventHandle: "recovery-current",
  shopifyRecoveryCreditPackEventHandle: null,
  recoveryCreditPackEnabled: false,
  includedRecoveryConversationAllowance: 50,
};

export const establishedTargetPlan = {
  ...paidPlan,
  id: "plan-target",
  name: "Target",
  shopifyPlanHandle: "paid-2026",
};

export const establishedProvider = {
  ...paidProvider,
  planHandle: "paid-2026",
  currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"),
  currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z"),
};

export function establishedRow(overrides = {}) {
  return pendingRow({
    onboardingCompleted: true,
    subscription: {
      id: "subscription-1",
      status: "ACTIVE",
      planId: "plan-current",
      pendingPlanId: "plan-target",
      pendingShopifyPlanHandle: "paid-2026",
      pendingEffectiveAt,
      nextReconcileAt: now,
      billingPeriodId: "period-current",
      currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
      lastSyncErrorCode: null,
    },
    ...overrides,
  });
}

export function reinstallPaidRow(overrides = {}) {
  const { subscription: subscriptionOverrides, ...shopOverrides } = overrides as any;
  return pendingRow({
    status: "UNINSTALLED",
    reinstallPendingAt: new Date("2026-09-12T11:30:00.000Z"),
    subscription: {
      ...pendingRow().subscription,
      status: "ACTIVE",
      planId: "plan-paid",
      observedShopifyPlanHandle: "paid-2026",
      pendingPlanId: null,
      pendingShopifyPlanHandle: null,
      pendingEffectiveAt: null,
      billingPeriodId: "period-paid",
      currentPeriodStart: paidProvider.currentPeriodStart,
      currentPeriodEnd: paidProvider.currentPeriodEnd,
      ...subscriptionOverrides,
    },
    ...shopOverrides,
  });
}

export function configureReinstallPaidPeriod(test: ReturnType<typeof harness>, period: any, counter: any) {
  const current = {
    id: "subscription-1",
    planId: "plan-paid",
    observedShopifyPlanHandle: "paid-2026",
    billingPeriodId: "period-paid",
    currentPeriodStart: paidProvider.currentPeriodStart,
    currentPeriodEnd: paidProvider.currentPeriodEnd,
    nextReconcileAt: now,
  };
  test.database.subscription.findUnique.mockResolvedValue(current);
  test.transaction.subscription.findUnique.mockResolvedValue(current);
  test.transaction.billingPeriod = { findUnique: vi.fn().mockResolvedValue(period), create: vi.fn(), upsert: vi.fn() };
  test.transaction.billingPeriodEntitlementCounter = { findUnique: vi.fn().mockResolvedValue(counter), create: vi.fn(), upsert: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() };
}

export function expectNoModelMutations(model: any) {
  for (const method of [
    "create",
    "update",
    "updateMany",
    "upsert",
    "delete",
    "deleteMany",
  ]) {
    if (model?.[method]) {
      expect(model[method]).not.toHaveBeenCalled();
    }
  }
}
