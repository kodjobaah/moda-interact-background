import { describe, expect, it, vi } from "vitest";
import { now, pendingEffectiveAt, harness, pendingRow, freeProvider, paidPlan, payload } from "./facade-test-fixtures.js";

describe("BillingSubscriptionReconciliationService", () => {
  it("keeps NO_CONTRACT pending intent and schedules the next retry on null provider truth", async () => {
    const test = harness({ row: pendingRow({ onboardingCompleted: true }), providerResult: null });
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
      row: pendingRow({ onboardingCompleted: true }),
      providerResult: freeProvider,
      plan: { id: "plan-free", name: "Free", active: true, kind: "FREE", recoveryCreditPackEnabled: true },
    });
    await test.service.reconcileJob(payload);
    expect(test.transaction.billingPeriod.create).toHaveBeenCalled();
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

  it("locks Shop, ShopSettings, and Subscription in order for verified Free completion", async () => {
    const test = harness({ row: pendingRow(), providerResult: freeProvider, plan: { id: "plan-free", name: "Free", active: true, kind: "FREE", recoveryCreditPackEnabled: false } });
    await test.service.reconcileJob(payload);
    expect(test.transaction.$queryRaw.mock.calls.map(([query]: [{ strings?: string[] }]) => query.strings?.join("?") ?? "")).toEqual([
      expect.stringContaining('FROM "commerce"."Shop"'),
      expect.stringContaining('FROM "shopify"."ShopSettings"'),
      expect.stringContaining('FROM "billing"."Subscription"'),
    ]);
    expect(test.transaction.shop.update).toHaveBeenCalledWith({ where: { id: "shop-1" }, data: { onboardingCompleted: true } });
    expect(test.transaction.shopSettings.update).toHaveBeenCalledWith({ where: { shopId: "shop-1" }, data: { onboardingCompleted: true } });
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

    expect(test.transaction.$queryRaw).toHaveBeenCalledTimes(3);
    expect(test.transaction.billingPeriod.upsert).not.toHaveBeenCalled();
    expect(test.transaction.shopEntitlementCounter.upsert).not.toHaveBeenCalled();
    expect(test.transaction.subscription.update).not.toHaveBeenCalled();
    expect(test.transaction.shop.update).not.toHaveBeenCalled();
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
      row: pendingRow({ onboardingCompleted: true }),
      providerResult: { ...freeProvider, planHandle: "paid-2026", usageEventHandles: ["recovery-meter"] },
      plan: { ...paidPlan, id: "plan-paid", name: "Paid", active: true, kind: "PAID_METERED", shopifyUsageEventHandle: "recovery-meter", recoveryCreditPackEnabled: false },
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
    expect(test.transaction.billingPeriod.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ planId: "plan-free", shopifyPlanHandleSnapshot: "free-2026", planNameSnapshot: "Free", planKindSnapshot: "FREE", includedRecoveryCreditsGranted: null }),
    }));
    expect(test.transaction.billingPeriodEntitlementCounter.findUnique).not.toHaveBeenCalled();
    expect(test.transaction.billingPeriodEntitlementCounter.create).not.toHaveBeenCalled();
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
    expect(test.transaction.billingPeriod.findUnique).toHaveBeenCalled();
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
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ nextReconcileAt: new Date("2026-09-12T12:05:00.000Z") }) }));
    expect(test.queue.add).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ expectedNextReconcileAt: "2026-09-12T12:05:00.000Z" }), expect.any(Object));
    expect(test.queue.add).toHaveBeenCalled();
  });

  it("does not overwrite a newer selection after the Partner response", async () => {
    const test = harness({ row: pendingRow(), providerResult: null });
    test.database.subscription.updateMany.mockResolvedValue({ count: 0 });
    await test.service.reconcileJob(payload);
    expect(test.queue.add).not.toHaveBeenCalled();
  });
});
