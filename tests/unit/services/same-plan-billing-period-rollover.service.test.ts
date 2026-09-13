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
