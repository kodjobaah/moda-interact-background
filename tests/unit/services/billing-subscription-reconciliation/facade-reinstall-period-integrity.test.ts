import { describe, expect, it, vi } from "vitest";
import { SamePlanBillingPeriodRolloverService } from "../../../../src/services/same-plan-billing-period-rollover.service.js";
import { now, pendingEffectiveAt, harness, pendingRow, paidProvider, paidPlan, payload, reinstallPaidRow, configureReinstallPaidPeriod, expectNoModelMutations } from "./facade-test-fixtures.js";

describe("BillingSubscriptionReconciliationService", () => {
  const exactPaidPeriod = {
    id: "period-paid",
    shopId: "shop-1",
    subscriptionId: "subscription-1",
    planId: "plan-paid",
    periodStart: paidProvider.currentPeriodStart,
    periodEnd: paidProvider.currentPeriodEnd,
    status: "OPEN",
    includedRecoveryCreditsGranted: 100,
  };

  const exactPaidCounter = {
    id: "counter-paid",
    shopId: "shop-1",
    billingPeriodId: "period-paid",
    grantedQuantity: 100,
    committedQuantity: 12,
    reservedQuantity: 3,
    forfeitedQuantity: 1,
  };

  it.each([
    ["period shopId", { period: { shopId: "other-shop" } }],
    ["period subscriptionId", { period: { subscriptionId: "other-subscription" } }],
    ["period planId", { period: { planId: "other-plan" } }],
    ["missing included-credit counter", { counter: null }],
    ["counter shopId", { counter: { shopId: "other-shop" } }],
    ["counter billingPeriodId", { counter: { billingPeriodId: "other-period" } }],
    ["negative quantity", { counter: { reservedQuantity: -1 } }],
    ["non-integer quantity", { counter: { committedQuantity: 1.5 } }],
    ["counter grant differs from period", { counter: { grantedQuantity: 99 } }],
  ] as const)("fails closed for reinstall exact paid-period integrity: %s", async (_label, mutation) => {
    const test = harness({ row: reinstallPaidRow(), providerResult: paidProvider, plan: paidPlan });
    configureReinstallPaidPeriod(test, { ...exactPaidPeriod, ...mutation.period }, mutation.counter === null ? null : { ...exactPaidCounter, ...mutation.counter });

    await test.service.reconcileJob(payload);

    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastSyncErrorCode: "PERIOD_ALIGNMENT_REQUIRED", nextReconcileAt: null }) }));
    expect(test.transaction.subscription.update).not.toHaveBeenCalled();
    expect(test.transaction.shopSettings.update).not.toHaveBeenCalled();
    expect(test.transaction.shop.update).not.toHaveBeenCalled();
    expectNoModelMutations(test.transaction.billingPeriod);
    expectNoModelMutations(test.transaction.billingPeriodEntitlementCounter);
    expect(test.queue.add).not.toHaveBeenCalled();
  });

  it("same paid cycle refreshes pending projection without changing counter quantities", async () => {
    const pendingAt = new Date("2026-10-01T00:00:00.000Z");
    const test = harness({
      row: reinstallPaidRow(),
      providerResult: { ...paidProvider, pendingPlanHandle: "future-paid", pendingEffectiveAt: pendingAt },
      plan: paidPlan,
    });
    configureReinstallPaidPeriod(test, exactPaidPeriod, exactPaidCounter);
    test.transaction.billingPlan.findUnique.mockResolvedValue({ id: "plan-future", active: true });

    await test.service.reconcileJob(payload);

    expect(test.transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ pendingShopifyPlanHandle: "future-paid", pendingPlanId: "plan-future", pendingEffectiveAt: pendingAt }),
    }));
    expect(exactPaidCounter).toMatchObject({ grantedQuantity: 100, committedQuantity: 12, reservedQuantity: 3, forfeitedQuantity: 1 });
    expect(test.queue.add).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ expectedNextReconcileAt: "2026-09-30T23:55:00.000Z" }), expect.any(Object));
  });

  it("same paid cycle commits through queue failure and reconstruction repairs the job", async () => {
    const test = harness({ row: reinstallPaidRow(), providerResult: paidProvider, plan: paidPlan });
    configureReinstallPaidPeriod(test, exactPaidPeriod, exactPaidCounter);
    test.queue.add.mockRejectedValueOnce(new Error("Redis unavailable"));

    await expect(test.service.reconcileJob(payload)).resolves.toBeUndefined();

    expect(test.transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "ACTIVE", nextReconcileAt: new Date("2026-09-30T23:55:00.000Z") }),
    }));
    expect(test.transaction.shop.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ACTIVE", reinstallPendingAt: null }) }));
    expect(exactPaidCounter).toMatchObject({ grantedQuantity: 100, committedQuantity: 12, reservedQuantity: 3, forfeitedQuantity: 1 });

    test.database.shop.findMany.mockResolvedValue([{ id: "shop-1", subscription: { id: "subscription-1", nextReconcileAt: new Date("2026-09-30T23:55:00.000Z") } }]);
    await expect(test.service.reconstruct()).resolves.toBe(1);
    expect(test.partner.getActiveSubscription).toHaveBeenCalledOnce();
    expect(test.queue.add.mock.calls[1][1]).toEqual(expect.objectContaining({ expectedNextReconcileAt: "2026-09-30T23:55:00.000Z" }));
    expect(test.queue.add.mock.calls[1][2].jobId).toBe(test.queue.add.mock.calls[0][2].jobId);
  });

  it("later paid rollover preserves wrapper-owned balances and publishes the canonical schedule", async () => {
    const oldStart = new Date("2026-08-01T00:00:00.000Z");
    const oldEnd = new Date("2026-09-01T00:00:00.000Z");
    const next = new Date("2026-09-30T23:55:00.000Z");
    const test = harness({
      row: reinstallPaidRow({ subscription: { currentPeriodStart: oldStart, currentPeriodEnd: oldEnd } }),
      providerResult: { ...paidProvider, currentPeriodStart: oldEnd, currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z") },
      plan: paidPlan,
    });
    test.database.subscription.findUnique.mockResolvedValue({ id: "subscription-1", planId: "plan-paid", observedShopifyPlanHandle: "paid-2026", billingPeriodId: "period-old", currentPeriodStart: oldStart, currentPeriodEnd: oldEnd, nextReconcileAt: now });
    const transition = vi.spyOn(SamePlanBillingPeriodRolloverService.prototype, "transitionInTransaction").mockResolvedValue({ kind: "transitioned", billingPeriodId: "period-new", nextReconcileAt: next, planKind: "PAID_METERED" });

    await test.service.reconcileJob(payload);

    expect(transition).toHaveBeenCalledOnce();
    expect(test.transaction.shopSettings.update).toHaveBeenCalledWith({ where: { shopId: "shop-1" }, data: { onboardingCompleted: true } });
    expect(test.transaction.shop.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ACTIVE", reinstallPendingAt: null }) }));
    expect(test.queue.add).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ expectedNextReconcileAt: next.toISOString() }), expect.any(Object));
    expectNoModelMutations(test.transaction.shopEntitlementCounter);
    expectNoModelMutations(test.transaction.recoveryCreditPurchase);
    expectNoModelMutations(test.transaction.recoveryCreditRefund);
    expectNoModelMutations(test.transaction.promotionalCreditGrant);
    expectNoModelMutations(test.transaction.merchantPromotionSelection);
    transition.mockRestore();
  });

  it("different paid plan remains blocked without invoking canonical rollover", async () => {
    const test = harness({ row: reinstallPaidRow(), providerResult: { ...paidProvider, planHandle: "paid-new" }, plan: { ...paidPlan, id: "plan-new", shopifyPlanHandle: "paid-new" } });
    const transition = vi.spyOn(SamePlanBillingPeriodRolloverService.prototype, "transitionInTransaction");

    await test.service.reconcileJob(payload);

    expect(transition).not.toHaveBeenCalled();
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastSyncErrorCode: "PERIOD_ALIGNMENT_REQUIRED" }) }));
    expect(test.transaction.subscription.update).not.toHaveBeenCalled();
    expect(test.transaction.shop.update).not.toHaveBeenCalled();
    expect(test.transaction.billingPeriod.update).not.toHaveBeenCalled();
    expect(test.transaction.billingPeriodEntitlementCounter.findUnique).not.toHaveBeenCalled();
    expect(test.transaction.billingPeriodEntitlementCounter.create).not.toHaveBeenCalled();
    expect(test.queue.add).not.toHaveBeenCalled();
    transition.mockRestore();
  });

  it("reinstall provider transport failure preserves entitlement truth", async () => {
    const reinstallPendingAt = new Date("2026-09-12T11:30:00.000Z");
    const row = reinstallPaidRow({ reinstallPendingAt });
    const test = harness({ row, providerError: new Error("timeout") });

    await test.service.reconcileJob(payload);

    expect(test.database.subscription.updateMany).toHaveBeenCalledOnce();
    const update = test.database.subscription.updateMany.mock.calls[0][0];
    expect(update.where).toEqual({
      id: "subscription-1",
      nextReconcileAt: new Date("2026-09-12T12:00:00.000Z"),
    });
    expect(Object.keys(update.data).sort()).toEqual([
      "lastSyncErrorAt",
      "lastSyncErrorCode",
      "nextReconcileAt",
    ].sort());
    expect(update.data.lastSyncErrorCode).toBe("PARTNER_API_ERROR");
    expect(update.data.nextReconcileAt).toEqual(new Date("2026-09-12T12:05:00.000Z"));
    expect(test.database.$transaction).not.toHaveBeenCalled();
    expect(test.database.subscription.update).not.toHaveBeenCalled();
    expect(test.transaction.shop.update).not.toHaveBeenCalled();
    expect(test.transaction.shopSettings.update).not.toHaveBeenCalled();
    expectNoModelMutations(test.transaction.billingPeriod);
    expectNoModelMutations(test.transaction.shopEntitlementCounter);
    expectNoModelMutations(test.transaction.recoveryCreditPurchase);
    expectNoModelMutations(test.transaction.recoveryCreditRefund);
    expectNoModelMutations(test.transaction.promotionalCreditGrant);
    expectNoModelMutations(test.transaction.merchantPromotionSelection);
    expect(row.status).toBe("UNINSTALLED");
    expect(row.reinstallPendingAt).toEqual(reinstallPendingAt);
    expect(test.queue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ expectedNextReconcileAt: "2026-09-12T12:05:00.000Z" }),
      expect.any(Object),
    );
  });

  it.each([
    ["before 24 hours", new Date("2026-09-12T11:30:00.000Z"), new Date("2026-09-12T12:00:00.000Z"), new Date("2026-09-12T12:05:00.000Z")],
    ["at 24 hours", new Date("2026-09-11T12:00:00.000Z"), new Date("2026-09-12T12:00:00.000Z"), null],
  ] as const)("uses reinstallPendingAt for the reinstall retry boundary: %s", async (_label, reinstallAt, nowValue, expectedNext) => {
    const row = pendingRow({ status: "UNINSTALLED", reinstallPendingAt: reinstallAt });
    const test = harness({ row, providerError: new Error("timeout"), nowValue });
    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: nowValue.toISOString() });

    const update = test.database.subscription.updateMany.mock.calls[0][0];
    expect(Object.keys(update.data).sort()).toEqual(["lastSyncErrorAt", "lastSyncErrorCode", "nextReconcileAt"].sort());
    expect(update.data.nextReconcileAt).toEqual(expectedNext);
    if (expectedNext) {
      expect(test.queue.add).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ expectedNextReconcileAt: expectedNext.toISOString() }), expect.any(Object));
    } else {
      expect(test.queue.add).not.toHaveBeenCalled();
    }
    expect(test.database.$transaction).not.toHaveBeenCalled();
    expect(test.transaction.shop.update).not.toHaveBeenCalled();
    expect(test.transaction.shopSettings.update).not.toHaveBeenCalled();
    expectNoModelMutations(test.transaction.billingPeriod);
    expectNoModelMutations(test.transaction.shopEntitlementCounter);
    expectNoModelMutations(test.transaction.recoveryCreditPurchase);
    expectNoModelMutations(test.transaction.recoveryCreditRefund);
    expectNoModelMutations(test.transaction.promotionalCreditGrant);
    expectNoModelMutations(test.transaction.merchantPromotionSelection);
    expect(row.status).toBe("UNINSTALLED");
    expect(row.reinstallPendingAt).toEqual(reinstallAt);
  });
});
