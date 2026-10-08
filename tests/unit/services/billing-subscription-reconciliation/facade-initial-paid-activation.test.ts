import { describe, expect, it, vi } from "vitest";
import { now, pendingEffectiveAt, harness, pendingRow, paidProvider, paidPlan, payload } from "./facade-test-fixtures.js";

describe("BillingSubscriptionReconciliationService", () => {
  it("activates a matching paid target with a period snapshot, included counter, lifetime grant, and drain schedule", async () => {
    const test = harness({
      row: pendingRow({ onboardingCompleted: true, subscription: { ...pendingRow().subscription, pendingPlanId: "plan-paid", pendingShopifyPlanHandle: "paid-2026" } }),
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
    expect(test.transaction.billingPeriodEntitlementCounter.findUnique).not.toHaveBeenCalled();
    expect(test.transaction.billingPeriodEntitlementCounter.create).not.toHaveBeenCalled();
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
});
