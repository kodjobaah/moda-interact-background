import { describe, expect, it } from "vitest";

import { GenericSubscriptionProjectionService } from "../../../../src/services/billing-reconciliation/generic-subscription-projection.service.js";
import { classifyObservedPlanProjection } from "../../../../src/services/billing-reconciliation/observed-plan-projection.js";
import {
  cycleEnd,
  cycleStart,
  emptySubscription,
  freePlan,
  now,
  paidPlan,
  provider,
  serviceHarness,
  transactionHarness,
} from "./generic-subscription-projection.test-support.js";

describe("GenericSubscriptionProjectionService", () => {
  it.each([
    ["Free", freePlan, { ...provider, planHandle: "free-2026", usageEventHandles: [] }],
    ["Paid", paidPlan, provider],
  ] as const)("materialises a missing local %s projection in one transaction", async (_label, plan, observedProvider) => {
    const transaction = transactionHarness();
    const test = serviceHarness(transaction);
    if (plan.kind === "FREE") {
      transaction.shopEntitlementCounter.findUnique.mockResolvedValue(null);
    }
    const service = new GenericSubscriptionProjectionService(
      test.database as never,
      test.scheduler,
      test.logger as never,
    );

    const result = await service.reconcile({
      shopId: "shop-1",
      provider: observedProvider,
      plan,
      existing: null,
      projection: classifyObservedPlanProjection(observedProvider, plan),
      now,
    });

    expect(result.billingPeriodId).toBe("period-1");
    expect(transaction.subscription.upsert).toHaveBeenCalledWith({
      where: { shopId: "shop-1" },
      update: {},
      create: { shopId: "shop-1", status: "NO_CONTRACT" },
    });
    expect(transaction.billingPeriod.create).toHaveBeenCalledOnce();
    expect(transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ planId: plan.id, status: "ACTIVE", billingPeriodId: "period-1" }),
    }));
    if (plan.kind === "FREE") {
      expect(transaction.shopEntitlementCounter.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({ grantedQuantity: 5 }),
      }));
      expect(transaction.billingPeriodEntitlementCounter.create).not.toHaveBeenCalled();
    } else {
      expect(transaction.billingPeriodEntitlementCounter.create).toHaveBeenCalledOnce();
    }
  });

  it("fails closed and schedules another observation when a mapped provider has no billing cycle", async () => {
    const transaction = transactionHarness();
    const test = serviceHarness(transaction);
    const observedProvider = { ...provider, currentPeriodStart: null, currentPeriodEnd: null };
    const service = new GenericSubscriptionProjectionService(test.database as never, test.scheduler, test.logger as never);

    const result = await service.reconcile({
      shopId: "shop-1",
      provider: observedProvider,
      plan: freePlan,
      existing: null,
      projection: classifyObservedPlanProjection(observedProvider, freePlan),
      now,
    });

    expect(result).toEqual({ billingPeriodId: null, packMeterHandle: null });
    expect(transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "SYNC_ERROR",
        lastSyncErrorCode: "MISSING_BILLING_CYCLE",
        nextReconcileAt: new Date("2026-09-12T12:01:00.000Z"),
      }),
    }));
    expect(transaction.billingPeriod.create).not.toHaveBeenCalled();
    expect(test.scheduler.enqueue).toHaveBeenCalledOnce();
  });

  it("persists an unmapped provider plan without creating a billing period", async () => {
    const test = serviceHarness();
    const service = new GenericSubscriptionProjectionService(test.database as never, test.scheduler, test.logger as never);

    const result = await service.reconcile({
      shopId: "shop-1",
      provider: { ...provider, planHandle: "unknown-plan" },
      plan: null,
      existing: null,
      projection: classifyObservedPlanProjection({ ...provider, planHandle: "unknown-plan" }, null),
      now,
    });

    expect(result).toEqual({ billingPeriodId: null, packMeterHandle: null });
    expect(test.database.subscription.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        planId: null,
        status: "UNMAPPED",
        observedShopifyPlanHandle: "unknown-plan",
        lastSyncErrorCode: "UNMAPPED_PLAN_HANDLE",
      }),
    }));
    expect(test.database.$transaction).not.toHaveBeenCalled();
  });

  it("retains the mapped plan but fails closed when the provider omits its required usage meter", async () => {
    const test = serviceHarness();
    const service = new GenericSubscriptionProjectionService(test.database as never, test.scheduler, test.logger as never);
    const observedProvider = { ...provider, usageEventHandles: ["pack-meter"] };

    const result = await service.reconcile({
      shopId: "shop-1",
      provider: observedProvider,
      plan: paidPlan,
      existing: null,
      projection: classifyObservedPlanProjection(observedProvider, paidPlan),
      now,
    });

    expect(result).toEqual({ billingPeriodId: null, packMeterHandle: "pack-meter" });
    expect(test.database.subscription.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        planId: "plan-paid",
        status: "SYNC_ERROR",
        lastSyncErrorCode: "MISSING_USAGE_METER",
      }),
    }));
  });

  it("does not recreate lifetime Free capacity after historical recovery usage", async () => {
    const transaction = transactionHarness();
    transaction.shopEntitlementCounter.findUnique.mockResolvedValue(null);
    transaction.usageEvent.count.mockResolvedValue(1);
    const test = serviceHarness(transaction);
    const service = new GenericSubscriptionProjectionService(test.database as never, test.scheduler, test.logger as never);

    const result = await service.reconcile({
      shopId: "shop-1",
      provider,
      plan: paidPlan,
      existing: null,
      projection: classifyObservedPlanProjection(provider, paidPlan),
      now,
    });

    expect(result).toEqual({ billingPeriodId: null, packMeterHandle: null });
    expect(transaction.shopEntitlementCounter.upsert).not.toHaveBeenCalled();
    expect(transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
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

  it("schedules a retry when the billing-period projection conflicts", async () => {
    const existing = emptySubscription({
      status: "ACTIVE",
      planId: "plan-old",
      billingPeriodId: "period-old",
      currentPeriodStart: cycleStart,
      currentPeriodEnd: cycleEnd,
    });
    const transaction = transactionHarness(existing);
    transaction.billingPeriod.findUnique.mockResolvedValue({
      id: "period-conflict",
      shopId: "shop-1",
      subscriptionId: existing.id,
      periodStart: cycleStart,
      periodEnd: cycleEnd,
      status: "OPEN",
      planId: "different-plan",
      shopifyPlanHandleSnapshot: "other-plan",
      planNameSnapshot: "Other",
      planKindSnapshot: "PAID_METERED",
      includedRecoveryCreditsGranted: 100,
    });
    const test = serviceHarness(transaction);
    const service = new GenericSubscriptionProjectionService(test.database as never, test.scheduler, test.logger as never);

    const result = await service.reconcile({
      shopId: "shop-1",
      provider,
      plan: paidPlan,
      existing,
      projection: classifyObservedPlanProjection(provider, paidPlan),
      now,
    });

    expect(result).toEqual({ billingPeriodId: null, packMeterHandle: null });
    expect(transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "SYNC_ERROR",
        lastSyncErrorCode: "BILLING_PERIOD_PLAN_CONFLICT",
        nextReconcileAt: new Date("2026-09-12T12:01:00.000Z"),
      }),
    }));
    expect(test.scheduler.enqueue).toHaveBeenCalledOnce();
  });
});
