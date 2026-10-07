import { describe, expect, it } from "vitest";

import { SamePlanCurrentCycleReconciliationService } from "../../../../src/services/billing-reconciliation/same-plan-current-cycle-reconciliation.service.js";
import {
  currentCycleTransaction,
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
  const existing = existingSubscription({
    status: "SYNC_ERROR",
    planId: freePlan.id,
    nextReconcileAt: cycleEnd,
  });
  const transaction = currentCycleTransaction(existing);
  transaction.billingPeriod.findUnique.mockResolvedValue({
    id: "period-1",
    shopId: "shop-1",
    subscriptionId: existing.id,
    planId: freePlan.id,
    shopifyPlanHandleSnapshot: freePlan.shopifyPlanHandle,
    planNameSnapshot: freePlan.name,
    planKindSnapshot: freePlan.kind,
    includedRecoveryCreditsGranted: null,
    periodStart: cycleStart,
    periodEnd: cycleEnd,
    status: "OPEN",
  });
  transaction.billingPeriodEntitlementCounter.findUnique.mockResolvedValue(null);
  const database = {
    $transaction: async (callback: (value: typeof transaction) => unknown) => callback(transaction),
  };
  const { scheduler, logger } = serviceDependencies();
  const service = new SamePlanCurrentCycleReconciliationService(database as never, scheduler, logger as never);
  return { service, existing, transaction, scheduler, logger };
}

describe("SamePlanCurrentCycleReconciliationService", () => {
  it("repairs the current cycle and clears a stale sync error", async () => {
    const test = harness();

    const result = await test.service.reconcile({
      shopId: "shop-1",
      provider: { ...provider, planHandle: freePlan.shopifyPlanHandle, usageEventHandles: [] },
      plan: freePlan,
      existing: test.existing,
      now,
      status: "ACTIVE",
      syncErrorCode: null,
    });

    expect(result).toEqual({ kind: "continue" });
    expect(test.transaction.subscription.update).toHaveBeenCalledWith({
      where: { id: "subscription-1" },
      data: expect.objectContaining({
        status: "ACTIVE",
        observedShopifyPlanHandle: "free-2026",
        lastSyncErrorCode: null,
        lastSyncErrorAt: null,
      }),
    });
  });

  it("repairs a missing lifetime Free counter when no recovery history exists", async () => {
    const test = harness();
    test.transaction.shopEntitlementCounter.findUnique.mockResolvedValue(null);

    await test.service.reconcile({
      shopId: "shop-1",
      provider: { ...provider, planHandle: freePlan.shopifyPlanHandle, usageEventHandles: [] },
      plan: freePlan,
      existing: test.existing,
      now,
      status: "ACTIVE",
      syncErrorCode: null,
    });

    expect(test.transaction.shopEntitlementCounter.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        counter: "LIFETIME_FREE_RECOVERY_CREDITS",
        grantedQuantity: 5,
      }),
    }));
  });

  it("repairs a missing Paid included-credit counter before period progression", async () => {
    const test = harness();
    const existing = existingSubscription({ status: "ACTIVE", planId: paidPlan.id, nextReconcileAt: null });
    test.transaction.subscription.findUnique.mockResolvedValue(existing);
    test.transaction.billingPeriod.findUnique.mockResolvedValue({
      id: "period-1",
      shopId: "shop-1",
      subscriptionId: existing.id,
      planId: paidPlan.id,
      shopifyPlanHandleSnapshot: paidPlan.shopifyPlanHandle,
      planNameSnapshot: paidPlan.name,
      planKindSnapshot: paidPlan.kind,
      includedRecoveryCreditsGranted: 100,
      periodStart: cycleStart,
      periodEnd: cycleEnd,
      status: "OPEN",
    });
    test.transaction.billingPeriodEntitlementCounter.findUnique.mockResolvedValue(null);

    const result = await test.service.reconcile({
      shopId: "shop-1",
      provider,
      plan: paidPlan,
      existing,
      now,
      status: "ACTIVE",
      syncErrorCode: null,
    });

    expect(result).toEqual({ kind: "continue" });
    expect(test.transaction.billingPeriodEntitlementCounter.create).toHaveBeenCalledWith({
      data: {
        shopId: "shop-1",
        billingPeriodId: "period-1",
        counter: "INCLUDED_RECOVERY_CREDITS",
        grantedQuantity: 100,
        committedQuantity: 0,
        reservedQuantity: 0,
        forfeitedQuantity: 0,
      },
    });
  });

  it("fails closed when historical recovery usage makes lifetime counter repair ambiguous", async () => {
    const test = harness();
    test.transaction.shopEntitlementCounter.findUnique.mockResolvedValue(null);
    test.transaction.usageEvent.count.mockResolvedValue(1);

    const result = await test.service.reconcile({
      shopId: "shop-1",
      provider: { ...provider, planHandle: freePlan.shopifyPlanHandle, usageEventHandles: [] },
      plan: freePlan,
      existing: test.existing,
      now,
      status: "ACTIVE",
      syncErrorCode: null,
    });

    expect(result).toEqual({ kind: "handled", billingPeriodId: "period-1", packMeterHandle: null });
    expect(test.transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "SYNC_ERROR",
        lastSyncErrorCode: "LIFETIME_FREE_COUNTER_HISTORY_CONFLICT",
        nextReconcileAt: null,
      }),
    }));
    expect(test.logger.warn).toHaveBeenCalledWith(
      "billing.subscription_reconciliation.lifetime_free_counter_history_conflict",
      { shopId: "shop-1" },
    );
  });

  it("persists and schedules a billing-period conflict", async () => {
    const test = harness();
    test.transaction.billingPeriod.findUnique.mockResolvedValue({
      id: "period-1",
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      planId: "another-plan",
      shopifyPlanHandleSnapshot: "other",
      planNameSnapshot: "Other",
      planKindSnapshot: "FREE",
      includedRecoveryCreditsGranted: null,
      periodStart: cycleStart,
      periodEnd: cycleEnd,
      status: "OPEN",
    });

    const result = await test.service.reconcile({
      shopId: "shop-1",
      provider: { ...provider, planHandle: freePlan.shopifyPlanHandle, usageEventHandles: [] },
      plan: freePlan,
      existing: test.existing,
      now,
      status: "ACTIVE",
      syncErrorCode: null,
    });

    const next = new Date("2026-09-12T12:01:00.000Z");
    expect(result).toEqual({ kind: "handled", billingPeriodId: "period-1", packMeterHandle: null });
    expect(test.transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "SYNC_ERROR",
        lastSyncErrorCode: "BILLING_PERIOD_PLAN_CONFLICT",
        nextReconcileAt: next,
      }),
    }));
    expect(test.scheduler.enqueue).toHaveBeenCalledWith("shop-1", "subscription-1", next, now);
  });

  it("leaves a different provider cycle for the period progression service", async () => {
    const test = harness();

    const result = await test.service.reconcile({
      shopId: "shop-1",
      provider: {
        ...provider,
        planHandle: freePlan.shopifyPlanHandle,
        usageEventHandles: [],
        currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z"),
      },
      plan: freePlan,
      existing: test.existing,
      now,
      status: "ACTIVE",
      syncErrorCode: null,
    });

    expect(result).toEqual({ kind: "continue" });
    expect(test.transaction.$queryRaw).not.toHaveBeenCalled();
  });
});
