import { describe, expect, it, vi } from "vitest";
import { SamePlanBillingPeriodRolloverService } from "../../../../src/services/same-plan-billing-period-rollover.service.js";
import { now, pendingEffectiveAt, harness, pendingRow, freeProvider, paidPlan, payload, cycleRow, cyclePlan } from "./facade-test-fixtures.js";

describe("BillingSubscriptionReconciliationService", () => {
  it("reconstructs only active pending rows and preserves overdue work as immediate jobs", async () => {
    const row = pendingRow({ subscription: { ...pendingRow().subscription, nextReconcileAt: new Date("2026-09-12T11:00:00.000Z") } });
    const test = harness({ nowValue: new Date("2026-09-30T00:00:00.000Z") });
    test.database.shop.findMany.mockResolvedValue([row]);
    const count = await test.service.reconstruct();
    expect(count).toBe(1);
    expect(test.database.shop.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ AND: expect.any(Array) }),
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

  it("reconstructs a pending reinstall without contacting Shopify", async () => {
    const next = new Date("2026-09-12T12:05:00.000Z");
    const row = pendingRow({ status: "UNINSTALLED", reinstallPendingAt: new Date("2026-09-12T11:30:00.000Z"), subscription: { ...pendingRow().subscription, nextReconcileAt: next } });
    const test = harness({ nowValue: now });
    test.database.shop.findMany.mockResolvedValue([row]);

    await expect(test.service.reconstruct()).resolves.toBe(1);

    expect(test.partner.getActiveSubscription).not.toHaveBeenCalled();
    expect(test.queue.add).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      shopId: "shop-1", subscriptionId: "subscription-1", expectedNextReconcileAt: next.toISOString(),
    }), expect.objectContaining({ delay: 5 * 60 * 1000 }));
  });

  it("reconstructs a missing pack-enabled Free cycle job deterministically", async () => {
    const next = new Date("2026-09-30T23:55:00.000Z");
    const row = {
      id: "shop-1",
      status: "ACTIVE",
      onboardingCompleted: true,
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

  it("excludes pack-disabled Free subscriptions from cycle reconstruction", async () => {
    const test = harness();
    await test.service.reconstruct();
    const query = test.database.shop.findMany.mock.calls[0]?.[0] as { where: unknown };
    const serialized = JSON.stringify(query.where);
    expect(serialized).toContain('"kind":"PAID_METERED"');
    expect(serialized).toContain('"kind":"FREE","recoveryCreditPackEnabled":true');
    expect(serialized).not.toContain('"kind":"FREE","recoveryCreditPackEnabled":false');
  });

  it("excludes rows without a pending target or durable schedule", async () => {
    const test = harness();
    await test.service.reconstruct();
    expect(test.database.shop.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ AND: expect.any(Array) }),
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
    expect(test.transaction.billingPeriod.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ includedRecoveryCreditsGranted: null }) }));
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

  it("publishes deterministic jobs with failed-job removal enabled", async () => {
    const test = harness({ row: pendingRow(), providerResult: null });
    await test.service.reconcileJob(payload);
    expect(test.queue.add).toHaveBeenCalledWith(expect.any(String), expect.any(Object), expect.objectContaining({ jobId: expect.any(String), removeOnFail: true, removeOnComplete: 100 }));
  });
});
