import { describe, expect, it, vi } from "vitest";
import { createSubscriptionReconcilePayload, nextSubscriptionReconcileAt } from "../../../src/services/billing-subscription-reconciliation.service.js";
import { shopifyUsageEventPublisherService } from "../../../src/services/shopify-usage-event-publisher.service.js";
import { now, pendingEffectiveAt, defaultRuntimeConfig, harness, pendingRow, freeProvider, payload, cycleRow, establishedCurrentPlan, establishedTargetPlan, establishedProvider, establishedRow, expectNoModelMutations } from "./billing-subscription-reconciliation/facade-test-fixtures.js";

describe("BillingSubscriptionReconciliationService", () => {
  it("enters fail-closed SYNC_ERROR for a provider-current target with a missing cycle", async () => {
    const test = harness({ row: establishedRow(), providerResult: { ...establishedProvider, currentPeriodStart: null, currentPeriodEnd: null }, plan: establishedCurrentPlan });
    test.database.billingPlan.findUnique
      .mockResolvedValueOnce(establishedCurrentPlan)
      .mockResolvedValueOnce(establishedTargetPlan);

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now));
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "SYNC_ERROR",
        lastSyncErrorCode: "MISSING_BILLING_CYCLE",
        nextReconcileAt: new Date("2026-09-12T12:01:00.000Z"),
      }),
    }));
    expect(test.queue.add).toHaveBeenCalledOnce();
  });

  it("enters fail-closed SYNC_ERROR for a provider-current target with a missing meter", async () => {
    const test = harness({ row: establishedRow(), providerResult: { ...establishedProvider, usageEventHandles: [] }, plan: establishedCurrentPlan });
    test.database.billingPlan.findUnique
      .mockResolvedValueOnce(establishedCurrentPlan)
      .mockResolvedValueOnce(establishedTargetPlan);

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now));
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "SYNC_ERROR", lastSyncErrorCode: "MISSING_USAGE_METER" }),
    }));
    expect(test.queue.add).toHaveBeenCalledOnce();
  });

  it("keeps established entitlement on Partner failure and publishes one bounded retry", async () => {
    const test = harness({ row: establishedRow(), providerError: new Error("timeout"), plan: establishedCurrentPlan });
    test.database.billingPlan.findUnique.mockResolvedValueOnce(establishedCurrentPlan);

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now));

    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ planId: "plan-current", pendingPlanId: "plan-target" }),
      data: expect.objectContaining({ lastSyncErrorCode: "PARTNER_API_ERROR", nextReconcileAt: new Date("2026-09-12T12:01:00.000Z") }),
    }));
    const data = test.database.subscription.updateMany.mock.calls[0][0].data;
    for (const field of ["status", "planId", "billingPeriodId", "currentPeriodStart", "currentPeriodEnd", "pendingPlanId", "pendingShopifyPlanHandle", "pendingEffectiveAt"]) expect(data).not.toHaveProperty(field);
    expect(test.queue.add).toHaveBeenCalledOnce();
  });

  it("keeps established entitlement unresolved when Partner reports no active subscription", async () => {
    const test = harness({ row: establishedRow(), providerResult: null, plan: establishedCurrentPlan });
    test.database.billingPlan.findUnique.mockResolvedValueOnce(establishedCurrentPlan);

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now));

    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastSyncErrorCode: "PROVIDER_STATE_UNRESOLVED", nextReconcileAt: new Date("2026-09-12T12:01:00.000Z") }),
    }));
    const data = test.database.subscription.updateMany.mock.calls[0][0].data;
    for (const field of ["status", "planId", "billingPeriodId", "currentPeriodStart", "currentPeriodEnd", "pendingPlanId", "pendingShopifyPlanHandle", "pendingEffectiveAt"]) expect(data).not.toHaveProperty(field);
    expect(test.database.subscription.updateMany.mock.calls.every(([call]: any[]) => call.where?.status !== "NO_CONTRACT")).toBe(true);
    expect(test.queue.add).toHaveBeenCalledOnce();
  });

  it("replays FROZEN lifecycle evidence and republishes the committed hourly job", async () => {
    const hourly = new Date("2026-09-12T12:00:15.000Z");
    const row = establishedRow({ subscription: { ...establishedRow().subscription, status: "FROZEN", nextReconcileAt: now } });
    const test = harness({ row, providerResult: null, plan: establishedCurrentPlan, runtimeConfig: { ...defaultRuntimeConfig, billingFrozenRecheckSeconds: 15 } });
    test.database.billingPlan.findUnique.mockResolvedValueOnce(establishedCurrentPlan);
    test.transaction.subscription.findUnique.mockResolvedValue({ status: "FROZEN", lastProviderLifecycleEventAt: new Date("2026-09-12T10:00:00.000Z"), lastProviderLifecycleEventId: "event-old" });
    test.database.subscription.findUnique.mockResolvedValue({ nextReconcileAt: hourly });
    test.partner.getSubscriptionReconciliationSnapshot.mockResolvedValue({ activeSubscription: null, latestLifecycleEvent: { id: "event-frozen", eventType: "SUBSCRIPTION_FROZEN", state: "FROZEN", occurredAt: new Date("2026-09-12T11:00:00.000Z"), cancelEffectiveOn: null, planHandle: "paid-current", billingPeriod: "2026-09-01/2026-10-01" } });

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now));

    expect(test.queue.add).toHaveBeenCalledOnce();
    expect(test.queue.add.mock.calls[0][1].expectedNextReconcileAt).toBe(hourly.toISOString());
    expect(test.queue.add.mock.calls[0][2].jobId).toMatch(/^billing-subscription-reconcile-/);
  });

  it("captures one runtime snapshot and reuses it for queued usage publishing", async () => {
    const insideDrain = new Date("2026-09-30T23:57:00.000Z");
    const runtimeConfig = { ...defaultRuntimeConfig, shopifyUsagePublishBatchSize: 17, shopifyUsageRetryBaseSeconds: 9, shopifyUsageRetryMaxSeconds: 90 };
    const runtimeConfigReader = { current: vi.fn(() => runtimeConfig) };
    const test = harness({
      nowValue: insideDrain,
      runtimeConfig,
      runtimeConfigReader,
      row: establishedRow({ subscription: { ...establishedRow().subscription, pendingPlanId: null, pendingShopifyPlanHandle: null, pendingEffectiveAt: null, cancelAtPeriodEnd: false, nextReconcileAt: insideDrain } }),
      providerResult: { ...establishedProvider, planHandle: "paid-current", pendingPlanHandle: null, pendingEffectiveAt: null, currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"), cancelAtEndOfCycle: true, cancelAtPeriodEnd: true },
      plan: establishedCurrentPlan,
    });
    test.database.billingPlan.findUnique.mockResolvedValueOnce(establishedCurrentPlan);
    const publishDue = vi.spyOn(shopifyUsageEventPublisherService, "publishDue").mockResolvedValue(undefined);

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", insideDrain));

    expect(runtimeConfigReader.current).toHaveBeenCalledOnce();
    expect(publishDue).toHaveBeenCalledWith({ billingPeriodId: "period-current", runtimeConfig });
    publishDue.mockRestore();
  });

  it("uses the captured frozen interval for provider failures", async () => {
    const runtimeConfig = { ...defaultRuntimeConfig, billingFrozenRecheckSeconds: 15 };
    const test = harness({
      runtimeConfig,
      row: establishedRow({ subscription: { ...establishedRow().subscription, status: "FROZEN", nextReconcileAt: now } }),
      providerError: new Error("timeout"),
      plan: establishedCurrentPlan,
    });
    test.database.billingPlan.findUnique.mockResolvedValueOnce(establishedCurrentPlan);

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now));

    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ nextReconcileAt: new Date("2026-09-12T12:00:15.000Z") }),
    }));
  });

  it("projects scheduled full cancellation without changing current entitlement", async () => {
    const row = cycleRow({ subscription: { ...cycleRow().subscription, status: "ACTIVE", planId: "plan-current", pendingPlanId: null, pendingShopifyPlanHandle: null, pendingEffectiveAt: null, billingPeriodId: "period-current", currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"), cancelAtPeriodEnd: false } });
    const provider = { ...establishedProvider, planHandle: "paid-current", usageEventHandles: ["recovery-current"], pendingPlanHandle: null, pendingEffectiveAt: null, cancelAtPeriodEnd: true, currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z") };
    const test = harness({ row, providerResult: provider, plan: establishedCurrentPlan });
    test.database.billingPlan.findUnique.mockResolvedValueOnce(establishedCurrentPlan);
    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now));

    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ cancelAtPeriodEnd: true, currentPeriodEnd: provider.currentPeriodEnd }) }));
    expect(test.database.subscription.updateMany.mock.calls[0][0].data).not.toHaveProperty("planId");
    expect(test.transaction.billingPeriod.update).not.toHaveBeenCalled();
    expect(test.transaction.billingPeriodEntitlementCounter.findUnique).not.toHaveBeenCalled();
    expect(test.transaction.billingPeriodEntitlementCounter.create).not.toHaveBeenCalled();
  });

  it("clears reversed scheduled cancellation without granting entitlement", async () => {
    const row = cycleRow({ subscription: { ...cycleRow().subscription, status: "ACTIVE", planId: "plan-current", pendingPlanId: null, pendingShopifyPlanHandle: null, pendingEffectiveAt: null, billingPeriodId: "period-current", currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"), cancelAtPeriodEnd: true } });
    const provider = { ...establishedProvider, planHandle: "paid-current", usageEventHandles: ["recovery-current"], pendingPlanHandle: null, pendingEffectiveAt: null, cancelAtPeriodEnd: false, currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z") };
    const test = harness({ row, providerResult: provider, plan: establishedCurrentPlan });
    test.database.billingPlan.findUnique.mockResolvedValueOnce(establishedCurrentPlan);
    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now));

    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ cancelAtPeriodEnd: false }) }));
    expect(test.transaction.billingPeriod.update).not.toHaveBeenCalled();
    expect(test.queue.add).toHaveBeenCalledOnce();
  });

  it("reconstructs a missing FROZEN reconciliation job with one deterministic identity", async () => {
    const next = new Date("2026-09-12T13:00:00.000Z");
    const row = { id: "shop-1", status: "ACTIVE", onboardingCompleted: true, subscription: { id: "subscription-1", status: "FROZEN", planId: "plan-current", billingPeriodId: "period-current", pendingPlanId: null, pendingShopifyPlanHandle: null, pendingEffectiveAt: null, nextReconcileAt: next, plan: { active: true, kind: "PAID_METERED" } } };
    const test = harness({ nowValue: now });
    test.database.shop.findMany.mockResolvedValue([row]);
    await test.service.reconstruct();
    await test.service.reconstruct();
    expect(test.queue.add).toHaveBeenCalledTimes(2);
    expect(test.queue.add.mock.calls[0][1].expectedNextReconcileAt).toBe(next.toISOString());
    expect(test.queue.add.mock.calls[0][2].jobId).toBe(test.queue.add.mock.calls[1][2].jobId);
  });

  it("does not reconcile a pending top-up as spendable while lifecycle remains FROZEN", async () => {
    const row = establishedRow({ subscription: { ...establishedRow().subscription, status: "FROZEN", nextReconcileAt: now } });
    const test = harness({ row, providerResult: null, plan: establishedCurrentPlan });
    test.database.billingPlan.findUnique.mockResolvedValueOnce(establishedCurrentPlan);
    test.partner.getSubscriptionReconciliationSnapshot.mockResolvedValue({ activeSubscription: null, latestLifecycleEvent: { id: "event-frozen", eventType: "SUBSCRIPTION_FROZEN", state: "FROZEN", occurredAt: new Date("2026-09-12T11:00:00.000Z"), cancelEffectiveOn: null, planHandle: "paid-current", billingPeriod: "2026-09-01/2026-10-01" } });
    test.transaction.subscription.findUnique.mockResolvedValue({ status: "FROZEN", lastProviderLifecycleEventAt: null, lastProviderLifecycleEventId: null });
    test.database.subscription.findUnique.mockResolvedValue({ nextReconcileAt: new Date("2026-09-12T13:00:00.000Z") });

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now));

    expect(test.transaction.recoveryCreditPurchase.update).not.toHaveBeenCalled();
    expect(test.transaction.recoveryCreditPurchase.create).not.toHaveBeenCalled();
    expect(test.queue.add).toHaveBeenCalledOnce();
  });

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
    const test = harness({ row: pendingRow({ status: "UNINSTALLED", reinstallPendingAt: null }) });
    await test.service.reconcileJob(payload);
    expect(test.partner.getActiveSubscription).not.toHaveBeenCalled();
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

  it("provider null preserves all detached history and credit state", async () => {
    const test = harness({ row: pendingRow({ status: "UNINSTALLED", reinstallPendingAt: new Date("2026-09-12T11:30:00.000Z") }), providerResult: null });
    test.transaction.billingPeriodEntitlementCounter = {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    };

    await test.service.reconcileJob(payload);

    expect(test.transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "NO_CONTRACT", planId: null, billingPeriodId: null, pendingPlanId: null, nextReconcileAt: null }),
    }));
    expect(test.transaction.shopSettings.update).not.toHaveBeenCalled();
    expect(test.transaction.shop.update).toHaveBeenCalledWith({ where: { id: "shop-1" }, data: { status: "ACTIVE", uninstalledAt: null, reinstallPendingAt: null } });
    expectNoModelMutations(test.transaction.billingPeriod);
    expectNoModelMutations(test.transaction.billingPeriodEntitlementCounter);
    expectNoModelMutations(test.transaction.shopEntitlementCounter);
    expectNoModelMutations(test.transaction.recoveryCreditPurchase);
    expectNoModelMutations(test.transaction.recoveryCreditRefund);
    expectNoModelMutations(test.transaction.promotionalCreditGrant);
    expectNoModelMutations(test.transaction.merchantPromotionSelection);
  });

  it("verified Free preserves every existing lifetime quantity", async () => {
    const lifetimeCounter = { id: "lifetime-1", grantedQuantity: 9, committedQuantity: 3, reservedQuantity: 2, forfeitedQuantity: 1 };
    const test = harness({
      row: pendingRow({ status: "UNINSTALLED", reinstallPendingAt: new Date("2026-09-12T11:30:00.000Z") }),
      providerResult: freeProvider,
      plan: { id: "plan-free", name: "Free", active: true, kind: "FREE", recoveryCreditPackEnabled: false },
      lifetimeCounter,
    });

    await test.service.reconcileJob(payload);

    expect(lifetimeCounter).toEqual({ id: "lifetime-1", grantedQuantity: 9, committedQuantity: 3, reservedQuantity: 2, forfeitedQuantity: 1 });
    expect(test.transaction.shopEntitlementCounter.create).not.toHaveBeenCalled();
    expect(test.transaction.shopEntitlementCounter.upsert).not.toHaveBeenCalled();
    expect(test.transaction.shopEntitlementCounter.update).not.toHaveBeenCalled();
  });

  it("Free pending handle without an active local mapping keeps provider projection", async () => {
    const pendingAt = new Date("2026-10-01T00:00:00.000Z");
    const test = harness({
      row: pendingRow({ status: "UNINSTALLED", reinstallPendingAt: new Date("2026-09-12T11:30:00.000Z") }),
      providerResult: { ...freeProvider, pendingPlanHandle: "future-free", pendingEffectiveAt: pendingAt },
      plan: { id: "plan-free", name: "Free", active: true, kind: "FREE", recoveryCreditPackEnabled: false },
    });
    test.transaction.billingPlan.findUnique.mockResolvedValue(null);

    await test.service.reconcileJob(payload);

    expect(test.transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ pendingShopifyPlanHandle: "future-free", pendingPlanId: null, pendingEffectiveAt: pendingAt }),
    }));
  });
});
