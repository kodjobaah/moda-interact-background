import { describe, expect, it, vi } from "vitest";
import { SamePlanBillingPeriodRolloverService } from "../../../../src/services/same-plan-billing-period-rollover.service.js";
import { now, pendingEffectiveAt, harness, pendingRow, freeProvider, paidProvider, paidPlan, payload } from "./facade-test-fixtures.js";

describe("BillingSubscriptionReconciliationService", () => {
  it("reconciles only an uninstalled shop with a matching reinstall marker and schedule", async () => {
    const reinstallAt = new Date("2026-09-12T11:30:00.000Z");
    const test = harness({
      row: pendingRow({ status: "UNINSTALLED", reinstallPendingAt: reinstallAt }),
      providerResult: null,
    });

    await test.service.reconcileJob(payload);

    expect(test.partner.getActiveSubscription).toHaveBeenCalledWith("gid://shopify/Shop/1");
    expect(test.transaction.shop.update).toHaveBeenCalledWith({
      where: { id: "shop-1" },
      data: { status: "ACTIVE", uninstalledAt: null, reinstallPendingAt: null },
    });
    expect(test.transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "NO_CONTRACT", planId: null, billingPeriodId: null, nextReconcileAt: null }),
    }));
    expect(test.database.shop.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ reinstallPendingAt: true }),
    }));
  });

  it("does not process a reinstall job for another subscription or a suspended shop", async () => {
    const reinstallAt = new Date("2026-09-12T11:30:00.000Z");
    const mismatched = harness({ row: pendingRow({ status: "UNINSTALLED", reinstallPendingAt: reinstallAt }) });
    await mismatched.service.reconcileJob({ ...payload, subscriptionId: "other-subscription" });
    expect(mismatched.partner.getActiveSubscription).not.toHaveBeenCalled();

    const suspended = harness({ row: pendingRow({ status: "SUSPENDED", reinstallPendingAt: reinstallAt }) });
    await suspended.service.reconcileJob(payload);
    expect(suspended.partner.getActiveSubscription).not.toHaveBeenCalled();
  });

  it("does not restore after the locked reinstall marker or Shop status changes", async () => {
    const reinstallAt = new Date("2026-09-12T11:30:00.000Z");
    const markerChanged = harness({ row: pendingRow({ status: "UNINSTALLED", reinstallPendingAt: reinstallAt }), providerResult: null });
    markerChanged.transaction.shop.findUnique.mockResolvedValue({ id: "shop-1", status: "UNINSTALLED", reinstallPendingAt: new Date("2026-09-12T11:31:00.000Z") });
    await markerChanged.service.reconcileJob(payload);
    expect(markerChanged.transaction.subscription.update).not.toHaveBeenCalled();
    expect(markerChanged.queue.add).not.toHaveBeenCalled();

    const statusChanged = harness({ row: pendingRow({ status: "UNINSTALLED", reinstallPendingAt: reinstallAt }), providerResult: null });
    statusChanged.transaction.shop.findUnique.mockResolvedValue({ id: "shop-1", status: "SUSPENDED", reinstallPendingAt: reinstallAt });
    await statusChanged.service.reconcileJob(payload);
    expect(statusChanged.transaction.subscription.update).not.toHaveBeenCalled();
    expect(statusChanged.queue.add).not.toHaveBeenCalled();
  });

  it("keeps a stale reinstall job terminal and does not call Partner", async () => {
    const test = harness({ row: pendingRow({ status: "UNINSTALLED", reinstallPendingAt: new Date("2026-09-12T11:30:00.000Z") }) });

    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: "2026-09-12T12:01:00.000Z" });

    expect(test.partner.getActiveSubscription).not.toHaveBeenCalled();
  });

  it("reactivates a verified Free reinstall without creating a lifetime grant", async () => {
    const test = harness({
      row: pendingRow({ status: "UNINSTALLED", reinstallPendingAt: new Date("2026-09-12T11:30:00.000Z") }),
      providerResult: freeProvider,
      plan: { id: "plan-free", name: "Free", active: true, kind: "FREE", recoveryCreditPackEnabled: false, shopifyRecoveryCreditPackEventHandle: null },
    });
    test.transaction.shopEntitlementCounter.findUnique.mockResolvedValue({ id: "lifetime-1" });

    await test.service.reconcileJob(payload);

    expect(test.transaction.shopEntitlementCounter.upsert).not.toHaveBeenCalled();
    expect(test.transaction.shopSettings.update).toHaveBeenCalledWith({ where: { shopId: "shop-1" }, data: { onboardingCompleted: true } });
    expect(test.transaction.shop.update).toHaveBeenCalled();
  });

  it.each([
    ["missing configured pack meter", { shopifyRecoveryCreditPackEventHandle: null }, []],
    ["provider omits configured pack meter", { shopifyRecoveryCreditPackEventHandle: "pack-meter" }, []],
  ] as const)("fails closed for pack-enabled Free reinstall: %s", async (_label, planOverrides, usageEventHandles) => {
    const test = harness({
      row: pendingRow({ status: "UNINSTALLED", reinstallPendingAt: new Date("2026-09-12T11:30:00.000Z") }),
      providerResult: { ...freeProvider, usageEventHandles },
      plan: { id: "plan-free", name: "Free", active: true, kind: "FREE", recoveryCreditPackEnabled: true, ...planOverrides },
    });
    await test.service.reconcileJob(payload);
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastSyncErrorCode: "MISSING_USAGE_METER" }) }));
    expect(test.transaction.shop.update).not.toHaveBeenCalled();
  });

  it("refreshes the provider pending projection during Free reinstall", async () => {
    const test = harness({
      row: pendingRow({ status: "UNINSTALLED", reinstallPendingAt: new Date("2026-09-12T11:30:00.000Z") }),
      providerResult: { ...freeProvider, pendingPlanHandle: "future-free", pendingEffectiveAt: new Date("2026-10-01T00:00:00.000Z") },
      plan: { id: "plan-free", name: "Free", active: true, kind: "FREE", recoveryCreditPackEnabled: false },
    });
    test.transaction.billingPlan.findUnique.mockResolvedValue({ id: "plan-future", active: true });
    await test.service.reconcileJob(payload);
    expect(test.transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ pendingShopifyPlanHandle: "future-free", pendingPlanId: "plan-future", pendingEffectiveAt: new Date("2026-10-01T00:00:00.000Z") }) }));
  });

  it("refreshes a null pending projection during Free reinstall", async () => {
    const test = harness({
      row: pendingRow({ status: "UNINSTALLED", reinstallPendingAt: new Date("2026-09-12T11:30:00.000Z") }),
      providerResult: freeProvider,
      plan: { id: "plan-free", name: "Free", active: true, kind: "FREE", recoveryCreditPackEnabled: false },
    });
    await test.service.reconcileJob(payload);
    expect(test.transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ pendingShopifyPlanHandle: null, pendingPlanId: null, pendingEffectiveAt: null }) }));
  });

  it("reactivates the exact paid period without changing counter quantities and publishes its drain job", async () => {
    const periodStart = paidProvider.currentPeriodStart;
    const periodEnd = paidProvider.currentPeriodEnd;
    const test = harness({
      row: pendingRow({ status: "UNINSTALLED", reinstallPendingAt: new Date("2026-09-12T11:30:00.000Z"), subscription: {
        ...pendingRow().subscription, id: "subscription-1", status: "ACTIVE", planId: "plan-paid", observedShopifyPlanHandle: "paid-2026",
        pendingPlanId: null, pendingShopifyPlanHandle: null, pendingEffectiveAt: null, billingPeriodId: "period-paid",
        currentPeriodStart: periodStart, currentPeriodEnd: periodEnd,
      } }),
      providerResult: { ...paidProvider, cancelAtPeriodEnd: true },
      plan: paidPlan,
    });
    const current = { id: "subscription-1", planId: "plan-paid", observedShopifyPlanHandle: "paid-2026", billingPeriodId: "period-paid", currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, nextReconcileAt: now };
    const period = { id: "period-paid", shopId: "shop-1", subscriptionId: "subscription-1", planId: "plan-paid", periodStart, periodEnd, status: "OPEN", includedRecoveryCreditsGranted: 100 };
    const counter = { id: "counter-paid", shopId: "shop-1", billingPeriodId: "period-paid", grantedQuantity: 100, committedQuantity: 12, reservedQuantity: 3, forfeitedQuantity: 1 };
    test.database.subscription.findUnique.mockResolvedValue(current);
    test.transaction.subscription.findUnique.mockResolvedValue(current);
    test.transaction.billingPeriod = { findUnique: vi.fn().mockResolvedValue(period), upsert: vi.fn() };
    test.transaction.billingPeriodEntitlementCounter = { findUnique: vi.fn().mockResolvedValue(counter), upsert: vi.fn() };

    await test.service.reconcileJob(payload);

    expect(test.transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ACTIVE", cancelAtPeriodEnd: true, nextReconcileAt: new Date("2026-09-30T23:55:00.000Z") }) }));
    expect(counter).toMatchObject({ grantedQuantity: 100, committedQuantity: 12, reservedQuantity: 3, forfeitedQuantity: 1 });
    expect(test.queue.add).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ expectedNextReconcileAt: "2026-09-30T23:55:00.000Z" }), expect.any(Object));
  });

  it.each([
    ["missing period", null, { shopId: "shop-1", subscriptionId: "subscription-1", planId: "plan-paid", periodStart: paidProvider.currentPeriodStart, periodEnd: paidProvider.currentPeriodEnd, status: "OPEN", includedRecoveryCreditsGranted: 100 }, null],
    ["closed period", { id: "period-paid", shopId: "shop-1", subscriptionId: "subscription-1", planId: "plan-paid", periodStart: paidProvider.currentPeriodStart, periodEnd: paidProvider.currentPeriodEnd, status: "CLOSED", includedRecoveryCreditsGranted: 100 }, null, null],
    ["counter overcommitted", { id: "period-paid", shopId: "shop-1", subscriptionId: "subscription-1", planId: "plan-paid", periodStart: paidProvider.currentPeriodStart, periodEnd: paidProvider.currentPeriodEnd, status: "OPEN", includedRecoveryCreditsGranted: 100 }, { id: "counter-paid", shopId: "shop-1", billingPeriodId: "period-paid", grantedQuantity: 100, committedQuantity: 99, reservedQuantity: 2, forfeitedQuantity: 0 }, null],
  ] as const)("fails closed for exact paid-period integrity: %s", async (_label, period, _unused, counter) => {
    const test = harness({
      row: pendingRow({ status: "UNINSTALLED", reinstallPendingAt: new Date("2026-09-12T11:30:00.000Z"), subscription: {
        ...pendingRow().subscription, status: "ACTIVE", planId: "plan-paid", observedShopifyPlanHandle: "paid-2026", billingPeriodId: "period-paid", currentPeriodStart: paidProvider.currentPeriodStart, currentPeriodEnd: paidProvider.currentPeriodEnd,
      } }), providerResult: paidProvider, plan: paidPlan,
    });
    const current = { id: "subscription-1", planId: "plan-paid", observedShopifyPlanHandle: "paid-2026", billingPeriodId: "period-paid", currentPeriodStart: paidProvider.currentPeriodStart, currentPeriodEnd: paidProvider.currentPeriodEnd, nextReconcileAt: now };
    test.database.subscription.findUnique.mockResolvedValue(current);
    test.transaction.subscription.findUnique.mockResolvedValue(current);
    test.transaction.billingPeriod = { findUnique: vi.fn().mockResolvedValue(period), upsert: vi.fn() };
    test.transaction.billingPeriodEntitlementCounter = { findUnique: vi.fn().mockResolvedValue(counter), upsert: vi.fn() };
    await test.service.reconcileJob(payload);
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastSyncErrorCode: "PERIOD_ALIGNMENT_REQUIRED" }) }));
    expect(test.transaction.subscription.update).not.toHaveBeenCalled();
    expect(test.transaction.shop.update).not.toHaveBeenCalled();
  });

  it("delegates a later same-plan paid cycle atomically with reinstall activation", async () => {
    const oldStart = new Date("2026-08-01T00:00:00.000Z");
    const oldEnd = new Date("2026-09-01T00:00:00.000Z");
    const test = harness({
      row: pendingRow({ status: "UNINSTALLED", reinstallPendingAt: new Date("2026-09-12T11:30:00.000Z"), subscription: {
        ...pendingRow().subscription, status: "ACTIVE", planId: "plan-paid", observedShopifyPlanHandle: "paid-2026", billingPeriodId: "period-old", currentPeriodStart: oldStart, currentPeriodEnd: oldEnd,
      } }), providerResult: { ...paidProvider, currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z") }, plan: paidPlan,
    });
    const current = { id: "subscription-1", planId: "plan-paid", observedShopifyPlanHandle: "paid-2026", billingPeriodId: "period-old", currentPeriodStart: oldStart, currentPeriodEnd: oldEnd, nextReconcileAt: now };
    test.database.subscription.findUnique.mockResolvedValue(current);
    test.transaction.subscription.findUnique.mockResolvedValue(current);
    const transition = vi.spyOn(SamePlanBillingPeriodRolloverService.prototype, "transitionInTransaction").mockResolvedValue({ kind: "transitioned", billingPeriodId: "period-new", nextReconcileAt: new Date("2026-09-30T23:55:00.000Z"), planKind: "PAID_METERED" });
    await test.service.reconcileJob(payload);
    expect(transition).toHaveBeenCalled();
    expect(test.transaction.shop.update).toHaveBeenCalled();
    expect(test.queue.add).toHaveBeenCalled();
    transition.mockRestore();
  });

  it("does not enter canonical rollover after a stale reinstall marker", async () => {
    const test = harness({ row: pendingRow({ status: "UNINSTALLED", reinstallPendingAt: new Date("2026-09-12T11:30:00.000Z"), subscription: { ...pendingRow().subscription, status: "ACTIVE", planId: "plan-paid", observedShopifyPlanHandle: "paid-2026", billingPeriodId: "period-old", currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z") } }), providerResult: { ...paidProvider, currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z") }, plan: paidPlan });
    test.database.subscription.findUnique.mockResolvedValue({ id: "subscription-1", planId: "plan-paid", observedShopifyPlanHandle: "paid-2026", billingPeriodId: "period-old", currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"), nextReconcileAt: now });
    test.transaction.shop.findUnique.mockResolvedValue({ id: "shop-1", status: "SUSPENDED", reinstallPendingAt: new Date("2026-09-12T11:30:00.000Z") });
    const transition = vi.spyOn(SamePlanBillingPeriodRolloverService.prototype, "transitionInTransaction");
    await test.service.reconcileJob(payload);
    expect(transition).not.toHaveBeenCalled();
    expect(test.queue.add).not.toHaveBeenCalled();
    transition.mockRestore();
  });
});
