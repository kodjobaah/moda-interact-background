import { beforeEach, describe, expect, it, vi } from "vitest";
import { BillingPlanKind, SubscriptionProjectionStatus } from "@prisma/client";
import { APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS } from "@modainteract/moda-interact-shared/billing";
import { EstablishedPlanChangeReconciliationService } from "../../../../src/services/billing-subscription-reconciliation/established-plan-change-reconciliation.service.js";
import type { EstablishedPlanChangeExpected } from "../../../../src/services/billing-subscription-reconciliation/classification.js";

const { transitionMock } = vi.hoisted(() => ({ transitionMock: vi.fn() }));

vi.mock("../../../../src/services/shopify-plan-change-transition.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../src/services/shopify-plan-change-transition.service.js")>("../../../../src/services/shopify-plan-change-transition.service.js");
  return {
    ...actual,
    ShopifyPlanChangeTransitionService: class {
      transition = transitionMock;
    },
  };
});

const now = new Date("2026-10-03T12:00:00.000Z");
const pendingEffectiveAt = new Date("2026-10-03T13:00:00.000Z");
const expected: EstablishedPlanChangeExpected = {
  subscriptionId: "subscription-1",
  currentPlanId: "plan-current",
  pendingPlanId: "plan-target",
  pendingShopifyPlanHandle: "target-2026",
  pendingEffectiveAt,
  currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"),
  currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z"),
  billingPeriodId: "period-1",
  nextReconcileAt: now,
};

const provider = {
  planHandle: "target-2026",
  usageEventHandles: ["recovery-meter"],
  pendingPlanHandle: null,
  pendingEffectiveAt: null,
  status: "ACTIVE" as const,
  currentPeriodStart: new Date("2026-10-03T13:00:00.000Z"),
  currentPeriodEnd: new Date("2026-11-03T13:00:00.000Z"),
  trialEndsAt: null,
  cancelAtPeriodEnd: false,
  providerSubscriptionId: "provider-subscription-1",
  providerUsageSnapshot: [],
};

const currentPlan = {
  id: expected.currentPlanId,
  active: true,
  name: "Current",
  kind: BillingPlanKind.PAID_METERED,
  shopifyPlanHandle: "current-2026",
  shopifyUsageEventHandle: "current-meter",
  shopifyRecoveryCreditPackEventHandle: null,
  recoveryCreditPackEnabled: false,
  includedRecoveryConversationAllowance: 100,
};

const targetPlan = {
  id: expected.pendingPlanId,
  active: true,
  name: "Target",
  kind: BillingPlanKind.PAID_METERED,
  shopifyPlanHandle: expected.pendingShopifyPlanHandle,
  shopifyUsageEventHandle: "recovery-meter",
  shopifyRecoveryCreditPackEventHandle: null,
  recoveryCreditPackEnabled: false,
  includedRecoveryConversationAllowance: 200,
};

function harness({ updateCount = 1, capacityResume = vi.fn().mockResolvedValue(undefined) } = {}) {
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    merchantPricingPlan: { findUnique: vi.fn().mockResolvedValue({ usageEvents: [{ eventHandle: "recovery-meter" }] }) },
    subscription: {
      findFirst: vi.fn().mockResolvedValue({ id: expected.subscriptionId, billingPeriodId: "period-1" }),
      updateMany: vi.fn().mockResolvedValue({ count: updateCount }),
    },
    billingPeriod: {
      findUnique: vi.fn().mockResolvedValue({ id: "period-1", subscriptionId: expected.subscriptionId, status: "CLOSED" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    billingPlan: { findUnique: vi.fn().mockResolvedValue({ kind: BillingPlanKind.PAID_METERED }) },
    usageEvent: { updateMany: vi.fn() },
    usageReservation: { aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: 0 } }), updateMany: vi.fn() },
    billingPeriodEntitlementCounter: {
      findUnique: vi.fn().mockResolvedValue(null), updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const database = {
    billingPlan: { findUnique: vi.fn().mockResolvedValue({ id: "pending-plan", active: true }) },
    subscription: { updateMany: vi.fn().mockResolvedValue({ count: updateCount }) },
    $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)),
  };
  const reconciliationQueue = { publishNext: vi.fn().mockResolvedValue(undefined) };
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  const service = new EstablishedPlanChangeReconciliationService(
    database as never,
    reconciliationQueue,
    logger as never,
    () => now,
    { schedule: capacityResume },
  );
  return { database, transaction, reconciliationQueue, logger, service, capacityResume };
}

beforeEach(() => {
  transitionMock.mockReset();
});

describe("EstablishedPlanChangeReconciliationService", () => {
  it("refreshes provider-current pending state and schedules its exact effective time", async () => {
    const test = harness();
    const currentProvider = {
      ...provider,
      planHandle: currentPlan.shopifyPlanHandle,
      pendingPlanHandle: expected.pendingShopifyPlanHandle,
      pendingEffectiveAt,
    };

    await test.service.reconcile("shop-1", expected, currentProvider as never, currentPlan, targetPlan);

    expect(test.database.billingPlan.findUnique).toHaveBeenCalledWith({
      where: { shopifyPlanHandle: expected.pendingShopifyPlanHandle },
      select: { id: true, active: true },
    });
    expect(test.transaction.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: expected.subscriptionId,
        planId: expected.currentPlanId,
        pendingPlanId: expected.pendingPlanId,
        nextReconcileAt: expected.nextReconcileAt,
      }),
      data: expect.objectContaining({
        pendingPlanId: "pending-plan",
        pendingShopifyPlanHandle: expected.pendingShopifyPlanHandle,
        pendingEffectiveAt,
        nextReconcileAt: pendingEffectiveAt,
      }),
    }));
    expect(test.reconciliationQueue.publishNext).toHaveBeenCalledWith("shop-1", expected.subscriptionId, pendingEffectiveAt);
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it("uses the current plan drain boundary when no provider pending change remains", async () => {
    const test = harness();
    const drainAt = new Date(expected.currentPeriodEnd!.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS);

    await test.service.reconcile("shop-1", expected, { ...provider, planHandle: currentPlan.shopifyPlanHandle } as never, currentPlan, null);

    expect(test.transaction.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ pendingPlanId: null, pendingShopifyPlanHandle: null, nextReconcileAt: drainAt }),
    }));
    expect(test.reconciliationQueue.publishNext).toHaveBeenCalledWith("shop-1", expected.subscriptionId, drainAt);
  });

  it("schedules a target plan exactly at its future effective time without transitioning", async () => {
    const test = harness();

    await test.service.reconcile("shop-1", expected, provider as never, currentPlan, targetPlan);

    expect(test.transaction.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ nextReconcileAt: pendingEffectiveAt, lastSyncErrorCode: null }),
    }));
    expect(test.reconciliationQueue.publishNext).toHaveBeenCalledWith("shop-1", expected.subscriptionId, pendingEffectiveAt);
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it("fails closed when a target plan appears in the existing billing cycle", async () => {
    const test = harness();
    const sameCycleProvider = {
      ...provider,
      currentPeriodStart: expected.currentPeriodStart,
      currentPeriodEnd: expected.currentPeriodEnd,
    };

    await test.service.reconcile("shop-1", expected, sameCycleProvider as never, currentPlan, targetPlan);

    expect(test.transaction.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: SubscriptionProjectionStatus.SYNC_ERROR, lastSyncErrorCode: "UNEXPECTED_IMMEDIATE_PLAN_CHANGE" }),
    }));
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it.each([
    ["billing cycle", { ...provider, currentPeriodStart: null }, targetPlan, "MISSING_BILLING_CYCLE"],
    ["allowance", provider, { ...targetPlan, includedRecoveryConversationAllowance: null }, "INVALID_INCLUDED_ALLOWANCE"],
  ])("fails closed when the target is missing its required %s", async (_label, providerState, plan, errorCode) => {
    const test = harness();
    const alreadyEffective = new Date("2026-10-03T10:00:00.000Z");
    const effectiveExpected = { ...expected, pendingEffectiveAt: alreadyEffective };

    await test.service.reconcile("shop-1", effectiveExpected, providerState as never, currentPlan, plan as never);

    expect(test.transaction.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: SubscriptionProjectionStatus.SYNC_ERROR, lastSyncErrorCode: errorCode }),
    }));
    expect(test.reconciliationQueue.publishNext).toHaveBeenCalledOnce();
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it("delegates a verified effective transition and resumes Paid capacity after commit", async () => {
    const test = harness();
    transitionMock.mockResolvedValue({
      kind: "transitioned",
      billingPeriodId: "period-2",
      nextReconcileAt: new Date("2026-11-03T00:00:00.000Z"),
      planKind: BillingPlanKind.PAID_METERED,
    });
    const alreadyEffective = new Date("2026-10-03T10:00:00.000Z");

    await test.service.reconcile("shop-1", { ...expected, pendingEffectiveAt: alreadyEffective }, provider as never, currentPlan, targetPlan);

    expect(transitionMock).toHaveBeenCalledWith(expect.objectContaining({
      shopId: "shop-1",
      subscriptionId: expected.subscriptionId,
      provider,
      plan: targetPlan,
      expectedCurrentPlanId: expected.currentPlanId,
      now,
    }));
    expect(test.reconciliationQueue.publishNext).toHaveBeenCalledWith("shop-1", expected.subscriptionId, new Date("2026-11-03T00:00:00.000Z"));
    expect(test.capacityResume).toHaveBeenCalledWith({ shopId: "shop-1", trigger: "plan-change" });
    expect(test.database.billingPlan.findUnique).not.toHaveBeenCalled();
  });


  it("does not require the optional App Events reporting handle to transition a Paid plan", async () => {
    const test = harness();
    transitionMock.mockResolvedValue({ kind: "transitioned", billingPeriodId: "period-2", nextReconcileAt: null, planKind: BillingPlanKind.PAID_METERED });
    const alreadyEffective = new Date("2026-10-03T10:00:00.000Z");
    const planWithoutReportingHandle = { ...targetPlan, shopifyUsageEventHandle: null };
    const providerWithoutReportingEvent = { ...provider, usageEventHandles: [] };

    await test.service.reconcile("shop-1", { ...expected, pendingEffectiveAt: alreadyEffective }, providerWithoutReportingEvent as never, currentPlan, planWithoutReportingHandle);

    expect(transitionMock).toHaveBeenCalledWith(expect.objectContaining({ plan: planWithoutReportingHandle, provider: providerWithoutReportingEvent }));
    expect(test.transaction.subscription.updateMany).not.toHaveBeenCalled();
  });

  it("keeps a successful plan transition when capacity resume enqueue fails", async () => {
    const capacityResume = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    const test = harness({ capacityResume });
    transitionMock.mockResolvedValue({ kind: "transitioned", billingPeriodId: "period-2", nextReconcileAt: null, planKind: BillingPlanKind.PAID_METERED });
    const alreadyEffective = new Date("2026-10-03T10:00:00.000Z");

    await expect(test.service.reconcile("shop-1", { ...expected, pendingEffectiveAt: alreadyEffective }, provider as never, currentPlan, targetPlan)).resolves.toBeUndefined();

    expect(test.logger.warn).toHaveBeenCalledWith("billing.recovery_capacity_resume.enqueue_failed", expect.objectContaining({
      shopId: "shop-1",
      errorMessage: "queue unavailable",
      error: expect.any(Error),
    }));
    expect(transitionMock).toHaveBeenCalledOnce();
  });

  it("marks unknown handles unmapped without scheduling another retry", async () => {
    const test = harness();

    await test.service.reconcile("shop-1", expected, { ...provider, planHandle: "unknown" } as never, currentPlan, null);

    expect(test.transaction.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: SubscriptionProjectionStatus.UNMAPPED, planId: null, lastSyncErrorCode: null, lastSyncErrorAt: null, nextReconcileAt: null }),
    }));
    expect(test.reconciliationQueue.publishNext).not.toHaveBeenCalled();
  });

  it("fails closed for a mapped provider plan that is neither current nor pending", async () => {
    const test = harness();
    const unrelatedPlan = { ...targetPlan, id: "plan-unrelated", shopifyPlanHandle: "unrelated-2026" };

    await test.service.reconcile("shop-1", expected, { ...provider, planHandle: "unrelated-2026" } as never, currentPlan, unrelatedPlan);

    expect(test.transaction.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: SubscriptionProjectionStatus.SYNC_ERROR, lastSyncErrorCode: "UNEXPECTED_IMMEDIATE_PLAN_CHANGE" }),
    }));
    expect(test.reconciliationQueue.publishNext).toHaveBeenCalledOnce();
  });

  it("records provider failure or unresolved state on the established-plan CAS and retries", async () => {
    const test = harness();
    const error = new Error("provider unavailable");

    await test.service.recordRetry("shop-1", expected, "PARTNER_API_ERROR", error);
    await test.service.recordRetry("shop-1", expected, "PROVIDER_STATE_UNRESOLVED");

    expect(test.transaction.subscription.updateMany).toHaveBeenCalledTimes(2);
    expect(test.logger.error).toHaveBeenCalledWith("billing.subscription_reconciliation.provider_failed", {
      shopId: "shop-1",
      subscriptionId: expected.subscriptionId,
      errorMessage: "provider unavailable",
      error,
    });
    expect(test.reconciliationQueue.publishNext).toHaveBeenCalledTimes(2);
  });
  it("does not retire a stale scheduled plan-change period", async () => {
    const test = harness();
    test.transaction.subscription.findFirst.mockResolvedValue(null);
    await test.service.reconcile("shop-1", expected, { ...provider, planHandle: "unknown" } as never, currentPlan, null);
    expect(test.transaction.subscription.updateMany).not.toHaveBeenCalled();
    expect(test.transaction.billingPeriod.findUnique).not.toHaveBeenCalled();
  });

  it("retires the old paid period before an unknown scheduled plan change", async () => {
    const test = harness();
    test.transaction.billingPeriod.findUnique.mockResolvedValue({
      id: "period-1", subscriptionId: expected.subscriptionId,
      status: "OPEN", planKindSnapshot: "PAID_METERED",
    });
    test.transaction.billingPeriodEntitlementCounter.findUnique
      .mockResolvedValueOnce({ id: "counter-1", grantedQuantity: 12, committedQuantity: 5, reservedQuantity: 0, forfeitedQuantity: 0, version: 1 })
      .mockResolvedValueOnce({ id: "counter-1", grantedQuantity: 12, committedQuantity: 5, reservedQuantity: 0, forfeitedQuantity: 7, version: 2 });
    await test.service.reconcile("shop-1", expected, { ...provider, planHandle: "unknown" } as never, currentPlan, null);
    expect(test.transaction.billingPeriod.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "CLOSED", closeReason: "PLAN_CHANGED" }),
    }));
    expect(test.transaction.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "UNMAPPED", planId: null, billingPeriodId: null }),
    }));
  });

});
