import { describe, expect, it, vi } from "vitest";

import { SamePlanPeriodProgressionService } from "../../../../src/services/billing-reconciliation/same-plan-period-progression.service.js";
import {
  cycleEnd,
  cycleStart,
  existingSubscription,
  freePlan,
  now,
  paidPlan,
  provider,
  serviceDependencies,
} from "./same-plan-reconciliation.test-support.js";

function harness() {
  const database = {
    $transaction: vi.fn(),
    billingPlan: { findUnique: vi.fn().mockResolvedValue({ id: "plan-next", active: true }) },
    subscription: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue({ billingPeriodId: "period-1" }),
    },
  };
  const { scheduler, logger, capacityResume } = serviceDependencies();
  const rollover = { transition: vi.fn().mockResolvedValue({ kind: "unchanged", billingPeriodId: "period-1", nextReconcileAt: null }) };
  const service = new SamePlanPeriodProgressionService(
    database as never,
    scheduler,
    logger as never,
    capacityResume,
    rollover as never,
  );
  return { service, database, scheduler, logger, capacityResume, rollover };
}

describe("SamePlanPeriodProgressionService", () => {
  it("persists an observed future plan intent and schedules its effective boundary", async () => {
    const test = harness();
    const effectiveAt = new Date("2026-09-25T00:00:00.000Z");
    const existing = existingSubscription({ planId: paidPlan.id });

    const result = await test.service.reconcile({
      shopId: "shop-1",
      provider: { ...provider, pendingPlanHandle: "pro-next", pendingEffectiveAt: effectiveAt },
      plan: paidPlan,
      existing,
      now,
    });

    expect(result).toEqual({ billingPeriodId: "period-1", packMeterHandle: "pack-meter" });
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith({
      where: {
        id: "subscription-1",
        planId: paidPlan.id,
        billingPeriodId: "period-1",
        nextReconcileAt: null,
      },
      data: expect.objectContaining({
        pendingShopifyPlanHandle: "pro-next",
        pendingPlanId: "plan-next",
        pendingEffectiveAt: effectiveAt,
        cancelAtPeriodEnd: false,
        nextReconcileAt: effectiveAt,
      }),
    });
    expect(test.scheduler.enqueue).toHaveBeenCalledWith("shop-1", "subscription-1", effectiveAt, now);
    expect(test.rollover.transition).not.toHaveBeenCalled();
  });

  it("uses the drain boundary for same-plan cancellation", async () => {
    const test = harness();
    const existing = existingSubscription({ planId: paidPlan.id, cancelAtPeriodEnd: true });
    const drainBoundary = new Date("2026-09-30T23:55:00.000Z");

    await test.service.reconcile({
      shopId: "shop-1",
      provider: { ...provider, cancelAtPeriodEnd: true },
      plan: paidPlan,
      existing,
      now,
    });

    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        pendingShopifyPlanHandle: null,
        pendingPlanId: null,
        cancelAtPeriodEnd: true,
        nextReconcileAt: drainBoundary,
      }),
    }));
    expect(test.scheduler.enqueue).toHaveBeenCalledWith("shop-1", "subscription-1", drainBoundary, now);
  });

  it("returns the canonical successor and resumes paid recovery capacity", async () => {
    const test = harness();
    test.rollover.transition.mockResolvedValue({
      kind: "transitioned",
      billingPeriodId: "period-successor",
      nextReconcileAt: null,
      planKind: "PAID_METERED",
    });

    const result = await test.service.reconcile({
      shopId: "shop-1",
      provider: {
        ...provider,
        currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z"),
      },
      plan: paidPlan,
      existing: existingSubscription({ planId: paidPlan.id }),
      now,
    });

    expect(result).toEqual({ billingPeriodId: "period-successor", packMeterHandle: "pack-meter" });
    expect(test.capacityResume.schedule).toHaveBeenCalledWith({
      shopId: "shop-1",
      trigger: "billing-period-rollover",
    });
  });

  it("isolates recovery-capacity resume failure after a committed paid rollover", async () => {
    const test = harness();
    test.rollover.transition.mockResolvedValue({
      kind: "transitioned",
      billingPeriodId: "period-successor",
      nextReconcileAt: null,
      planKind: "PAID_METERED",
    });
    test.capacityResume.schedule.mockRejectedValue(new Error("queue unavailable"));

    await expect(test.service.reconcile({
      shopId: "shop-1",
      provider: { ...provider, currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z") },
      plan: paidPlan,
      existing: existingSubscription({ planId: paidPlan.id }),
      now,
    })).resolves.toEqual({ billingPeriodId: "period-successor", packMeterHandle: "pack-meter" });
    expect(test.logger.warn).toHaveBeenCalledWith(
      "billing.recovery_capacity_resume.enqueue_failed",
      { shopId: "shop-1", errorMessage: "queue unavailable" },
    );
  });

  it.each([
    ["Paid", paidPlan, "period-paid"],
    ["pack-enabled Free", { ...freePlan, recoveryCreditPackEnabled: true, shopifyRecoveryCreditPackEventHandle: "pack-meter" }, "period-free"],
  ])("persists and schedules rotating provider-cycle lag for %s", async (_label, plan, billingPeriodId) => {
    const test = harness();
    const retryNow = new Date("2026-10-01T00:00:01.000Z");
    const existing = existingSubscription({
      planId: plan.id,
      billingPeriodId,
      nextReconcileAt: null,
    });
    test.rollover.transition.mockResolvedValue({ kind: "provider-cycle-lag", billingPeriodId, nextReconcileAt: null });
    test.database.subscription.findUnique.mockResolvedValue({ billingPeriodId });

    const result = await test.service.reconcile({
      shopId: "shop-1",
      provider: { ...provider, planHandle: plan.shopifyPlanHandle, currentPeriodStart: cycleStart, currentPeriodEnd: cycleEnd },
      plan,
      existing,
      now: retryNow,
    });

    const next = new Date("2026-10-01T00:01:01.000Z");
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "subscription-1", billingPeriodId, nextReconcileAt: null }),
      data: expect.objectContaining({ nextReconcileAt: next, lastSyncErrorCode: "PROVIDER_CYCLE_LAG" }),
    }));
    expect(test.scheduler.enqueue).toHaveBeenCalledWith("shop-1", "subscription-1", next, retryNow);
    expect(result.billingPeriodId).toBe(billingPeriodId);
  });

  it("does not schedule provider-cycle lag for pack-disabled Free", async () => {
    const test = harness();
    const existing = existingSubscription({ planId: freePlan.id });
    test.rollover.transition.mockResolvedValue({ kind: "provider-cycle-lag", billingPeriodId: "period-1", nextReconcileAt: cycleEnd });

    await test.service.reconcile({
      shopId: "shop-1",
      provider: { ...provider, planHandle: freePlan.shopifyPlanHandle, usageEventHandles: [] },
      plan: freePlan,
      existing,
      now: new Date("2026-10-01T00:00:01.000Z"),
    });

    expect(test.database.subscription.updateMany).not.toHaveBeenCalled();
    expect(test.scheduler.enqueue).not.toHaveBeenCalled();
  });

  it("reads the durable period when canonical rollover is not applicable", async () => {
    const test = harness();
    test.rollover.transition.mockResolvedValue({ kind: "not-applicable" });
    test.database.subscription.findUnique.mockResolvedValue({ billingPeriodId: "period-durable" });

    const result = await test.service.reconcile({
      shopId: "shop-1",
      provider,
      plan: paidPlan,
      existing: existingSubscription({ planId: paidPlan.id }),
      now,
    });

    expect(result).toEqual({ billingPeriodId: "period-durable", packMeterHandle: "pack-meter" });
  });
});
