import { describe, expect, it, vi } from "vitest";

import { SamePlanBillingPeriodRolloverService } from "../../../src/services/same-plan-billing-period-rollover.service.js";

const currentStart = new Date("2026-09-01T00:00:00.000Z");
const currentEnd = new Date("2026-10-01T00:00:00.000Z");
const successorStart = currentEnd;
const successorEnd = new Date("2026-11-01T00:00:00.000Z");

const plan = {
  id: "plan-paid",
  active: true,
  name: "Paid",
  kind: "PAID_METERED" as const,
  shopifyPlanHandle: "paid-2026",
  includedRecoveryConversationAllowance: 100,
  recoveryCreditPackEnabled: true,
  shopifyUsageEventHandle: "recovery-meter",
  shopifyRecoveryCreditPackEventHandle: "pack-meter",
};

const freePlan = {
  ...plan,
  id: "plan-free",
  name: "Free",
  kind: "FREE" as const,
  shopifyPlanHandle: "free-2026",
  includedRecoveryConversationAllowance: null,
  recoveryCreditPackEnabled: false,
  shopifyUsageEventHandle: null,
  shopifyRecoveryCreditPackEventHandle: null,
};

const provider = {
  planHandle: "paid-2026",
  usageEventHandles: ["recovery-meter", "pack-meter"],
  pendingPlanHandle: null,
  pendingEffectiveAt: null,
  status: "ACTIVE" as const,
  currentPeriodStart: successorStart,
  currentPeriodEnd: successorEnd,
  trialEndsAt: null,
  cancelAtPeriodEnd: false,
  providerSubscriptionId: "provider-subscription-1",
  providerUsageSnapshot: [],
};

function transactionHarness(overrides: Record<string, unknown> = {}) {
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    subscription: {
      findUnique: vi.fn().mockResolvedValue({
        id: "subscription-1",
        shopId: "shop-1",
        planId: "plan-paid",
        status: "ACTIVE",
        billingPeriodId: "period-old",
        currentPeriodStart: currentStart,
        currentPeriodEnd: currentEnd,
        nextReconcileAt: null,
        billingPeriod: {
          id: "period-old",
          periodStart: currentStart,
          periodEnd: currentEnd,
          status: "OPEN",
        },
      }),
      update: vi.fn(),
    },
    billingPeriod: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "period-new" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    billingPeriodEntitlementCounter: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    usageEvent: { updateMany: vi.fn() },
    usageReservation: { aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: 0 } }), updateMany: vi.fn() },
    ...overrides,
  };
  return transaction;
}

describe("SamePlanBillingPeriodRolloverService", () => {
  it.each(["FROZEN", "NO_CONTRACT", "CANCELED"])("does not transition %s subscriptions", async (status) => {
    const transaction = transactionHarness({
      subscription: { ...transactionHarness().subscription, findUnique: vi.fn().mockResolvedValue({
        id: "subscription-1",
        shopId: "shop-1",
        planId: "plan-paid",
        status,
        billingPeriodId: "period-old",
        currentPeriodStart: currentStart,
        currentPeriodEnd: currentEnd,
        nextReconcileAt: null,
        billingPeriod: { id: "period-old", periodStart: currentStart, periodEnd: currentEnd, status: "OPEN" },
      }) },
    });
    const database = { $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)) };

    const result = await new SamePlanBillingPeriodRolloverService(database as never).transition({
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      provider,
      plan,
      now: new Date("2026-10-01T00:00:01.000Z"),
    });

    expect(result).toEqual({ kind: "not-applicable" });
    expect(transaction.billingPeriod.updateMany).not.toHaveBeenCalled();
    expect(transaction.subscription.update).not.toHaveBeenCalled();
  });

  it("fails closed when a successor has incompatible canonical identity", async () => {
    const transaction = transactionHarness({
      billingPeriod: {
        ...transactionHarness().billingPeriod,
        findUnique: vi.fn().mockResolvedValue({
          id: "period-new",
          shopId: "shop-1",
          subscriptionId: "other-subscription",
          planId: "plan-paid",
          shopifyPlanHandleSnapshot: "paid-2026",
          planNameSnapshot: "Paid",
          planKindSnapshot: "PAID_METERED",
          includedRecoveryCreditsGranted: 100,
          periodStart: successorStart,
          periodEnd: successorEnd,
          status: "OPEN",
        }),
      },
    });
    const database = { $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)) };

    await expect(new SamePlanBillingPeriodRolloverService(database as never).transition({
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      provider,
      plan,
      now: new Date("2026-10-01T00:00:01.000Z"),
    })).rejects.toThrow("incompatible successor");
    expect(transaction.subscription.update).not.toHaveBeenCalled();
  });

  it("fails closed for an overlapping non-identical provider cycle", async () => {
    const transaction = transactionHarness();
    const database = { $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)) };

    await expect(new SamePlanBillingPeriodRolloverService(database as never).transition({
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      provider: {
        ...provider,
        currentPeriodStart: new Date("2026-09-15T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-10-15T00:00:00.000Z"),
      },
      plan,
      now: new Date("2026-10-01T00:00:01.000Z"),
    })).rejects.toThrow("overlaps");
    expect(transaction.billingPeriod.create).not.toHaveBeenCalled();
    expect(transaction.billingPeriod.updateMany).not.toHaveBeenCalled();
    expect(transaction.subscription.update).not.toHaveBeenCalled();
  });

  it("does not reopen a CLOSED successor during replay", async () => {
    const transaction = transactionHarness({
      billingPeriod: {
        ...transactionHarness().billingPeriod,
        findUnique: vi.fn().mockResolvedValue({
          id: "period-new",
          shopId: "shop-1",
          subscriptionId: "subscription-1",
          planId: "plan-paid",
          shopifyPlanHandleSnapshot: "paid-2026",
          planNameSnapshot: "Paid",
          planKindSnapshot: "PAID_METERED",
          includedRecoveryCreditsGranted: 100,
          periodStart: successorStart,
          periodEnd: successorEnd,
          status: "CLOSED",
        }),
      },
    });
    const database = { $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)) };

    await expect(new SamePlanBillingPeriodRolloverService(database as never).transition({
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      provider,
      plan,
      now: new Date("2026-10-01T00:00:01.000Z"),
    })).rejects.toThrow("closed successor");
    expect(transaction.billingPeriod.updateMany).not.toHaveBeenCalled();
    expect(transaction.billingPeriodEntitlementCounter.upsert).not.toHaveBeenCalled();
    expect(transaction.subscription.update).not.toHaveBeenCalled();
  });

  it("releases RESERVED and AMBIGUOUS reservations as PERIOD_CLOSED and closes the counter invariant", async () => {
    const transaction = transactionHarness();
    transaction.billingPeriodEntitlementCounter.findUnique
      .mockResolvedValueOnce({
        id: "counter-old",
        grantedQuantity: 100,
        committedQuantity: 20,
        reservedQuantity: 10,
        forfeitedQuantity: 0,
        version: 1,
      })
      .mockResolvedValueOnce({
        id: "counter-old",
        grantedQuantity: 100,
        committedQuantity: 20,
        reservedQuantity: 0,
        forfeitedQuantity: 80,
        version: 2,
      });
    transaction.usageReservation.aggregate.mockResolvedValue({ _sum: { quantity: 10 } });
    const database = { $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)) };

    await new SamePlanBillingPeriodRolloverService(database as never).transition({
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      provider,
      plan,
      now: new Date("2026-10-01T00:00:01.000Z"),
    });

    expect(transaction.usageReservation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: "RELEASED", releaseReason: "PERIOD_CLOSED" },
    }));
    expect(transaction.billingPeriodEntitlementCounter.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ reservedQuantity: { decrement: 10 }, forfeitedQuantity: { increment: 80 } }),
    }));
    expect(transaction.billingPeriod.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "CLOSED" }),
    }));
  });

  it("aborts before releasing or closing when reservation aggregate mismatches the counter", async () => {
    const transaction = transactionHarness();
    transaction.billingPeriodEntitlementCounter.findUnique.mockResolvedValue({
      id: "counter-old",
      grantedQuantity: 100,
      committedQuantity: 20,
      reservedQuantity: 10,
      forfeitedQuantity: 0,
      version: 1,
    });
    transaction.usageReservation.aggregate.mockResolvedValue({ _sum: { quantity: 9 } });
    const database = { $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)) };

    await expect(new SamePlanBillingPeriodRolloverService(database as never).transition({
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      provider,
      plan,
      now: new Date("2026-10-01T00:00:01.000Z"),
    })).rejects.toThrow("counter is inconsistent");

    expect(transaction.usageReservation.updateMany).not.toHaveBeenCalled();
    expect(transaction.billingPeriod.updateMany).not.toHaveBeenCalled();
    expect(transaction.billingPeriod.create).not.toHaveBeenCalled();
    expect(transaction.subscription.update).not.toHaveBeenCalled();
  });

  it("moves only old PENDING and RETRYABLE events to bounded attention", async () => {
    const transaction = transactionHarness();
    transaction.subscription.findUnique.mockResolvedValue({
      id: "subscription-1", shopId: "shop-1", planId: "plan-free", status: "ACTIVE", billingPeriodId: "period-old",
      currentPeriodStart: currentStart, currentPeriodEnd: currentEnd, nextReconcileAt: null,
      billingPeriod: { id: "period-old", periodStart: currentStart, periodEnd: currentEnd, status: "OPEN" },
    });
    const freeProvider = { ...provider, planHandle: "free-2026", usageEventHandles: [], currentPeriodStart: successorStart };
    const database = { $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)) };

    await new SamePlanBillingPeriodRolloverService(database as never).transition({
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      provider: freeProvider,
      plan: freePlan,
      now: new Date("2026-10-01T00:00:01.000Z"),
    });

    expect(transaction.usageEvent.updateMany).toHaveBeenCalledWith({
      where: { billingPeriodId: "period-old", shopifyReportState: { in: ["PENDING", "RETRYABLE"] } },
      data: expect.objectContaining({
        shopifyReportState: "NEEDS_ATTENTION",
        nextReportAt: null,
        providerErrorCode: "PERIOD_CLOSED_BEFORE_REPORT",
      }),
    });
  });

  it("does not overwrite old REPORTED or IN_FLIGHT events during rollover", async () => {
    const transaction = transactionHarness();
    transaction.subscription.findUnique.mockResolvedValue({
      id: "subscription-1", shopId: "shop-1", planId: "plan-free", status: "ACTIVE", billingPeriodId: "period-old",
      currentPeriodStart: currentStart, currentPeriodEnd: currentEnd, nextReconcileAt: null,
      billingPeriod: { id: "period-old", periodStart: currentStart, periodEnd: currentEnd, status: "OPEN" },
    });
    const freeProvider = { ...provider, planHandle: "free-2026", usageEventHandles: [], currentPeriodStart: successorStart };
    const database = { $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)) };

    await new SamePlanBillingPeriodRolloverService(database as never).transition({
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      provider: freeProvider,
      plan: freePlan,
      now: new Date("2026-10-01T00:00:01.000Z"),
    });

    const eventUpdate = transaction.usageEvent.updateMany.mock.calls[0]?.[0];
    expect(eventUpdate.where.shopifyReportState.in).not.toContain("REPORTED");
    expect(eventUpdate.where.shopifyReportState.in).not.toContain("IN_FLIGHT");
  });

  it("leaves an old pack purchase REQUESTED when its event is closed before reporting", async () => {
    const purchase = { status: "REQUESTED", currentAmount: 0, activatedAt: null };
    const transaction = transactionHarness({
      recoveryCreditPurchase: {
        findUnique: vi.fn().mockResolvedValue(purchase),
        update: vi.fn(),
      },
    });
    transaction.subscription.findUnique.mockResolvedValue({
      id: "subscription-1", shopId: "shop-1", planId: "plan-free", status: "ACTIVE", billingPeriodId: "period-old",
      currentPeriodStart: currentStart, currentPeriodEnd: currentEnd, nextReconcileAt: null,
      billingPeriod: { id: "period-old", periodStart: currentStart, periodEnd: currentEnd, status: "OPEN" },
    });
    const freeProvider = { ...provider, planHandle: "free-2026", usageEventHandles: [], currentPeriodStart: successorStart };
    const database = { $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)) };

    await new SamePlanBillingPeriodRolloverService(database as never).transition({
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      provider: freeProvider,
      plan: freePlan,
      now: new Date("2026-10-01T00:00:01.000Z"),
    });

    expect(purchase).toEqual({ status: "REQUESTED", currentAmount: 0, activatedAt: null });
    expect(transaction.recoveryCreditPurchase.update).not.toHaveBeenCalled();
  });

  it("creates an exact Paid successor snapshot and included grant", async () => {
    const transaction = transactionHarness();
    transaction.billingPeriodEntitlementCounter.findUnique
      .mockResolvedValueOnce({ id: "counter-old", grantedQuantity: 100, committedQuantity: 0, reservedQuantity: 0, forfeitedQuantity: 0, version: 1 })
      .mockResolvedValueOnce({ id: "counter-old", grantedQuantity: 100, committedQuantity: 0, reservedQuantity: 0, forfeitedQuantity: 100, version: 2 });
    const database = { $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)) };

    await new SamePlanBillingPeriodRolloverService(database as never).transition({
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      provider,
      plan,
      now: new Date("2026-10-01T00:00:01.000Z"),
    });

    expect(transaction.billingPeriod.create).toHaveBeenCalledWith({
      data: {
        shopId: "shop-1",
        subscriptionId: "subscription-1",
        planId: "plan-paid",
        shopifyPlanHandleSnapshot: "paid-2026",
        planNameSnapshot: "Paid",
        planKindSnapshot: "PAID_METERED",
        includedRecoveryCreditsGranted: 100,
        periodStart: successorStart,
        periodEnd: successorEnd,
        status: "OPEN",
      },
    });
  });

  it("does not reset a compatible successor included counter on replay", async () => {
    const existingCounter = {
      id: "counter-new",
      grantedQuantity: 100,
      committedQuantity: 7,
      reservedQuantity: 3,
      forfeitedQuantity: 2,
    };
    const transaction = transactionHarness({
      billingPeriod: {
        ...transactionHarness().billingPeriod,
        findUnique: vi.fn().mockResolvedValue({
          id: "period-new",
          shopId: "shop-1",
          subscriptionId: "subscription-1",
          planId: "plan-paid",
          shopifyPlanHandleSnapshot: "paid-2026",
          planNameSnapshot: "Paid",
          planKindSnapshot: "PAID_METERED",
          includedRecoveryCreditsGranted: 100,
          periodStart: successorStart,
          periodEnd: successorEnd,
          status: "OPEN",
        }),
      },
    });
    transaction.billingPeriodEntitlementCounter.findUnique
      .mockResolvedValueOnce({ id: "counter-old", grantedQuantity: 100, committedQuantity: 0, reservedQuantity: 0, forfeitedQuantity: 0, version: 1 })
      .mockResolvedValueOnce({ id: "counter-old", grantedQuantity: 100, committedQuantity: 0, reservedQuantity: 0, forfeitedQuantity: 100, version: 2 })
      .mockResolvedValueOnce(existingCounter);
    const database = { $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)) };

    await new SamePlanBillingPeriodRolloverService(database as never).transition({
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      provider,
      plan,
      now: new Date("2026-10-01T00:00:01.000Z"),
    });

    expect(existingCounter).toEqual({ id: "counter-new", grantedQuantity: 100, committedQuantity: 7, reservedQuantity: 3, forfeitedQuantity: 2 });
    expect(transaction.billingPeriodEntitlementCounter.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {}, create: expect.objectContaining({ committedQuantity: 0, reservedQuantity: 0, forfeitedQuantity: 0 }) }));
  });

  it("emits one Paid capacity hint while allowing the generic hook for Free rollover", async () => {
    const afterTransitionCommitted = vi.fn();
    const capacityResumeHint = vi.fn();
    afterTransitionCommitted.mockImplementation(async (_input, result) => {
      if (result.planKind !== "PAID_METERED") return;
      await capacityResumeHint();
    });
    const transaction = transactionHarness();
    transaction.billingPeriodEntitlementCounter.findUnique
      .mockResolvedValueOnce({ id: "counter-old", grantedQuantity: 100, committedQuantity: 0, reservedQuantity: 0, forfeitedQuantity: 0, version: 1 })
      .mockResolvedValueOnce({ id: "counter-old", grantedQuantity: 100, committedQuantity: 0, reservedQuantity: 0, forfeitedQuantity: 100, version: 2 });
    const database = { $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)) };
    const service = new SamePlanBillingPeriodRolloverService(database as never, afterTransitionCommitted);

    await service.transition({ shopId: "shop-1", subscriptionId: "subscription-1", provider, plan, now: new Date("2026-10-01T00:00:01.000Z") });
    expect(afterTransitionCommitted).toHaveBeenCalledOnce();
    expect(capacityResumeHint).toHaveBeenCalledOnce();

    const replayTransaction = transactionHarness({
      subscription: {
        ...transactionHarness().subscription,
        findUnique: vi.fn().mockResolvedValue({
          id: "subscription-1", shopId: "shop-1", planId: "plan-paid", status: "ACTIVE", billingPeriodId: "period-new",
          currentPeriodStart: successorStart, currentPeriodEnd: successorEnd, nextReconcileAt: null,
          billingPeriod: { id: "period-new", periodStart: successorStart, periodEnd: successorEnd, status: "OPEN" },
        }),
      },
    });
    const replayDatabase = { $transaction: vi.fn(async (callback: (value: typeof replayTransaction) => unknown) => callback(replayTransaction)) };
    await new SamePlanBillingPeriodRolloverService(replayDatabase as never, afterTransitionCommitted).transition({ shopId: "shop-1", subscriptionId: "subscription-1", provider, plan, now: new Date("2026-10-01T00:00:01.000Z") });

    const freeTransaction = transactionHarness({
      subscription: {
        ...transactionHarness().subscription,
        findUnique: vi.fn().mockResolvedValue({
          id: "subscription-1", shopId: "shop-1", planId: "plan-free", status: "ACTIVE", billingPeriodId: "period-old",
          currentPeriodStart: currentStart, currentPeriodEnd: currentEnd, nextReconcileAt: null,
          billingPeriod: { id: "period-old", periodStart: currentStart, periodEnd: currentEnd, status: "OPEN" },
        }),
      },
    });
    const freeDatabase = { $transaction: vi.fn(async (callback: (value: typeof freeTransaction) => unknown) => callback(freeTransaction)) };
    const freeResult = await new SamePlanBillingPeriodRolloverService(freeDatabase as never, afterTransitionCommitted).transition({ shopId: "shop-1", subscriptionId: "subscription-1", provider: { ...provider, planHandle: "free-2026", usageEventHandles: [], currentPeriodStart: successorStart }, plan: freePlan, now: new Date("2026-10-01T00:00:01.000Z") });

    expect(afterTransitionCommitted).toHaveBeenCalledTimes(2);
    expect(freeResult).toMatchObject({ kind: "transitioned", planKind: "FREE" });
    expect(afterTransitionCommitted).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ planKind: "FREE" }));
    expect(capacityResumeHint).toHaveBeenCalledOnce();
  });

  it("rotates an existing pack-enabled Free period without counters or lifetime-state mutation", async () => {
    const lifetimeCounter = { grantedQuantity: 5, committedQuantity: 2, reservedQuantity: 1 };
    const purchase = { status: "REQUESTED", currentAmount: 0, activatedAt: null };
    const transaction = transactionHarness({
      subscription: {
        ...transactionHarness().subscription,
        findUnique: vi.fn().mockResolvedValue({
          id: "subscription-1", shopId: "shop-1", planId: "plan-free", status: "ACTIVE", billingPeriodId: "period-old",
          currentPeriodStart: currentStart, currentPeriodEnd: currentEnd, nextReconcileAt: null,
          billingPeriod: { id: "period-old", periodStart: currentStart, periodEnd: currentEnd, status: "OPEN" },
        }),
      },
      shopEntitlementCounter: { findUnique: vi.fn().mockResolvedValue(lifetimeCounter), update: vi.fn() },
      recoveryCreditPurchase: { findUnique: vi.fn().mockResolvedValue(purchase), update: vi.fn() },
    });
    const packEnabledFreePlan = { ...freePlan, recoveryCreditPackEnabled: true, shopifyRecoveryCreditPackEventHandle: "pack-meter" };
    const freeProvider = { ...provider, planHandle: "free-2026", usageEventHandles: ["pack-meter"], currentPeriodStart: successorStart };
    const database = { $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)) };

    const result = await new SamePlanBillingPeriodRolloverService(database as never).transition({
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      provider: freeProvider,
      plan: packEnabledFreePlan,
      now: new Date("2026-10-01T00:00:01.000Z"),
    });

    expect(result).toEqual({
      kind: "transitioned",
      billingPeriodId: "period-new",
      nextReconcileAt: new Date("2026-10-31T23:55:00.000Z"),
      planKind: "FREE",
    });
    expect(transaction.billingPeriod.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "CLOSED", closeReason: "RENEWED_SAME_PLAN" }),
    }));
    expect(transaction.billingPeriod.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ planKindSnapshot: "FREE", includedRecoveryCreditsGranted: null }),
    }));
    expect(transaction.billingPeriodEntitlementCounter.findUnique).not.toHaveBeenCalled();
    expect(transaction.billingPeriodEntitlementCounter.upsert).not.toHaveBeenCalled();
    expect(transaction.shopEntitlementCounter.findUnique).not.toHaveBeenCalled();
    expect(transaction.shopEntitlementCounter.update).not.toHaveBeenCalled();
    expect(transaction.recoveryCreditPurchase.findUnique).not.toHaveBeenCalled();
    expect(transaction.recoveryCreditPurchase.update).not.toHaveBeenCalled();
    expect(transaction.usageEvent.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { billingPeriodId: "period-old", shopifyReportState: { in: ["PENDING", "RETRYABLE"] } },
      data: expect.objectContaining({ shopifyReportState: "NEEDS_ATTENTION", providerErrorCode: "PERIOD_CLOSED_BEFORE_REPORT" }),
    }));
    expect(lifetimeCounter).toEqual({ grantedQuantity: 5, committedQuantity: 2, reservedQuantity: 1 });
    expect(purchase).toEqual({ status: "REQUESTED", currentAmount: 0, activatedAt: null });
  });

  it.each([
    ["at", new Date("2026-10-01T00:00:00.000Z")],
    ["after", new Date("2026-10-01T00:00:01.000Z")],
  ])("returns provider-cycle-lag when the provider still reports the old cycle %s the boundary", async (_label, now) => {
    const transaction = transactionHarness();
    const database = { $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)) };

    const result = await new SamePlanBillingPeriodRolloverService(database as never).transition({
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      provider: { ...provider, currentPeriodStart: currentStart, currentPeriodEnd: currentEnd },
      plan,
      now,
    });

    expect(result).toEqual({ kind: "provider-cycle-lag", billingPeriodId: "period-old", nextReconcileAt: null });
    expect(transaction.billingPeriod.updateMany).not.toHaveBeenCalled();
    expect(transaction.billingPeriod.create).not.toHaveBeenCalled();
    expect(transaction.subscription.update).not.toHaveBeenCalled();
  });

  it("schedules the next Paid pre-close boundary after a contiguous rollover", async () => {
    const transaction = transactionHarness();
    transaction.billingPeriodEntitlementCounter.findUnique
      .mockResolvedValueOnce({
        id: "counter-old",
        grantedQuantity: 100,
        committedQuantity: 0,
        reservedQuantity: 0,
        forfeitedQuantity: 0,
        version: 1,
      })
      .mockResolvedValueOnce({
        id: "counter-old",
        grantedQuantity: 100,
        committedQuantity: 0,
        reservedQuantity: 0,
        forfeitedQuantity: 100,
        version: 2,
        reservedQuantity: 0,
      });
    const database = { $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)) };

    const result = await new SamePlanBillingPeriodRolloverService(database as never).transition({
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      provider,
      plan,
      now: new Date("2026-10-01T00:00:01.000Z"),
    });

    expect(result).toEqual({
      kind: "transitioned",
      billingPeriodId: "period-new",
      nextReconcileAt: new Date("2026-10-31T23:55:00.000Z"),
      planKind: "PAID_METERED",
    });
    expect(transaction.billingPeriod.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "CLOSED", closeReason: "RENEWED_SAME_PLAN" }),
    }));
    expect(transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ billingPeriodId: "period-new", nextReconcileAt: new Date("2026-10-31T23:55:00.000Z") }),
    }));
  });

  it("creates only the provider cycle when a Paid rollover has a gap", async () => {
    const transaction = transactionHarness();
    transaction.billingPeriodEntitlementCounter.findUnique
      .mockResolvedValueOnce({
        id: "counter-old",
        grantedQuantity: 100,
        committedQuantity: 0,
        reservedQuantity: 0,
        forfeitedQuantity: 0,
        version: 1,
      })
      .mockResolvedValueOnce({
        id: "counter-old",
        grantedQuantity: 100,
        committedQuantity: 0,
        reservedQuantity: 0,
        forfeitedQuantity: 100,
        version: 2,
      });
    const database = { $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)) };

    await new SamePlanBillingPeriodRolloverService(database as never).transition({
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      provider: {
        ...provider,
        currentPeriodStart: new Date("2026-11-01T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-12-01T00:00:00.000Z"),
      },
      plan,
      now: new Date("2026-11-01T00:00:01.000Z"),
    });

    expect(transaction.billingPeriod.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ periodStart: new Date("2026-11-01T00:00:00.000Z"), periodEnd: new Date("2026-12-01T00:00:00.000Z") }),
    }));
    expect(transaction.billingPeriod.create.mock.calls).toHaveLength(1);
  });

  it("leaves pack-disabled Free rollover without a cycle-specific schedule", async () => {
    const transaction = transactionHarness({
      subscription: {
        ...transactionHarness().subscription,
        findUnique: vi.fn().mockResolvedValue({
          id: "subscription-1",
          shopId: "shop-1",
          planId: "plan-free",
          status: "ACTIVE",
          billingPeriodId: "period-old",
          currentPeriodStart: currentStart,
          currentPeriodEnd: currentEnd,
          nextReconcileAt: new Date("2026-10-01T00:00:00.000Z"),
          billingPeriod: { id: "period-old", periodStart: currentStart, periodEnd: currentEnd, status: "OPEN" },
        }),
      },
    });
    const database = { $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)) };

    const result = await new SamePlanBillingPeriodRolloverService(database as never).transition({
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      provider: { ...provider, planHandle: "free-2026", usageEventHandles: [], currentPeriodStart: successorStart },
      plan: freePlan,
      now: new Date("2026-10-01T00:00:01.000Z"),
    });

    expect(result).toMatchObject({ kind: "transitioned", planKind: "FREE", nextReconcileAt: null });
    expect(transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ nextReconcileAt: null }),
    }));
    expect(transaction.billingPeriodEntitlementCounter.findUnique).not.toHaveBeenCalled();
  });

  it("reuses an already-open successor without duplicating its grant", async () => {
    const transaction = transactionHarness({
      billingPeriod: {
        ...transactionHarness().billingPeriod,
        findUnique: vi.fn().mockResolvedValue({
          id: "period-new",
          shopId: "shop-1",
          subscriptionId: "subscription-1",
          planId: "plan-paid",
          shopifyPlanHandleSnapshot: "paid-2026",
          planNameSnapshot: "Paid",
          planKindSnapshot: "PAID_METERED",
          includedRecoveryCreditsGranted: 100,
          periodStart: successorStart,
          periodEnd: successorEnd,
          status: "OPEN",
        }),
      },
      subscription: {
        ...transactionHarness().subscription,
        findUnique: vi.fn().mockResolvedValue({
          id: "subscription-1",
          shopId: "shop-1",
          planId: "plan-paid",
          status: "ACTIVE",
          billingPeriodId: "period-old",
          currentPeriodStart: currentStart,
          currentPeriodEnd: currentEnd,
          nextReconcileAt: null,
          billingPeriod: { id: "period-old", periodStart: currentStart, periodEnd: currentEnd, status: "OPEN" },
        }),
      },
    });
    transaction.billingPeriodEntitlementCounter.findUnique
      .mockResolvedValueOnce({
        id: "counter-old",
        grantedQuantity: 100,
        committedQuantity: 0,
        reservedQuantity: 0,
        forfeitedQuantity: 0,
        version: 1,
      })
      .mockResolvedValueOnce({
        id: "counter-old",
        grantedQuantity: 100,
        committedQuantity: 0,
        reservedQuantity: 0,
        forfeitedQuantity: 100,
        version: 2,
      });
    const database = { $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)) };

    const result = await new SamePlanBillingPeriodRolloverService(database as never).transition({
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      provider,
      plan,
      now: new Date("2026-10-01T00:00:01.000Z"),
    });

    expect(result).toMatchObject({ kind: "transitioned", billingPeriodId: "period-new", planKind: "PAID_METERED" });
    expect(transaction.billingPeriod.create).not.toHaveBeenCalled();
    expect(transaction.billingPeriodEntitlementCounter.upsert).toHaveBeenCalled();
  });
});
