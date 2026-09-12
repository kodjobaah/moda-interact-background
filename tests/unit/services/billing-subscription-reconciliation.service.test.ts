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

  it("records transport failure without replacing the current projection", async () => {
    const row = pendingRow({ subscription: { ...pendingRow().subscription, status: "ACTIVE", planId: "plan-paid" } });
    const test = harness({ row, providerError: new Error("timeout") });
    await test.service.reconcileJob(payload);
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastSyncErrorCode: "PARTNER_API_ERROR", nextReconcileAt: expect.any(Date) }),
    }));
    expect(test.database.subscription.updateMany.mock.calls[0][0].where).toEqual(expect.objectContaining({
      status: "NO_CONTRACT",
      planId: null,
    }));
    expect(test.database.subscription.updateMany.mock.calls[0][0].data).not.toHaveProperty("status");
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
    expect(test.transaction.shopEntitlementCounter.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ grantedQuantity: 7 }),
    }));
    expect(test.queue.add).toHaveBeenCalled();
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
    expect(test.transaction.shopEntitlementCounter.create).not.toHaveBeenCalled();
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
});
