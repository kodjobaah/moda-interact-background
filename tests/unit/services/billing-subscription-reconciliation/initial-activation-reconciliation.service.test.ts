import { describe, expect, it, vi } from "vitest";
import { BillingPlanKind, BillingPeriodStatus, SubscriptionProjectionStatus } from "@prisma/client";

import { InitialActivationReconciliationService } from "../../../../src/services/billing-subscription-reconciliation/initial-activation-reconciliation.service.js";
import { ReconciliationQueueService } from "../../../../src/services/billing-subscription-reconciliation/reconciliation-queue.service.js";
import type { InitialActivationExpected } from "../../../../src/services/billing-subscription-reconciliation/classification.js";

const now = new Date("2026-10-03T12:00:00.000Z");
const expected: InitialActivationExpected = {
  subscriptionId: "subscription-1",
  pendingPlanId: "plan-paid",
  pendingShopifyPlanHandle: "paid-2026",
  pendingEffectiveAt: new Date("2026-10-03T11:00:00.000Z"),
  nextReconcileAt: now,
};

const provider = {
  planHandle: "paid-2026",
  usageEventHandles: ["recovery-meter"],
  pendingPlanHandle: null,
  pendingEffectiveAt: null,
  status: "ACTIVE" as const,
  currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"),
  currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z"),
  trialEndsAt: null,
  cancelAtPeriodEnd: false,
  providerSubscriptionId: "provider-subscription-1",
  providerUsageSnapshot: [],
};

const paidPlan = {
  id: "plan-paid",
  active: true,
  name: "Paid",
  kind: BillingPlanKind.PAID_METERED,
  shopifyPlanHandle: "paid-2026",
  shopifyUsageEventHandle: "recovery-meter",
  includedRecoveryConversationAllowance: 100,
};

function harness({
  current = {
    status: SubscriptionProjectionStatus.NO_CONTRACT,
    planId: null,
    pendingPlanId: expected.pendingPlanId,
    pendingShopifyPlanHandle: expected.pendingShopifyPlanHandle,
    pendingEffectiveAt: expected.pendingEffectiveAt,
    nextReconcileAt: expected.nextReconcileAt,
  },
  updateCount = 1,
  currentPlan = paidPlan,
  period = null,
  periodCounter = null,
  lifetimeCounter = null,
} = {}) {
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    subscription: {
      findUnique: vi.fn().mockResolvedValue(current),
      update: vi.fn().mockResolvedValue({}),
    },
    billingPlan: { findUnique: vi.fn().mockResolvedValue(currentPlan) },
    billingPeriod: {
      findUnique: vi.fn().mockResolvedValue(period),
      create: vi.fn().mockResolvedValue({ id: "period-1" }),
      update: vi.fn().mockResolvedValue({}),
    },
    billingPeriodEntitlementCounter: {
      findUnique: vi.fn().mockResolvedValue(periodCounter),
      create: vi.fn().mockResolvedValue({}),
      upsert: vi.fn().mockResolvedValue({}),
    },
    shopEntitlementCounter: {
      findUnique: vi.fn().mockResolvedValue(lifetimeCounter),
      create: vi.fn().mockResolvedValue({}),
      upsert: vi.fn().mockResolvedValue({}),
    },
    platformBillingPolicy: {
      findUnique: vi.fn().mockResolvedValue({ lifetimeFreeRecoveryAllowance: 7 }),
    },
    shopSettings: { update: vi.fn().mockResolvedValue({}) },
  };
  const database = {
    subscription: { updateMany: vi.fn().mockResolvedValue({ count: updateCount }) },
    $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)),
  };
  const reconciliationQueue = { publishNext: vi.fn().mockResolvedValue(undefined) };
  const discountPublisher = { publishDiscountSync: vi.fn().mockResolvedValue(undefined) };
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  const service = new InitialActivationReconciliationService(
    database as never,
    reconciliationQueue,
    discountPublisher,
    logger as never,
    () => now,
  );
  return { database, transaction, reconciliationQueue, discountPublisher, logger, service };
}

describe("InitialActivationReconciliationService", () => {
  it("uses the pending-state CAS and schedules a missing subscription retry", async () => {
    const test = harness();

    await test.service.recordMissingSubscription("shop-1", expected);

    expect(test.database.subscription.updateMany).toHaveBeenCalledWith({
      where: {
        id: expected.subscriptionId,
        status: SubscriptionProjectionStatus.NO_CONTRACT,
        planId: null,
        pendingPlanId: expected.pendingPlanId,
        pendingShopifyPlanHandle: expected.pendingShopifyPlanHandle,
        pendingEffectiveAt: expected.pendingEffectiveAt,
        nextReconcileAt: expected.nextReconcileAt,
      },
      data: expect.objectContaining({ status: SubscriptionProjectionStatus.NO_CONTRACT }),
    });
    expect(test.reconciliationQueue.publishNext).toHaveBeenCalledOnce();
  });

  it("does not schedule stale failed compare-and-set updates", async () => {
    const test = harness({ updateCount: 0 });

    await test.service.recordMissingSubscription("shop-1", expected);

    expect(test.reconciliationQueue.publishNext).not.toHaveBeenCalled();
  });

  it.each([
    ["missing cycle", { ...provider, currentPeriodStart: null }, paidPlan, "MISSING_BILLING_CYCLE"],
    ["missing usage meter", { ...provider, usageEventHandles: [] }, paidPlan, "MISSING_USAGE_METER"],
    ["invalid allowance", provider, { ...paidPlan, includedRecoveryConversationAllowance: null }, "INVALID_INCLUDED_ALLOWANCE"],
  ])("fails closed for a Paid activation with %s", async (_name, providerState, plan, errorCode) => {
    const test = harness();

    await test.service.completeVerifiedPaid("shop-1", expected.subscriptionId, providerState as never, plan as never, expected);

    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastSyncErrorCode: errorCode }),
    }));
    expect(test.database.$transaction).not.toHaveBeenCalled();
  });

  it("records unsupported future Paid trials without opening a billing period", async () => {
    const test = harness();
    const trialProvider = {
      ...provider,
      status: "TRIALING" as const,
      trialEndsAt: new Date("2026-10-04T00:00:00.000Z"),
      currentPeriodStart: null,
      currentPeriodEnd: null,
    };

    await test.service.completeVerifiedPaid("shop-1", expected.subscriptionId, trialProvider as never, paidPlan, expected);

    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastSyncErrorCode: "UNSUPPORTED_PAID_TRIAL", nextReconcileAt: null }),
    }));
    expect(test.logger.warn).toHaveBeenCalledWith("billing.subscription_reconciliation.unsupported_paid_trial", {
      shopId: "shop-1",
      subscriptionId: expected.subscriptionId,
    });
    expect(test.database.$transaction).not.toHaveBeenCalled();
  });

  it("commits Free activation, grants the lifetime counter once, and publishes post-commit work", async () => {
    const test = harness({ currentPlan: null });
    const freeProvider = { ...provider, planHandle: "free-2026", usageEventHandles: [] };

    await test.service.completeVerifiedFree(
      "shop-1",
      expected.subscriptionId,
      freeProvider as never,
      "plan-free",
      true,
      now.toISOString(),
      "Free",
      expected,
    );

    expect(test.transaction.$queryRaw).toHaveBeenCalledTimes(2);
    expect(test.transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ planId: "plan-free", status: SubscriptionProjectionStatus.ACTIVE, billingPeriodId: "period-1" }),
    }));
    expect(test.transaction.shopEntitlementCounter.upsert).toHaveBeenCalledOnce();
    expect(test.discountPublisher.publishDiscountSync).toHaveBeenCalledWith("shop-1", "SUBSCRIPTION_ACTIVATED");
    expect(test.reconciliationQueue.publishNext).toHaveBeenCalledOnce();
  });

  it("commits Paid activation and reuses an existing period and entitlement counter on replay", async () => {
    const existingPeriod = {
      id: "period-1",
      status: BillingPeriodStatus.OPEN,
      subscriptionId: expected.subscriptionId,
      planId: paidPlan.id,
      shopifyPlanHandleSnapshot: paidPlan.shopifyPlanHandle,
      planNameSnapshot: paidPlan.name,
      planKindSnapshot: BillingPlanKind.PAID_METERED,
      includedRecoveryCreditsGranted: 100,
    };
    const existingCounter = {
      shopId: "shop-1",
      billingPeriodId: "period-1",
      grantedQuantity: 100,
      committedQuantity: 0,
      reservedQuantity: 0,
      forfeitedQuantity: 0,
    };
    const test = harness({ period: existingPeriod, periodCounter: existingCounter, lifetimeCounter: { id: "lifetime-counter" } });

    await test.service.completeVerifiedPaid("shop-1", expected.subscriptionId, provider as never, paidPlan, expected);

    expect(test.transaction.billingPeriod.create).not.toHaveBeenCalled();
    expect(test.transaction.billingPeriodEntitlementCounter.create).not.toHaveBeenCalled();
    expect(test.transaction.billingPeriodEntitlementCounter.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
    expect(test.transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ planId: paidPlan.id, billingPeriodId: "period-1", status: SubscriptionProjectionStatus.ACTIVE }),
    }));
    expect(test.discountPublisher.publishDiscountSync).toHaveBeenCalledOnce();
  });

  it("converges an alternate current plan through its independently callable operation", async () => {
    const test = harness({ currentPlan: null });
    const freePlan = {
      id: "other-free-plan",
      active: true,
      name: "Other Free",
      kind: BillingPlanKind.FREE,
      shopifyPlanHandle: "other-free",
      shopifyUsageEventHandle: null,
      includedRecoveryConversationAllowance: null,
    };
    const otherProvider = { ...provider, planHandle: "other-free", usageEventHandles: [] };

    await test.service.applyOtherCurrentPlan(
      "shop-1",
      expected.subscriptionId,
      otherProvider as never,
      freePlan,
      expected.pendingShopifyPlanHandle,
      now.toISOString(),
      expected,
    );

    expect(test.transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ planId: freePlan.id, status: SubscriptionProjectionStatus.ACTIVE }),
    }));
  });

  it("keeps activation committed when the post-commit queue publication fails", async () => {
    const test = harness({ lifetimeCounter: { id: "lifetime-counter" } });
    const queue = { add: vi.fn().mockRejectedValue(new Error("queue unavailable")) };
    const reconciliationQueue = new ReconciliationQueueService(
      test.database as never,
      queue,
      test.logger as never,
      () => now,
    );
    const service = new InitialActivationReconciliationService(
      test.database as never,
      reconciliationQueue,
      test.discountPublisher,
      test.logger as never,
      () => now,
    );

    await expect(service.completeVerifiedPaid("shop-1", expected.subscriptionId, provider as never, paidPlan, expected))
      .resolves.toBeUndefined();

    expect(test.transaction.subscription.update).toHaveBeenCalledOnce();
    expect(test.logger.error).toHaveBeenCalledWith("billing.subscription_reconciliation.enqueue_failed", expect.any(Object));
  });

  it("keeps FROZEN-shaped missing and alternate-plan calls non-throwing and non-mutating", async () => {
    const frozenExpected = {
      subscriptionId: expected.subscriptionId,
      pendingPlanId: expected.pendingPlanId,
      pendingShopifyPlanHandle: expected.pendingShopifyPlanHandle,
      nextReconcileAt: expected.nextReconcileAt,
    } as InitialActivationExpected;
    const test = harness({
      current: { status: SubscriptionProjectionStatus.FROZEN, planId: "plan-current" } as never,
      updateCount: 0,
    });

    await expect(test.service.recordMissingSubscription("shop-1", frozenExpected)).resolves.toBeUndefined();
    await expect(test.service.applyOtherCurrentPlan(
      "shop-1",
      expected.subscriptionId,
      provider as never,
      null,
      expected.pendingShopifyPlanHandle,
      now.toISOString(),
      frozenExpected,
    )).resolves.toBeUndefined();

    expect(test.transaction.subscription.update).not.toHaveBeenCalled();
    expect(test.reconciliationQueue.publishNext).not.toHaveBeenCalled();
  });
});