import { describe, expect, it, vi } from "vitest";

import {
  BillingSubscriptionReconciliationService,
  createSubscriptionReconcilePayload,
  nextSubscriptionReconcileAt,
} from "../../../src/services/billing-subscription-reconciliation.service.js";
import { shopifyUsageEventPublisherService } from "../../../src/services/shopify-usage-event-publisher.service.js";
import { SamePlanBillingPeriodRolloverService } from "../../../src/services/same-plan-billing-period-rollover.service.js";

const now = new Date("2026-09-12T12:00:00.000Z");
const pendingEffectiveAt = new Date("2026-09-12T11:00:00.000Z");

function harness({
  row,
  providerResult = null,
  providerError,
  plan = null,
  policy = { lifetimeFreeRecoveryAllowance: 7 },
  lifetimeCounter = null,
  nowValue = now,
} = {}) {
  const subscriptionUpdate = vi.fn();
  const queue = { add: vi.fn().mockResolvedValue({}) };
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    billingPeriod: { upsert: vi.fn().mockResolvedValue({ id: "period-1" }) },
    billingPlan: { findUnique: vi.fn().mockResolvedValue(plan) },
    subscription: {
      findUnique: vi.fn().mockResolvedValue({
        status: "NO_CONTRACT",
        planId: null,
        pendingPlanId: "plan-free",
        pendingShopifyPlanHandle: "free-2026",
        pendingEffectiveAt,
        nextReconcileAt: new Date("2026-09-12T12:00:00.000Z"),
      }),
      update: vi.fn(),
    },
    shopSettings: {
      findUnique: vi.fn().mockResolvedValue({ onboardingCompleted: row?.settings?.onboardingCompleted ?? false }),
      update: vi.fn(),
    },
    platformBillingPolicy: {
      findUnique: vi.fn().mockResolvedValue(policy),
    },
    shopEntitlementCounter: {
      findUnique: vi.fn().mockResolvedValue(lifetimeCounter),
      create: vi.fn(),
      upsert: vi.fn(),
    },
  };
  const database = {
    shop: { findUnique: vi.fn().mockResolvedValue(row), findMany: vi.fn().mockResolvedValue([]) },
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
  };
  const logger = { error: vi.fn(), warn: vi.fn() };
  const service = new BillingSubscriptionReconciliationService(
    database as never,
    partner,
    queue,
    logger as never,
    () => nowValue,
  );
  return { database, partner, queue, logger, transaction, service };
}

function pendingRow(overrides = {}) {
  return {
    id: "shop-1",
    status: "ACTIVE",
    shopifyShopId: "gid://shopify/Shop/1",
    settings: { onboardingCompleted: false },
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

const freeProvider = {
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

const paidProvider = {
  ...freeProvider,
  planHandle: "paid-2026",
  usageEventHandles: ["recovery-meter"],
  providerSubscriptionId: "paid-sub-1",
};

const paidPlan = {
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

const payload = createSubscriptionReconcilePayload(
  "shop-1",
  "subscription-1",
  new Date("2026-09-12T12:00:00.000Z"),
);

function cycleRow(overrides = {}) {
  return pendingRow({
    settings: { onboardingCompleted: true },
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

const cyclePlan = {
  id: "plan-free",
  active: true,
  name: "Free",
  kind: "FREE",
  shopifyPlanHandle: "free-2026",
  recoveryCreditPackEnabled: true,
  shopifyUsageEventHandle: null,
};

describe("BillingSubscriptionReconciliationService", () => {
  it("uses tiered retry delays from pending activation age", () => {
    expect(nextSubscriptionReconcileAt(pendingEffectiveAt, now)).toEqual(
      new Date("2026-09-12T12:30:00.000Z"),
    );
    expect(nextSubscriptionReconcileAt(new Date("2026-09-12T11:30:00.000Z"), now)).toEqual(
      new Date("2026-09-12T12:05:00.000Z"),
    );
    expect(nextSubscriptionReconcileAt(new Date("2026-09-11T11:00:00.000Z"), now)).toBeNull();
  });

  it("ignores stale jobs after the durable schedule changes", async () => {
    const test = harness({ row: pendingRow() });
    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: "2026-09-12T12:01:00.000Z" });
    expect(test.partner.getActiveSubscription).not.toHaveBeenCalled();
  });

  it("ignores a job after its pending target has been cleared", async () => {
    const test = harness({ row: pendingRow({ subscription: { ...pendingRow().subscription, pendingPlanId: null, pendingShopifyPlanHandle: null } }) });
    await test.service.reconcileJob(payload);
    expect(test.partner.getActiveSubscription).not.toHaveBeenCalled();
  });

  it("ignores a queued job when unsupported-trial recovery cleared the durable schedule", async () => {
    const test = harness({ row: pendingRow({ subscription: { ...pendingRow().subscription, nextReconcileAt: null } }) });

    await test.service.reconcileJob(payload);

    expect(test.partner.getActiveSubscription).not.toHaveBeenCalled();
  });

  it("ignores jobs for an uninstalled shop", async () => {
    const test = harness({ row: pendingRow({ status: "UNINSTALLED" }) });
    await test.service.reconcileJob(payload);
    expect(test.partner.getActiveSubscription).not.toHaveBeenCalled();
  });

  it("keeps NO_CONTRACT pending intent and schedules the next retry on null provider truth", async () => {
    const test = harness({ row: pendingRow(), providerResult: null });
    await test.service.reconcileJob(payload);
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "NO_CONTRACT", nextReconcileAt: expect.any(Date) }),
    }));
    expect(test.database.subscription.updateMany.mock.calls[0][0].data).not.toHaveProperty("pendingPlanId");
    expect(test.queue.add).toHaveBeenCalled();
  });

  it("preserves initial NO_CONTRACT intent on transport failure and schedules the tiered retry", async () => {
    const test = harness({ row: pendingRow(), providerError: new Error("timeout") });
    await test.service.reconcileJob(payload);

    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "subscription-1",
        status: "NO_CONTRACT",
        planId: null,
        pendingPlanId: "plan-free",
        pendingShopifyPlanHandle: "free-2026",
        pendingEffectiveAt,
        nextReconcileAt: new Date("2026-09-12T12:00:00.000Z"),
      }),
      data: expect.objectContaining({
        lastSyncErrorCode: "PARTNER_API_ERROR",
        lastSyncErrorAt: now,
        nextReconcileAt: new Date("2026-09-12T12:30:00.000Z"),
      }),
    }));
    expect(test.database.subscription.updateMany.mock.calls[0][0].data).not.toHaveProperty("pendingPlanId");
    expect(test.database.subscription.updateMany.mock.calls[0][0].data).not.toHaveProperty("pendingShopifyPlanHandle");
    expect(test.database.subscription.updateMany.mock.calls[0][0].data).not.toHaveProperty("pendingEffectiveAt");
    expect(test.queue.add).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ expectedNextReconcileAt: "2026-09-12T12:30:00.000Z" }), expect.any(Object));
  });

  it("expires pending activation without enqueueing after 24 hours", async () => {
    const row = pendingRow({ subscription: { ...pendingRow().subscription, pendingEffectiveAt: new Date("2026-09-11T11:00:00.000Z") } });
    const test = harness({ row, providerResult: null });
    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: row.subscription.nextReconcileAt.toISOString() });
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ pendingPlanId: null, nextReconcileAt: null }),
    }));
    expect(test.queue.add).not.toHaveBeenCalled();
  });

  it("rejects an established current plan before calling Partner", async () => {
    const row = pendingRow({ subscription: { ...pendingRow().subscription, status: "ACTIVE", planId: "plan-paid" } });
    const test = harness({ row, providerError: new Error("timeout") });
    await test.service.reconcileJob(payload);
    expect(test.partner.getActiveSubscription).not.toHaveBeenCalled();
  });

  it("does not mutate or enqueue when the target changes during Partner verification", async () => {
    const test = harness({ row: pendingRow(), providerResult: null });
    test.database.subscription.updateMany.mockResolvedValue({ count: 0 });

    await test.service.reconcileJob(payload);

    expect(test.database.subscription.updateMany).toHaveBeenCalled();
    expect(test.queue.add).not.toHaveBeenCalled();
  });

  it("does not mutate or enqueue when the schedule changes during Partner verification", async () => {
    const test = harness({ row: pendingRow(), providerError: new Error("timeout") });
    test.database.subscription.updateMany.mockResolvedValue({ count: 0 });

    await test.service.reconcileJob(payload);

    expect(test.database.subscription.updateMany).toHaveBeenCalled();
    expect(test.queue.add).not.toHaveBeenCalled();
  });

  it("verifies Free activation transactionally and schedules the period drain", async () => {
    const test = harness({
      row: pendingRow(),
      providerResult: freeProvider,
      plan: { id: "plan-free", name: "Free", active: true, kind: "FREE", recoveryCreditPackEnabled: true },
    });
    await test.service.reconcileJob(payload);
    expect(test.transaction.billingPeriod.upsert).toHaveBeenCalled();
    expect(test.transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ planId: "plan-free", pendingPlanId: null, nextReconcileAt: new Date("2026-09-30T23:55:00.000Z") }),
    }));
    expect(test.transaction.shopEntitlementCounter.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: {},
      create: expect.objectContaining({
        shopId: "shop-1",
        counter: "LIFETIME_FREE_RECOVERY_CREDITS",
        grantedQuantity: 7,
      }),
    }));
    expect(test.queue.add).toHaveBeenCalled();
  });

  it("activates a matching paid target with a period snapshot, included counter, lifetime grant, and drain schedule", async () => {
    const test = harness({
      row: pendingRow({ subscription: { ...pendingRow().subscription, pendingPlanId: "plan-paid", pendingShopifyPlanHandle: "paid-2026" } }),
      providerResult: paidProvider,
      plan: paidPlan,
    });
    test.transaction.subscription.findUnique.mockResolvedValue({
      status: "NO_CONTRACT",
      planId: null,
      pendingPlanId: "plan-paid",
      pendingShopifyPlanHandle: "paid-2026",
      pendingEffectiveAt,
      nextReconcileAt: now,
    });
    test.transaction.billingPeriod = {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "period-paid" }),
      upsert: vi.fn(),
    };
    test.transaction.billingPeriodEntitlementCounter = {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
    };
    test.transaction.shopEntitlementCounter.create = vi.fn();

    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: now.toISOString() });

    expect(test.transaction.billingPeriod.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        shopId: "shop-1",
        subscriptionId: "subscription-1",
        planId: "plan-paid",
        shopifyPlanHandleSnapshot: "paid-2026",
        planNameSnapshot: "Paid",
        planKindSnapshot: "PAID_METERED",
        includedRecoveryCreditsGranted: 100,
        status: "OPEN",
      }),
    });
    expect(test.transaction.billingPeriodEntitlementCounter.upsert).toHaveBeenCalledWith({
      where: { billingPeriodId_counter: { billingPeriodId: "period-paid", counter: "INCLUDED_RECOVERY_CREDITS" } },
      update: {},
      create: expect.objectContaining({ grantedQuantity: 100, committedQuantity: 0, reservedQuantity: 0, forfeitedQuantity: 0 }),
    });
    expect(test.transaction.shopEntitlementCounter.create).toHaveBeenCalledWith({
      data: { shopId: "shop-1", counter: "LIFETIME_FREE_RECOVERY_CREDITS", grantedQuantity: 7 },
    });
    expect(test.transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ planId: "plan-paid", status: "ACTIVE", billingPeriodId: "period-paid", pendingPlanId: null, nextReconcileAt: new Date("2026-09-30T23:55:00.000Z") }),
    }));
    expect(test.transaction.shopSettings.update).toHaveBeenCalledWith({ where: { shopId: "shop-1" }, data: { onboardingCompleted: true } });
    expect(test.queue.add).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ expectedNextReconcileAt: "2026-09-30T23:55:00.000Z" }), expect.any(Object));
  });

  it("does not activate when the provider handle differs from the durable pending handle", async () => {
    const test = harness({
      row: pendingRow({ subscription: { ...pendingRow().subscription, pendingPlanId: "plan-paid", pendingShopifyPlanHandle: "paid-old" } }),
      providerResult: { ...paidProvider, planHandle: "paid-new" },
      plan: { ...paidPlan, shopifyPlanHandle: "paid-new" },
    });
    test.transaction.subscription.findUnique.mockResolvedValue({
      status: "NO_CONTRACT",
      planId: null,
      pendingPlanId: "plan-paid",
      pendingShopifyPlanHandle: "paid-old",
      pendingEffectiveAt,
      nextReconcileAt: now,
    });

    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: now.toISOString() });

    expect(test.partner.getActiveSubscription).toHaveBeenCalledOnce();
    expect(test.database.billingPlan.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { shopifyPlanHandle: "paid-new" },
    }));
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        lastSyncErrorCode: "PENDING_PLAN_HANDLE_MISMATCH",
        nextReconcileAt: new Date("2026-09-12T12:30:00.000Z"),
      }),
    }));
    expect(test.database.$transaction).not.toHaveBeenCalled();
    expect(test.transaction.subscription.update).not.toHaveBeenCalled();
    expect(test.transaction.shopSettings.update).not.toHaveBeenCalled();
    expect(test.transaction.billingPeriod.upsert).not.toHaveBeenCalled();
    expect(test.transaction.billingPeriodEntitlementCounter).toBeUndefined();
    expect(test.database.subscription.updateMany.mock.calls[0][0].data).not.toHaveProperty("pendingPlanId");
    expect(test.database.subscription.updateMany.mock.calls[0][0].data).not.toHaveProperty("pendingShopifyPlanHandle");
    expect(test.database.subscription.updateMany.mock.calls[0][0].data).not.toHaveProperty("pendingEffectiveAt");
    expect(test.queue.add).toHaveBeenCalledTimes(1);
    expect(test.queue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ expectedNextReconcileAt: "2026-09-12T12:30:00.000Z" }),
      expect.any(Object),
    );
  });

  it.each([
    ["inactive", { active: false }],
    ["changed handle", { shopifyPlanHandle: "paid-new" }],
    ["missing meter", { shopifyUsageEventHandle: null }],
    ["changed allowance", { includedRecoveryConversationAllowance: 101 }],
  ] as const)("revalidates the pending plan transactionally: %s", async (_label, mutation) => {
    const test = harness({
      row: pendingRow({ subscription: { ...pendingRow().subscription, pendingPlanId: "plan-paid", pendingShopifyPlanHandle: "paid-2026" } }),
      providerResult: paidProvider,
      plan: paidPlan,
    });
    test.transaction.subscription.findUnique.mockResolvedValue({ status: "NO_CONTRACT", planId: null, pendingPlanId: "plan-paid", pendingShopifyPlanHandle: "paid-2026", pendingEffectiveAt, nextReconcileAt: now });
    test.transaction.billingPlan.findUnique.mockResolvedValue({ ...paidPlan, ...mutation });

    await expect(test.service.reconcileJob({ ...payload, expectedNextReconcileAt: now.toISOString() })).rejects.toThrow(
      "Initial paid activation found an incompatible pending plan",
    );
    expect(test.transaction.subscription.update).not.toHaveBeenCalled();
    expect(test.transaction.shopSettings.update).not.toHaveBeenCalled();
  });

  it("replays a paid period and counter without resetting committed usage or the lifetime grant", async () => {
    const existingPeriod = {
      id: "period-paid",
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      planId: "plan-paid",
      shopifyPlanHandleSnapshot: "paid-2026",
      planNameSnapshot: "Paid",
      planKindSnapshot: "PAID_METERED",
      includedRecoveryCreditsGranted: 100,
      periodStart: paidProvider.currentPeriodStart,
      periodEnd: paidProvider.currentPeriodEnd,
      status: "OPEN",
    };
    const existingCounter = { id: "counter-paid", shopId: "shop-1", grantedQuantity: 100, committedQuantity: 12, reservedQuantity: 3, forfeitedQuantity: 1 };
    const lifetimeCounter = { id: "lifetime", grantedQuantity: 7, committedQuantity: 2, reservedQuantity: 1, refundingQuantity: 0, version: 4 };
    const test = harness({
      row: pendingRow({ subscription: { ...pendingRow().subscription, pendingPlanId: "plan-paid", pendingShopifyPlanHandle: "paid-2026" } }),
      providerResult: paidProvider,
      plan: paidPlan,
      lifetimeCounter,
    });
    test.transaction.subscription.findUnique.mockResolvedValue({ status: "NO_CONTRACT", planId: null, pendingPlanId: "plan-paid", pendingShopifyPlanHandle: "paid-2026", pendingEffectiveAt, nextReconcileAt: now });
    test.transaction.billingPeriod = { findUnique: vi.fn().mockResolvedValue(existingPeriod), create: vi.fn(), upsert: vi.fn() };
    test.transaction.billingPeriodEntitlementCounter = { findUnique: vi.fn().mockResolvedValue(existingCounter), upsert: vi.fn() };
    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: now.toISOString() });
    expect(test.transaction.billingPeriod.upsert).not.toHaveBeenCalled();
    expect(test.transaction.billingPeriodEntitlementCounter.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
    expect(test.transaction.billingPeriodEntitlementCounter.upsert.mock.calls[0][0].update).not.toHaveProperty("committedQuantity");
    expect(test.transaction.billingPeriodEntitlementCounter.upsert.mock.calls[0][0].update).not.toHaveProperty("reservedQuantity");
    expect(test.transaction.billingPeriodEntitlementCounter.upsert.mock.calls[0][0].update).not.toHaveProperty("forfeitedQuantity");
    expect(test.transaction.shopEntitlementCounter.create).not.toHaveBeenCalled();
    expect(existingCounter).toMatchObject({ committedQuantity: 12, reservedQuantity: 3, forfeitedQuantity: 1 });
    expect(lifetimeCounter).toMatchObject({ grantedQuantity: 7, committedQuantity: 2, reservedQuantity: 1 });
  });

  it("fails closed for a closed exact paid billing period", async () => {
    const test = harness({
      row: pendingRow({ subscription: { ...pendingRow().subscription, pendingPlanId: "plan-paid", pendingShopifyPlanHandle: "paid-2026" } }),
      providerResult: paidProvider,
      plan: paidPlan,
    });
    test.transaction.subscription.findUnique.mockResolvedValue({ status: "NO_CONTRACT", planId: null, pendingPlanId: "plan-paid", pendingShopifyPlanHandle: "paid-2026", pendingEffectiveAt, nextReconcileAt: now });
    test.transaction.billingPlan.findUnique.mockResolvedValue(paidPlan);
    test.transaction.billingPeriod = { findUnique: vi.fn().mockResolvedValue({ status: "CLOSED" }), create: vi.fn(), upsert: vi.fn() };
    test.transaction.billingPeriodEntitlementCounter = { findUnique: vi.fn(), upsert: vi.fn() };

    await expect(test.service.reconcileJob({ ...payload, expectedNextReconcileAt: now.toISOString() })).rejects.toThrow(
      "Initial paid activation cannot reopen a closed billing period",
    );
    expect(test.transaction.billingPeriod.create).not.toHaveBeenCalled();
    expect(test.transaction.billingPeriodEntitlementCounter.findUnique).not.toHaveBeenCalled();
    expect(test.transaction.subscription.update).not.toHaveBeenCalled();
    expect(test.transaction.shopSettings.update).not.toHaveBeenCalled();
  });

  it.each([
    ["subscriptionId", { subscriptionId: "other-subscription" }],
    ["planId", { planId: "other-plan" }],
    ["handle snapshot", { shopifyPlanHandleSnapshot: "paid-old" }],
    ["name snapshot", { planNameSnapshot: "Legacy Paid" }],
    ["kind snapshot", { planKindSnapshot: "FREE" }],
    ["grant snapshot", { includedRecoveryCreditsGranted: 99 }],
  ] as const)("fails closed for an incompatible paid period %s", async (_label, mutation) => {
    const test = harness({
      row: pendingRow({ subscription: { ...pendingRow().subscription, pendingPlanId: "plan-paid", pendingShopifyPlanHandle: "paid-2026" } }),
      providerResult: paidProvider,
      plan: paidPlan,
    });
    test.transaction.subscription.findUnique.mockResolvedValue({ status: "NO_CONTRACT", planId: null, pendingPlanId: "plan-paid", pendingShopifyPlanHandle: "paid-2026", pendingEffectiveAt, nextReconcileAt: now });
    test.transaction.billingPlan.findUnique.mockResolvedValue(paidPlan);
    test.transaction.billingPeriod = {
      findUnique: vi.fn().mockResolvedValue({
        status: "OPEN",
        subscriptionId: "subscription-1",
        planId: "plan-paid",
        shopifyPlanHandleSnapshot: "paid-2026",
        planNameSnapshot: "Paid",
        planKindSnapshot: "PAID_METERED",
        includedRecoveryCreditsGranted: 100,
        ...mutation,
        id: "period-paid",
      }),
      create: vi.fn(),
      upsert: vi.fn(),
    };
    test.transaction.billingPeriodEntitlementCounter = { findUnique: vi.fn(), upsert: vi.fn() };

    await expect(test.service.reconcileJob({ ...payload, expectedNextReconcileAt: now.toISOString() })).rejects.toThrow(
      "Initial paid activation found an incompatible billing period",
    );
    expect(test.transaction.billingPeriod.create).not.toHaveBeenCalled();
    expect(test.transaction.billingPeriodEntitlementCounter.findUnique).not.toHaveBeenCalled();
    expect(test.transaction.subscription.update).not.toHaveBeenCalled();
    expect(test.transaction.shopSettings.update).not.toHaveBeenCalled();
  });

  it("fails closed for a conflicting included-credit counter grant", async () => {
    const test = harness({
      row: pendingRow({ subscription: { ...pendingRow().subscription, pendingPlanId: "plan-paid", pendingShopifyPlanHandle: "paid-2026" } }),
      providerResult: paidProvider,
      plan: paidPlan,
    });
    test.transaction.subscription.findUnique.mockResolvedValue({ status: "NO_CONTRACT", planId: null, pendingPlanId: "plan-paid", pendingShopifyPlanHandle: "paid-2026", pendingEffectiveAt, nextReconcileAt: now });
    test.transaction.billingPlan.findUnique.mockResolvedValue(paidPlan);
    test.transaction.billingPeriod = {
      findUnique: vi.fn().mockResolvedValue({
        id: "period-paid",
        status: "OPEN",
        subscriptionId: "subscription-1",
        planId: "plan-paid",
        shopifyPlanHandleSnapshot: "paid-2026",
        planNameSnapshot: "Paid",
        planKindSnapshot: "PAID_METERED",
        includedRecoveryCreditsGranted: 100,
      }),
      create: vi.fn(),
      upsert: vi.fn(),
    };
    test.transaction.billingPeriodEntitlementCounter = {
      findUnique: vi.fn().mockResolvedValue({ shopId: "shop-1", grantedQuantity: 99, committedQuantity: 4, reservedQuantity: 2, forfeitedQuantity: 1 }),
      upsert: vi.fn(),
    };

    await expect(test.service.reconcileJob({ ...payload, expectedNextReconcileAt: now.toISOString() })).rejects.toThrow(
      "Initial paid activation found an incompatible included-credit counter",
    );
    expect(test.transaction.billingPeriodEntitlementCounter.upsert).not.toHaveBeenCalled();
    expect(test.transaction.subscription.update).not.toHaveBeenCalled();
    expect(test.transaction.shopSettings.update).not.toHaveBeenCalled();
  });

  it("repairs a missing Paid activation job after post-commit queue failure", async () => {
    const test = harness({
      row: pendingRow({ subscription: { ...pendingRow().subscription, pendingPlanId: "plan-paid", pendingShopifyPlanHandle: "paid-2026" } }),
      providerResult: paidProvider,
      plan: paidPlan,
    });
    test.transaction.subscription.findUnique.mockResolvedValue({ status: "NO_CONTRACT", planId: null, pendingPlanId: "plan-paid", pendingShopifyPlanHandle: "paid-2026", pendingEffectiveAt, nextReconcileAt: now });
    test.transaction.billingPeriod = { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "period-paid" }), upsert: vi.fn() };
    test.transaction.billingPeriodEntitlementCounter = { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() };
    test.transaction.shopEntitlementCounter.create = vi.fn();
    test.queue.add.mockRejectedValueOnce(new Error("Redis unavailable"));

    await expect(test.service.reconcileJob({ ...payload, expectedNextReconcileAt: now.toISOString() })).resolves.toBeUndefined();
    expect(test.transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "ACTIVE", billingPeriodId: "period-paid", currentPeriodStart: paidProvider.currentPeriodStart, currentPeriodEnd: paidProvider.currentPeriodEnd, nextReconcileAt: new Date("2026-09-30T23:55:00.000Z") }),
    }));
    expect(test.transaction.shopSettings.update).toHaveBeenCalledWith({ where: { shopId: "shop-1" }, data: { onboardingCompleted: true } });

    test.database.shop.findMany.mockResolvedValue([{
      id: "shop-1",
      subscription: { id: "subscription-1", nextReconcileAt: new Date("2026-09-30T23:55:00.000Z") },
    }]);
    await expect(test.service.reconstruct()).resolves.toBe(1);
    expect(test.partner.getActiveSubscription).toHaveBeenCalledOnce();
    expect(test.queue.add).toHaveBeenCalledTimes(2);
    expect(test.queue.add.mock.calls[1][1]).toEqual(expect.objectContaining({ expectedNextReconcileAt: "2026-09-30T23:55:00.000Z" }));
  });

  it("does not create paid access for a future paid trial without a billing cycle", async () => {
    const trialProvider = { ...paidProvider, status: "TRIALING" as const, trialEndsAt: new Date("2026-09-20T00:00:00.000Z"), currentPeriodStart: null, currentPeriodEnd: null };
    const test = harness({
      row: pendingRow({ subscription: { ...pendingRow().subscription, pendingPlanId: "plan-paid", pendingShopifyPlanHandle: "paid-2026" } }),
      providerResult: trialProvider,
      plan: paidPlan,
    });
    test.transaction.subscription.findUnique.mockResolvedValue({ status: "NO_CONTRACT", planId: null, pendingPlanId: "plan-paid", pendingShopifyPlanHandle: "paid-2026", pendingEffectiveAt, nextReconcileAt: now });
    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: now.toISOString() });
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastSyncErrorCode: "UNSUPPORTED_PAID_TRIAL", nextReconcileAt: null }) }));
    expect(test.transaction.billingPeriod.upsert).not.toHaveBeenCalled();
    expect(test.transaction.shopSettings.update).not.toHaveBeenCalled();
    expect(test.logger.warn).toHaveBeenCalledWith("billing.subscription_reconciliation.unsupported_paid_trial", expect.objectContaining({ shopId: "shop-1" }));
  });

  it.each([
    ["missing cycle", { currentPeriodStart: null, currentPeriodEnd: null }, "MISSING_BILLING_CYCLE"],
    ["invalid cycle", { currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z") }, "MISSING_BILLING_CYCLE"],
    ["missing meter", { usageEventHandles: [] }, "MISSING_USAGE_METER"],
    ["null allowance", { includedRecoveryConversationAllowance: null }, "INVALID_INCLUDED_ALLOWANCE"],
    ["negative allowance", { includedRecoveryConversationAllowance: -1 }, "INVALID_INCLUDED_ALLOWANCE"],
    ["non-integer allowance", { includedRecoveryConversationAllowance: 1.5 }, "INVALID_INCLUDED_ALLOWANCE"],
  ] as const)("fails closed for paid activation: %s", async (_label, providerOverrides, errorCode) => {
    const test = harness({
      row: pendingRow({ subscription: { ...pendingRow().subscription, pendingPlanId: "plan-paid", pendingShopifyPlanHandle: "paid-2026" } }),
      providerResult: { ...paidProvider, ...providerOverrides },
      plan: errorCode === "INVALID_INCLUDED_ALLOWANCE"
        ? { ...paidPlan, includedRecoveryConversationAllowance: providerOverrides.includedRecoveryConversationAllowance }
        : paidPlan,
    });
    test.transaction.subscription.findUnique.mockResolvedValue({ status: "NO_CONTRACT", planId: null, pendingPlanId: "plan-paid", pendingShopifyPlanHandle: "paid-2026", pendingEffectiveAt, nextReconcileAt: now });
    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: now.toISOString() });
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastSyncErrorCode: errorCode }) }));
    expect(test.transaction.shopSettings.update).not.toHaveBeenCalled();
  });

  it("locks ShopSettings before Subscription for verified Free completion", async () => {
    const test = harness({ row: pendingRow(), providerResult: freeProvider, plan: { id: "plan-free", name: "Free", active: true, kind: "FREE", recoveryCreditPackEnabled: false } });
    await test.service.reconcileJob(payload);
    expect(test.transaction.$queryRaw).toHaveBeenCalledTimes(2);
    expect(test.transaction.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(test.transaction.$queryRaw.mock.invocationCallOrder[1]);
  });

  it("does not commit or publish when the locked Free activation state is stale", async () => {
    const test = harness({
      row: pendingRow(),
      providerResult: freeProvider,
      plan: { id: "plan-free", name: "Free", active: true, kind: "FREE", recoveryCreditPackEnabled: true },
    });
    test.transaction.subscription.findUnique.mockResolvedValue({
      status: "NO_CONTRACT",
      planId: null,
      pendingPlanId: "plan-newer",
      pendingShopifyPlanHandle: "free-newer",
      pendingEffectiveAt,
      nextReconcileAt: new Date("2026-09-12T12:00:00.000Z"),
    });

    await test.service.reconcileJob(payload);

    expect(test.transaction.$queryRaw).toHaveBeenCalledTimes(2);
    expect(test.transaction.billingPeriod.upsert).not.toHaveBeenCalled();
    expect(test.transaction.shopEntitlementCounter.upsert).not.toHaveBeenCalled();
    expect(test.transaction.subscription.update).not.toHaveBeenCalled();
    expect(test.transaction.shopSettings.update).not.toHaveBeenCalled();
    expect(test.queue.add).not.toHaveBeenCalled();
  });

  it("replays an existing lifetime counter without requiring the policy", async () => {
    const test = harness({
      row: pendingRow(),
      providerResult: freeProvider,
      plan: { id: "plan-free", name: "Free", active: true, kind: "FREE", recoveryCreditPackEnabled: false },
      policy: null,
      lifetimeCounter: { id: "counter-1" },
    });

    await test.service.reconcileJob(payload);

    expect(test.transaction.platformBillingPolicy.findUnique).not.toHaveBeenCalled();
    expect(test.transaction.shopEntitlementCounter.upsert).not.toHaveBeenCalled();
    expect(test.transaction.subscription.update).toHaveBeenCalled();
  });

  it("applies another provider plan as authoritative current truth without activating the pending target", async () => {
    const test = harness({
      row: pendingRow(),
      providerResult: { ...freeProvider, planHandle: "paid-2026", usageEventHandles: ["recovery-meter"] },
      plan: { id: "plan-paid", name: "Paid", active: true, kind: "PAID_METERED", shopifyUsageEventHandle: "recovery-meter", recoveryCreditPackEnabled: false },
    });
    await test.service.reconcileJob(payload);
    expect(test.transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ planId: "plan-paid", status: "ACTIVE", pendingPlanId: null }),
    }));
  });

  it("locks ShopSettings before Subscription for another current plan", async () => {
    const test = harness({
      row: pendingRow(),
      providerResult: { ...freeProvider, planHandle: "paid-2026" },
      plan: { id: "plan-paid", name: "Paid", active: true, kind: "PAID_METERED", shopifyUsageEventHandle: "recovery-meter", recoveryCreditPackEnabled: false },
    });
    await test.service.reconcileJob(payload);
    expect(test.transaction.$queryRaw).toHaveBeenCalledTimes(2);
    expect(test.transaction.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(test.transaction.$queryRaw.mock.invocationCallOrder[1]);
  });

  it("creates the full Free period snapshot without an included-credit counter", async () => {
    const test = harness({
      row: pendingRow(),
      providerResult: freeProvider,
      plan: { id: "plan-free", name: "Free", active: true, kind: "FREE", recoveryCreditPackEnabled: false },
    });
    await test.service.reconcileJob(payload);
    expect(test.transaction.billingPeriod.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ planId: "plan-free", shopifyPlanHandleSnapshot: "free-2026", planNameSnapshot: "Free", planKindSnapshot: "FREE", includedRecoveryCreditsGranted: null }),
    }));
    expect(test.transaction).not.toHaveProperty("billingPeriodEntitlementCounter");
  });

  it("preserves an existing lifetime counter and exact period replay state", async () => {
    const existingCounter = {
      id: "lifetime-1",
      grantedQuantity: 5,
      committedQuantity: 2,
      reservedQuantity: 1,
      refundingQuantity: 1,
      version: 9,
    };
    const test = harness({
      row: pendingRow(),
      providerResult: freeProvider,
      plan: { id: "plan-free", name: "Free", active: true, kind: "FREE", recoveryCreditPackEnabled: false },
      lifetimeCounter: existingCounter,
    });
    await test.service.reconcileJob(payload);
    expect(test.transaction.shopEntitlementCounter.upsert).not.toHaveBeenCalled();
    expect(test.transaction.billingPeriod.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
    expect(existingCounter).toEqual({
      id: "lifetime-1",
      grantedQuantity: 5,
      committedQuantity: 2,
      reservedQuantity: 1,
      refundingQuantity: 1,
      version: 9,
    });
  });

  it("does not change an existing lifetime grant when platform policy changes", async () => {
    const existingCounter = {
      id: "lifetime-1",
      grantedQuantity: 5,
      committedQuantity: 2,
      reservedQuantity: 1,
      refundingQuantity: 1,
      version: 9,
    };
    const test = harness({
      row: pendingRow(),
      providerResult: freeProvider,
      plan: { id: "plan-free", name: "Free", active: true, kind: "FREE", recoveryCreditPackEnabled: false },
      policy: { lifetimeFreeRecoveryAllowance: 99 },
      lifetimeCounter: existingCounter,
    });

    await test.service.reconcileJob(payload);

    expect(test.transaction.platformBillingPolicy.findUnique).not.toHaveBeenCalled();
    expect(test.transaction.shopEntitlementCounter.upsert).not.toHaveBeenCalled();
    expect(existingCounter).toEqual({
      id: "lifetime-1",
      grantedQuantity: 5,
      committedQuantity: 2,
      reservedQuantity: 1,
      refundingQuantity: 1,
      version: 9,
    });
  });

  it("fails closed when the first lifetime grant policy is missing", async () => {
    const test = harness({ row: pendingRow(), providerResult: freeProvider, plan: { id: "plan-free", name: "Free", active: true, kind: "FREE", recoveryCreditPackEnabled: false }, policy: null });
    await expect(test.service.reconcileJob(payload)).rejects.toThrow("PlatformBillingPolicy.default");
    expect(test.transaction.subscription.update).not.toHaveBeenCalled();
    expect(test.transaction.shopSettings.update).not.toHaveBeenCalled();
  });

  it("uses bounded cycle discovery retry when a pack-enabled Free provider omits the exact cycle", async () => {
    const test = harness({
      row: pendingRow(),
      providerResult: { ...freeProvider, currentPeriodStart: null, currentPeriodEnd: null },
      plan: { id: "plan-free", name: "Free", active: true, kind: "FREE", recoveryCreditPackEnabled: true },
    });
    await test.service.reconcileJob(payload);
    expect(test.transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ nextReconcileAt: new Date("2026-09-12T12:05:00.000Z") }) }));
    expect(test.queue.add).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ expectedNextReconcileAt: "2026-09-12T12:05:00.000Z" }), expect.any(Object));
    expect(test.queue.add).toHaveBeenCalled();
  });

  it("does not overwrite a newer selection after the Partner response", async () => {
    const test = harness({ row: pendingRow(), providerResult: null });
    test.database.subscription.updateMany.mockResolvedValue({ count: 0 });
    await test.service.reconcileJob(payload);
    expect(test.queue.add).not.toHaveBeenCalled();
  });

  it("reconstructs only active pending rows and preserves overdue work as immediate jobs", async () => {
    const row = pendingRow({ subscription: { ...pendingRow().subscription, nextReconcileAt: new Date("2026-09-12T11:00:00.000Z") } });
    const test = harness({ nowValue: new Date("2026-09-30T00:00:00.000Z") });
    test.database.shop.findMany.mockResolvedValue([row]);
    const count = await test.service.reconstruct();
    expect(count).toBe(1);
    expect(test.database.shop.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        status: "ACTIVE",
        OR: expect.arrayContaining([
          { subscription: { is: { pendingPlanId: { not: null }, nextReconcileAt: { not: null } } } },
          { subscription: { is: { status: "FROZEN", nextReconcileAt: { not: null } } } },
          expect.objectContaining({
            settings: { is: { onboardingCompleted: true } },
            subscription: { is: expect.objectContaining({ pendingEffectiveAt: null }) },
          }),
        ]),
      },
    }));
    expect(test.queue.add).toHaveBeenCalled();
    expect(test.queue.add.mock.calls[0][1].expectedNextReconcileAt).toBe("2026-09-12T11:00:00.000Z");
    expect(test.queue.add.mock.calls[0][2].delay).toBe(0);
  });

  it("reconstructs future jobs with their remaining delay and deterministic duplicate ids", async () => {
    const future = new Date("2026-09-12T12:05:00.000Z");
    const test = harness();
    test.database.shop.findMany.mockResolvedValue([{ id: "shop-1", subscription: { id: "subscription-1", nextReconcileAt: future } }]);
    await test.service.reconstruct();
    await test.service.reconstruct();
    expect(test.queue.add.mock.calls[0][2].delay).toBe(5 * 60 * 1000);
    expect(test.queue.add.mock.calls[0][2].jobId).toBe(test.queue.add.mock.calls[1][2].jobId);
  });

  it("reconstructs a missing pack-enabled Free cycle job deterministically", async () => {
    const next = new Date("2026-09-30T23:55:00.000Z");
    const row = {
      id: "shop-1",
      status: "ACTIVE",
      settings: { onboardingCompleted: true },
      subscription: {
        id: "subscription-1",
        status: "ACTIVE",
        planId: "plan-free",
        billingPeriodId: "period-free",
        pendingPlanId: null,
        pendingShopifyPlanHandle: null,
        pendingEffectiveAt: null,
        nextReconcileAt: next,
        plan: { active: true, kind: "FREE", recoveryCreditPackEnabled: true },
      },
    };
    const test = harness({ nowValue: new Date("2026-09-30T00:00:00.000Z") });
    test.database.shop.findMany.mockResolvedValue([row]);

    await expect(test.service.reconstruct()).resolves.toBe(1);
    await expect(test.service.reconstruct()).resolves.toBe(1);

    expect(test.queue.add).toHaveBeenCalledTimes(2);
    expect(test.queue.add.mock.calls[0][1]).toEqual(expect.objectContaining({
      shopId: "shop-1", subscriptionId: "subscription-1", expectedNextReconcileAt: next.toISOString(),
    }));
    expect(test.queue.add.mock.calls[0][2]).toEqual(expect.objectContaining({
      jobId: test.queue.add.mock.calls[1][2].jobId,
      delay: 23 * 60 * 60 * 1000 + 55 * 60 * 1000,
    }));
  });

  it("reschedules an early rollover job to the exact drain start", async () => {
    const periodStart = new Date("2026-09-01T00:00:00.000Z");
    const periodEnd = new Date("2026-10-01T00:00:00.000Z");
    const oldNext = new Date("2026-09-30T22:00:00.000Z");
    const preCloseAt = new Date("2026-09-30T23:55:00.000Z");
    const row = cycleRow({ subscription: { ...cycleRow().subscription, planId: "plan-paid", billingPeriodId: "period-old", currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, nextReconcileAt: oldNext } });
    const test = harness({
      row,
      plan: { id: "plan-paid", active: true, name: "Paid", kind: "PAID_METERED", shopifyPlanHandle: "paid-2026", recoveryCreditPackEnabled: true, shopifyUsageEventHandle: "recovery-meter", shopifyRecoveryCreditPackEventHandle: null, includedRecoveryConversationAllowance: 100 },
      nowValue: new Date("2026-09-30T22:30:00.000Z"),
    });
    test.database.subscription.findUnique.mockResolvedValue({
      id: "subscription-1", status: "ACTIVE", planId: "plan-paid", billingPeriodId: "period-old",
      currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, nextReconcileAt: oldNext,
    });

    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: oldNext.toISOString() });

    expect(test.partner.getActiveSubscription).not.toHaveBeenCalled();
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "subscription-1",
        status: { in: ["ACTIVE", "TRIALING"] },
        planId: "plan-paid",
        billingPeriodId: "period-old",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        nextReconcileAt: oldNext,
      },
      data: { nextReconcileAt: preCloseAt },
    }));
    expect(test.queue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ expectedNextReconcileAt: preCloseAt.toISOString() }),
      expect.objectContaining({ delay: 85 * 60 * 1000 }),
    );
    expect(test.database.subscription.updateMany).toHaveBeenCalledTimes(1);
  });

  it("uses the exact source projection CAS when rescheduling an early rollover job", async () => {
    const periodStart = new Date("2026-09-01T00:00:00.000Z");
    const periodEnd = new Date("2026-10-01T00:00:00.000Z");
    const expectedNext = new Date("2026-09-30T23:00:00.000Z");
    const row = cycleRow({
      subscription: {
        ...cycleRow().subscription,
        planId: "plan-paid",
        billingPeriodId: "period-old",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        nextReconcileAt: expectedNext,
      },
    });
    const test = harness({
      row,
      plan: {
        id: "plan-paid",
        active: true,
        name: "Paid",
        kind: "PAID_METERED",
        shopifyPlanHandle: "paid-2026",
        recoveryCreditPackEnabled: true,
        shopifyUsageEventHandle: "recovery-meter",
        shopifyRecoveryCreditPackEventHandle: null,
        includedRecoveryConversationAllowance: 100,
      },
      nowValue: new Date("2026-09-30T23:01:00.000Z"),
    });
    test.database.subscription.findUnique.mockResolvedValue({
      id: "subscription-1",
      status: "ACTIVE",
      planId: "plan-paid",
      billingPeriodId: "period-old",
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      nextReconcileAt: expectedNext,
    });
    test.database.subscription.updateMany.mockResolvedValue({ count: 0 });
    const publishDue = vi.spyOn(shopifyUsageEventPublisherService, "publishDue").mockResolvedValue({
      selected: 0,
      claimed: 0,
      reported: 0,
      retryable: 0,
      needsAttention: 0,
    });

    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: expectedNext.toISOString() });

    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "subscription-1",
        status: { in: ["ACTIVE", "TRIALING"] },
        planId: "plan-paid",
        billingPeriodId: "period-old",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        nextReconcileAt: expectedNext,
      },
    }));
    expect(test.queue.add).not.toHaveBeenCalled();
    publishDue.mockRestore();
  });

  it("flushes only the scheduled BillingPeriod and schedules the exact boundary", async () => {
    const periodStart = new Date("2026-09-01T00:00:00.000Z");
    const periodEnd = new Date("2026-10-01T00:00:00.000Z");
    const preCloseAt = new Date("2026-09-30T23:55:00.000Z");
    const row = cycleRow({
      subscription: {
        ...cycleRow().subscription,
        planId: "plan-paid",
        billingPeriodId: "period-old",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        nextReconcileAt: preCloseAt,
      },
    });
    const test = harness({
      row,
      plan: {
        id: "plan-paid", active: true, name: "Paid", kind: "PAID_METERED",
        shopifyPlanHandle: "paid-2026", recoveryCreditPackEnabled: true,
        shopifyUsageEventHandle: "recovery-meter", shopifyRecoveryCreditPackEventHandle: "pack-meter",
        includedRecoveryConversationAllowance: 100,
      },
      nowValue: new Date("2026-09-30T23:56:00.000Z"),
    });
    test.database.subscription.findUnique.mockResolvedValue({
      id: "subscription-1", status: "ACTIVE", planId: "plan-paid", billingPeriodId: "period-old",
      currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, nextReconcileAt: preCloseAt,
    });
    const publishDue = vi.spyOn(shopifyUsageEventPublisherService, "publishDue").mockResolvedValue({
      selected: 2, claimed: 2, reported: 2, retryable: 0, needsAttention: 0,
    });

    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: preCloseAt.toISOString() });

    expect(publishDue).toHaveBeenCalledWith({ billingPeriodId: "period-old" });
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ nextReconcileAt: periodEnd, lastSyncErrorCode: null, lastSyncErrorAt: null }),
    }));
    expect(test.queue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ expectedNextReconcileAt: periodEnd.toISOString() }),
      expect.objectContaining({ jobId: expect.any(String), delay: 4 * 60 * 1000 }),
    );
    publishDue.mockRestore();
  });

  it("records and retries a thrown pre-close flush failure before the boundary", async () => {
    const periodStart = new Date("2026-09-01T00:00:00.000Z");
    const periodEnd = new Date("2026-10-01T00:00:00.000Z");
    const preCloseAt = new Date("2026-09-30T23:55:00.000Z");
    const retryNow = new Date("2026-09-30T23:56:00.000Z");
    const retryAt = new Date("2026-09-30T23:57:00.000Z");
    const row = cycleRow({ subscription: { ...cycleRow().subscription, planId: "plan-paid", billingPeriodId: "period-old", currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, nextReconcileAt: preCloseAt } });
    const test = harness({ row, plan: { ...cyclePlan, id: "plan-paid", name: "Paid", kind: "PAID_METERED", shopifyPlanHandle: "paid-2026", recoveryCreditPackEnabled: true, shopifyUsageEventHandle: "recovery-meter", shopifyRecoveryCreditPackEventHandle: "pack-meter", includedRecoveryConversationAllowance: 100 }, nowValue: retryNow });
    test.database.subscription.findUnique.mockResolvedValue({ id: "subscription-1", status: "ACTIVE", planId: "plan-paid", billingPeriodId: "period-old", currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, nextReconcileAt: preCloseAt });
    const publishDue = vi.spyOn(shopifyUsageEventPublisherService, "publishDue").mockRejectedValue(new Error("publisher unavailable"));

    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: preCloseAt.toISOString() });

    expect(publishDue).toHaveBeenCalledWith({ billingPeriodId: "period-old" });
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ nextReconcileAt: retryAt, lastSyncErrorCode: "PRE_CLOSE_USAGE_FLUSH_FAILED", lastSyncErrorAt: retryNow }),
    }));
    expect(test.queue.add).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ expectedNextReconcileAt: retryAt.toISOString() }), expect.any(Object));
    publishDue.mockRestore();
  });

  it("keeps pre-close failure evidence and schedules the boundary in the final minute", async () => {
    const periodStart = new Date("2026-09-01T00:00:00.000Z");
    const periodEnd = new Date("2026-10-01T00:00:00.000Z");
    const preCloseAt = new Date("2026-09-30T23:55:00.000Z");
    const finalMinute = new Date("2026-09-30T23:59:30.000Z");
    const row = cycleRow({ subscription: { ...cycleRow().subscription, planId: "plan-paid", billingPeriodId: "period-old", currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, nextReconcileAt: preCloseAt } });
    const test = harness({ row, plan: { ...cyclePlan, id: "plan-paid", name: "Paid", kind: "PAID_METERED", shopifyPlanHandle: "paid-2026", recoveryCreditPackEnabled: true, shopifyUsageEventHandle: "recovery-meter", shopifyRecoveryCreditPackEventHandle: "pack-meter", includedRecoveryConversationAllowance: 100 }, nowValue: finalMinute });
    test.database.subscription.findUnique.mockResolvedValue({ id: "subscription-1", status: "ACTIVE", planId: "plan-paid", billingPeriodId: "period-old", currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, nextReconcileAt: preCloseAt });
    const publishDue = vi.spyOn(shopifyUsageEventPublisherService, "publishDue").mockRejectedValue(new Error("publisher unavailable"));

    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: preCloseAt.toISOString() });

    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ nextReconcileAt: periodEnd, lastSyncErrorCode: "PRE_CLOSE_USAGE_FLUSH_FAILED", lastSyncErrorAt: finalMinute }),
    }));
    expect(test.queue.add).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ expectedNextReconcileAt: periodEnd.toISOString() }), expect.any(Object));
    publishDue.mockRestore();
  });

  it("successfully retries a failed pre-close flush and clears its failure metadata", async () => {
    const periodStart = new Date("2026-09-01T00:00:00.000Z");
    const periodEnd = new Date("2026-10-01T00:00:00.000Z");
    const preCloseAt = new Date("2026-09-30T23:55:00.000Z");
    const retryNow = new Date("2026-09-30T23:57:00.000Z");
    const row = cycleRow({ subscription: { ...cycleRow().subscription, planId: "plan-paid", billingPeriodId: "period-old", currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, nextReconcileAt: retryNow } });
    const test = harness({
      row,
      plan: { id: "plan-paid", active: true, name: "Paid", kind: "PAID_METERED", shopifyPlanHandle: "paid-2026", recoveryCreditPackEnabled: true, shopifyUsageEventHandle: "recovery-meter", shopifyRecoveryCreditPackEventHandle: null, includedRecoveryConversationAllowance: 100 },
      nowValue: retryNow,
    });
    test.database.subscription.findUnique.mockResolvedValue({
      id: "subscription-1", status: "ACTIVE", planId: "plan-paid", billingPeriodId: "period-old",
      currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, nextReconcileAt: retryNow,
    });
    const publishDue = vi.spyOn(shopifyUsageEventPublisherService, "publishDue").mockResolvedValue({ selected: 1, claimed: 1, reported: 1, retryable: 0, needsAttention: 0 });

    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: retryNow.toISOString() });

    expect(publishDue).toHaveBeenCalledWith({ billingPeriodId: "period-old" });
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { nextReconcileAt: periodEnd, lastSyncedAt: retryNow, lastSyncErrorCode: null, lastSyncErrorAt: null },
    }));
    expect(test.queue.add).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ expectedNextReconcileAt: periodEnd.toISOString() }), expect.any(Object));
    publishDue.mockRestore();
  });

  it("does not publish or schedule when the pre-close source projection CAS is stale", async () => {
    const periodStart = new Date("2026-09-01T00:00:00.000Z");
    const periodEnd = new Date("2026-10-01T00:00:00.000Z");
    const preCloseAt = new Date("2026-09-30T23:55:00.000Z");
    const row = cycleRow({ subscription: { ...cycleRow().subscription, planId: "plan-paid", billingPeriodId: "period-old", currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, nextReconcileAt: preCloseAt } });
    const test = harness({ row, plan: { ...cyclePlan, id: "plan-paid", name: "Paid", kind: "PAID_METERED", shopifyPlanHandle: "paid-2026", recoveryCreditPackEnabled: true, shopifyUsageEventHandle: "recovery-meter", shopifyRecoveryCreditPackEventHandle: "pack-meter", includedRecoveryConversationAllowance: 100 }, nowValue: new Date("2026-09-30T23:56:00.000Z") });
    test.database.subscription.findUnique.mockResolvedValue({ id: "subscription-1", status: "ACTIVE", planId: "plan-paid", billingPeriodId: "period-new", currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, nextReconcileAt: preCloseAt });
    const publishDue = vi.spyOn(shopifyUsageEventPublisherService, "publishDue").mockResolvedValue({ selected: 0, claimed: 0, reported: 0, retryable: 0, needsAttention: 0 });

    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: preCloseAt.toISOString() });

    expect(publishDue).not.toHaveBeenCalled();
    expect(test.database.subscription.updateMany).not.toHaveBeenCalled();
    expect(test.queue.add).not.toHaveBeenCalled();
    publishDue.mockRestore();
  });

  it("excludes pack-disabled Free subscriptions from cycle reconstruction", async () => {
    const test = harness();
    await test.service.reconstruct();
    const query = test.database.shop.findMany.mock.calls[0]?.[0] as { where: { OR: unknown[] } };
    const serialized = JSON.stringify(query.where.OR);
    expect(serialized).toContain('"kind":"PAID_METERED"');
    expect(serialized).toContain('"kind":"FREE","recoveryCreditPackEnabled":true');
    expect(serialized).not.toContain('"kind":"FREE","recoveryCreditPackEnabled":false');
  });

  it("excludes rows without a pending target or durable schedule", async () => {
    const test = harness();
    await test.service.reconstruct();
    expect(test.database.shop.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        status: "ACTIVE",
        OR: expect.arrayContaining([
          { subscription: { is: { pendingPlanId: { not: null }, nextReconcileAt: { not: null } } } },
          { subscription: { is: { status: "FROZEN", nextReconcileAt: { not: null } } } },
          expect.objectContaining({
            settings: { is: { onboardingCompleted: true } },
            subscription: { is: expect.objectContaining({ pendingEffectiveAt: null }) },
          }),
        ]),
      },
    }));
    expect(test.queue.add).not.toHaveBeenCalled();
  });

  it("does not roll back durable state when queue publication fails", async () => {
    const test = harness({ row: pendingRow(), providerResult: null });
    test.queue.add.mockRejectedValue(new Error("redis unavailable"));
    await expect(test.service.reconcileJob(payload)).resolves.toBeUndefined();
    expect(test.database.subscription.updateMany).toHaveBeenCalled();
    expect(test.logger.error).toHaveBeenCalledWith("billing.subscription_reconciliation.enqueue_failed", expect.anything());
  });

  it("uses exact captured target, effective time, and schedule in the null CAS", async () => {
    const test = harness({ row: pendingRow(), providerResult: null });
    await test.service.reconcileJob(payload);
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "subscription-1",
        pendingPlanId: "plan-free",
        pendingShopifyPlanHandle: "free-2026",
        pendingEffectiveAt,
        nextReconcileAt: new Date("2026-09-12T12:00:00.000Z"),
        status: "NO_CONTRACT",
        planId: null,
      }),
    }));
  });

  it("executes a subsequent missing-cycle job after onboarding", async () => {
    const test = harness({ row: cycleRow(), providerResult: { ...freeProvider, currentPeriodStart: null, currentPeriodEnd: null }, plan: cyclePlan });
    test.transaction.subscription.findUnique.mockResolvedValue({ status: "ACTIVE", planId: "plan-free", billingPeriodId: null, pendingPlanId: null, pendingShopifyPlanHandle: null, pendingEffectiveAt: null, nextReconcileAt: new Date("2026-09-12T12:00:00.000Z") });
    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: "2026-09-12T12:00:00.000Z" });
    expect(test.partner.getActiveSubscription).toHaveBeenCalledOnce();
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ nextReconcileAt: new Date("2026-09-12T12:05:00.000Z") }) }));
  });

  it("creates one canonical Free period for an exact cycle without a credit counter", async () => {
    const test = harness({ row: cycleRow(), providerResult: freeProvider, plan: cyclePlan });
    test.database.billingPlan.findUnique.mockResolvedValue(cyclePlan);
    test.transaction.subscription.findUnique.mockResolvedValue({ status: "ACTIVE", planId: "plan-free", billingPeriodId: null, pendingPlanId: null, pendingShopifyPlanHandle: null, pendingEffectiveAt: null, nextReconcileAt: new Date("2026-09-12T12:00:00.000Z") });
    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: "2026-09-12T12:00:00.000Z" });
    expect(test.transaction.billingPeriod.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {}, create: expect.objectContaining({ includedRecoveryCreditsGranted: null }) }));
    expect(test.transaction.shopEntitlementCounter.upsert).not.toHaveBeenCalled();
  });

  it("records a provider-cycle lag retry with a new deterministic job after the boundary", async () => {
    const boundary = new Date("2026-10-01T00:00:00.000Z");
    const retryNow = new Date("2026-10-01T00:00:01.000Z");
    const paidPlan = {
      id: "plan-paid",
      active: true,
      name: "Paid",
      kind: "PAID_METERED" as const,
      shopifyPlanHandle: "free-2026",
      recoveryCreditPackEnabled: false,
      shopifyUsageEventHandle: "recovery-meter",
      shopifyRecoveryCreditPackEventHandle: null,
      includedRecoveryConversationAllowance: 100,
    };
    const row = cycleRow({
      subscription: {
        ...cycleRow().subscription,
        planId: "plan-paid",
        billingPeriodId: "period-old",
        currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
        currentPeriodEnd: boundary,
        nextReconcileAt: boundary,
      },
    });
    const test = harness({
      row,
      plan: paidPlan,
      providerResult: {
        ...freeProvider,
        planHandle: "free-2026",
        usageEventHandles: ["recovery-meter"],
        currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
        currentPeriodEnd: boundary,
      },
      nowValue: retryNow,
    });
    test.transaction.subscription.findUnique.mockResolvedValue({
      shopId: "shop-1",
      status: "ACTIVE",
      planId: "plan-paid",
      billingPeriodId: "period-old",
      pendingPlanId: null,
      pendingShopifyPlanHandle: null,
      pendingEffectiveAt: null,
      nextReconcileAt: boundary,
      currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
      currentPeriodEnd: boundary,
      billingPeriod: {
        id: "period-old",
        periodStart: new Date("2026-09-01T00:00:00.000Z"),
        periodEnd: boundary,
        status: "OPEN",
      },
    });

    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: boundary.toISOString() });

    const retryAt = new Date("2026-10-01T00:01:01.000Z");
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "subscription-1",
        planId: "plan-paid",
        billingPeriodId: "period-old",
        currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
        currentPeriodEnd: boundary,
        nextReconcileAt: boundary,
      }),
      data: expect.objectContaining({
        nextReconcileAt: retryAt,
        lastSyncErrorCode: "PROVIDER_CYCLE_LAG",
        lastSyncErrorAt: retryNow,
      }),
    }));
    expect(test.queue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ expectedNextReconcileAt: retryAt.toISOString() }),
      expect.objectContaining({ jobId: expect.not.stringContaining(boundary.toISOString()) }),
    );
  });

  it("locks Subscription before rereading the exact cycle state", async () => {
    const test = harness({ row: cycleRow(), providerResult: freeProvider, plan: cyclePlan });
    test.database.billingPlan.findUnique.mockResolvedValue(cyclePlan);
    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: "2026-09-12T12:00:00.000Z" });
    expect(test.transaction.$queryRaw).toHaveBeenCalledTimes(1);
    expect(test.transaction.subscription.findUnique).toHaveBeenCalled();
    expect(test.transaction.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(test.transaction.subscription.findUnique.mock.invocationCallOrder[0]);
  });

  it("preserves cycle entitlements and schedules five minutes after cycle discovery failure", async () => {
    const test = harness({ row: cycleRow(), providerError: new Error("timeout"), plan: cyclePlan });
    test.database.billingPlan.findUnique.mockResolvedValue(cyclePlan);
    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: "2026-09-12T12:00:00.000Z" });
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ nextReconcileAt: new Date("2026-09-12T12:05:00.000Z"), lastSyncErrorCode: "PARTNER_API_ERROR" }) }));
    expect(test.database.subscription.updateMany.mock.calls[0][0].data).not.toHaveProperty("planId");
    expect(test.database.subscription.updateMany.mock.calls[0][0].data).not.toHaveProperty("billingPeriodId");
    expect(test.database.subscription.updateMany.mock.calls[0][0].data).not.toHaveProperty("currentPeriodStart");
    expect(test.database.subscription.updateMany.mock.calls[0][0].data).not.toHaveProperty("currentPeriodEnd");
    expect(test.queue.add).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ expectedNextReconcileAt: "2026-09-12T12:05:00.000Z" }), expect.any(Object));
  });

  it("repairs a missing delayed job after a committed rollover enqueue failure", async () => {
    const oldEnd = new Date("2026-09-01T00:00:00.000Z");
    const successorEnd = new Date("2026-10-01T00:00:00.000Z");
    const next = new Date("2026-09-30T23:55:00.000Z");
    const row = cycleRow({ subscription: { ...cycleRow().subscription, planId: "plan-paid", billingPeriodId: "period-old", currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"), currentPeriodEnd: oldEnd, nextReconcileAt: oldEnd } });
    const test = harness({
      row,
      plan: { id: "plan-paid", active: true, name: "Paid", kind: "PAID_METERED", shopifyPlanHandle: "paid-2026", recoveryCreditPackEnabled: true, shopifyUsageEventHandle: "recovery-meter", shopifyRecoveryCreditPackEventHandle: null, includedRecoveryConversationAllowance: 100 },
      providerResult: { ...freeProvider, planHandle: "paid-2026", usageEventHandles: ["recovery-meter"], currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: successorEnd },
      nowValue: new Date("2026-09-01T00:00:01.000Z"),
    });
    const transition = vi.spyOn(SamePlanBillingPeriodRolloverService.prototype, "transition").mockResolvedValue({ kind: "transitioned", billingPeriodId: "period-new", nextReconcileAt: next, planKind: "PAID_METERED" });
    test.queue.add.mockRejectedValueOnce(new Error("redis unavailable")).mockResolvedValue({});

    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: oldEnd.toISOString() });

    expect(transition).toHaveBeenCalledOnce();
    expect(test.logger.error).toHaveBeenCalledWith("billing.subscription_reconciliation.enqueue_failed", expect.anything());

    test.database.shop.findMany.mockResolvedValue([{ id: "shop-1", subscription: { id: "subscription-1", nextReconcileAt: next } }]);
    await expect(test.service.reconstruct()).resolves.toBe(1);
    expect(test.queue.add).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ expectedNextReconcileAt: next.toISOString() }), expect.objectContaining({ jobId: expect.any(String) }));
    expect(successorEnd.getTime()).toBeGreaterThan(oldEnd.getTime());
    transition.mockRestore();
  });

  it("publishes the next pre-close job after a later same-plan pack-enabled Free rollover", async () => {
    const oldEnd = new Date("2026-09-01T00:00:00.000Z");
    const successorEnd = new Date("2026-10-01T00:00:00.000Z");
    const next = new Date("2026-09-30T23:55:00.000Z");
    const row = cycleRow({ subscription: { ...cycleRow().subscription, planId: "plan-free", billingPeriodId: "period-old", currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"), currentPeriodEnd: oldEnd, nextReconcileAt: oldEnd } });
    const test = harness({ row, plan: cyclePlan, providerResult: { ...freeProvider, currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: successorEnd }, nowValue: new Date("2026-09-01T00:00:01.000Z") });
    const transition = vi.spyOn(SamePlanBillingPeriodRolloverService.prototype, "transition").mockResolvedValue({ kind: "transitioned", billingPeriodId: "period-new", nextReconcileAt: next, planKind: "FREE" });

    await test.service.reconcileJob({
      ...payload,
      expectedNextReconcileAt: oldEnd.toISOString(),
    });

    expect(transition).toHaveBeenCalledWith(expect.objectContaining({ shopId: "shop-1", subscriptionId: "subscription-1", plan: expect.objectContaining({ kind: "FREE", recoveryCreditPackEnabled: true }) }));
    expect(test.queue.add).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ expectedNextReconcileAt: next.toISOString() }), expect.objectContaining({ jobId: expect.any(String) }));
    transition.mockRestore();
    expect(successorEnd.getTime()).toBeGreaterThan(oldEnd.getTime());
  });

  it("keeps provider pending truth when another current plan is returned", async () => {
    const pendingAt = new Date("2026-09-13T00:00:00.000Z");
    const test = harness({
      row: pendingRow(),
      providerResult: { ...freeProvider, planHandle: "paid-2026", pendingPlanHandle: "free-2026", pendingEffectiveAt: pendingAt },
      plan: { id: "plan-paid", name: "Paid", active: true, kind: "PAID_METERED", shopifyUsageEventHandle: "recovery-meter", recoveryCreditPackEnabled: false },
    });
    test.transaction.billingPlan.findUnique.mockResolvedValue({ id: "plan-free", active: true });
    await test.service.reconcileJob(payload);
    expect(test.transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ pendingShopifyPlanHandle: "free-2026", pendingPlanId: "plan-free", pendingEffectiveAt: pendingAt, nextReconcileAt: null }) }));
  });

  it("clears the stale initial target when another provider plan has no pending target", async () => {
    const test = harness({
      row: pendingRow(),
      providerResult: { ...freeProvider, planHandle: "paid-2026", pendingPlanHandle: null, pendingEffectiveAt: null },
      plan: { id: "plan-paid", name: "Paid", active: true, kind: "PAID_METERED", shopifyUsageEventHandle: "recovery-meter", recoveryCreditPackEnabled: false },
    });
    await test.service.reconcileJob(payload);

    expect(test.transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ pendingShopifyPlanHandle: null, pendingPlanId: null, pendingEffectiveAt: null, nextReconcileAt: null }) }));
  });

  it("publishes deterministic jobs with failed-job removal enabled", async () => {
    const test = harness({ row: pendingRow(), providerResult: null });
    await test.service.reconcileJob(payload);
    expect(test.queue.add).toHaveBeenCalledWith(expect.any(String), expect.any(Object), expect.objectContaining({ jobId: expect.any(String), removeOnFail: true, removeOnComplete: 100 }));
  });
});
