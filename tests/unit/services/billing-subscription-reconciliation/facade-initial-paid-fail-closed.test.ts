import { describe, expect, it, vi } from "vitest";
import { now, pendingEffectiveAt, harness, pendingRow, paidProvider, paidPlan, payload } from "./facade-test-fixtures.js";

describe("BillingSubscriptionReconciliationService", () => {
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
});
