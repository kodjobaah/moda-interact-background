import { describe, expect, it, vi } from "vitest";

import {
  BillingSubscriptionReconciliationService,
  createSubscriptionReconcilePayload,
  nextSubscriptionReconcileAt,
} from "../../../src/services/billing-subscription-reconciliation.service.js";

const now = new Date("2026-09-12T12:00:00.000Z");
const pendingEffectiveAt = new Date("2026-09-12T11:00:00.000Z");

function harness({
  row,
  providerResult = null,
  providerError,
  plan = null,
  policy = { lifetimeFreeRecoveryAllowance: 7 },
  lifetimeCounter = null,
} = {}) {
  const subscriptionUpdate = vi.fn();
  const queue = { add: vi.fn().mockResolvedValue({}) };
  const transaction = {
    billingPeriod: { upsert: vi.fn().mockResolvedValue({ id: "period-1" }) },
    billingPlan: { findUnique: vi.fn().mockResolvedValue(null) },
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
    shopSettings: { update: vi.fn() },
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
    subscription: { update: subscriptionUpdate, updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
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
    () => now,
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
      create: expect.objectContaining({ grantedQuantity: 7 }),
    }));
    expect(test.queue.add).toHaveBeenCalled();
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
    const existingCounter = { id: "lifetime-1", grantedQuantity: 5, committedQuantity: 2 };
    const test = harness({
      row: pendingRow(),
      providerResult: freeProvider,
      plan: { id: "plan-free", name: "Free", active: true, kind: "FREE", recoveryCreditPackEnabled: false },
      lifetimeCounter: existingCounter,
    });
    await test.service.reconcileJob(payload);
    expect(test.transaction.shopEntitlementCounter.upsert).not.toHaveBeenCalled();
    expect(test.transaction.billingPeriod.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
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
    expect(test.transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ nextReconcileAt: new Date("2026-09-12T12:30:00.000Z") }) }));
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
    const test = harness();
    test.database.shop.findMany.mockResolvedValue([row]);
    const count = await test.service.reconstruct();
    expect(count).toBe(1);
    expect(test.database.shop.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        status: "ACTIVE",
        subscription: {
          OR: [
            { pendingPlanId: { not: null }, nextReconcileAt: { not: null } },
            { status: "FROZEN", nextReconcileAt: { not: null } },
            expect.objectContaining({
              status: { in: ["ACTIVE", "TRIALING"] },
              planId: { not: null },
              billingPeriodId: null,
              pendingPlanId: null,
              pendingShopifyPlanHandle: null,
              nextReconcileAt: { not: null },
            }),
          ],
        },
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

  it("excludes rows without a pending target or durable schedule", async () => {
    const test = harness();
    await test.service.reconstruct();
    expect(test.database.shop.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        status: "ACTIVE",
        subscription: {
          OR: [
            { pendingPlanId: { not: null }, nextReconcileAt: { not: null } },
            { status: "FROZEN", nextReconcileAt: { not: null } },
            expect.objectContaining({
              status: { in: ["ACTIVE", "TRIALING"] },
              planId: { not: null },
              billingPeriodId: null,
              pendingPlanId: null,
              pendingShopifyPlanHandle: null,
              nextReconcileAt: { not: null },
            }),
          ],
        },
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

  it("preserves cycle entitlements and schedules five minutes after cycle discovery failure", async () => {
    const test = harness({ row: cycleRow(), providerError: new Error("timeout"), plan: cyclePlan });
    test.database.billingPlan.findUnique.mockResolvedValue(cyclePlan);
    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: "2026-09-12T12:00:00.000Z" });
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ nextReconcileAt: new Date("2026-09-12T12:05:00.000Z"), lastSyncErrorCode: "PARTNER_API_ERROR" }) }));
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
