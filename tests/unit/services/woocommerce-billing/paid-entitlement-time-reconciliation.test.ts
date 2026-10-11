import { describe, expect, it, vi } from "vitest";

import {
  currentWooEntitlementWindow,
  nextWooEntitlementReconciliationAt,
} from "../../../../src/services/woocommerce-billing/paid-entitlement-window.js";
import { WooPaidEntitlementTimeReconciliationService } from "../../../../src/services/woocommerce-billing/paid-entitlement-time-reconciliation.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const activationEnd = new Date("2026-10-31T09:30:00.000Z");

describe("Woo paid entitlement window", () => {
  it("uses exact 30-day durations and skips directly to the current covered window", () => {
    const now = new Date(activationEnd.getTime() + 45 * DAY_MS);
    const window = currentWooEntitlementWindow(activationEnd, now);

    expect(window.periodStart).toEqual(new Date(activationEnd.getTime() + 30 * DAY_MS));
    expect(window.periodEnd).toEqual(new Date(activationEnd.getTime() + 60 * DAY_MS));
    expect(window.periodEnd.getTime() - window.periodStart.getTime()).toBe(30 * DAY_MS);
    expect(window.periodStart.getTime()).toBeLessThanOrEqual(now.getTime());
    expect(window.periodEnd.getTime()).toBeGreaterThan(now.getTime());
  });

  it("keeps Woo payment dates outside Moda's indexed entitlement schedule", () => {
    const nextPaymentDate = new Date("2026-11-01T09:30:00.000Z");
    const scheduled = nextWooEntitlementReconciliationAt(
      activationEnd,
      new Date("2026-12-01T09:30:00.000Z"),
    );

    expect(scheduled).toEqual(activationEnd);
    expect(scheduled).not.toEqual(nextPaymentDate);
  });

  it("uses the provider coverage fence when it arrives before the next entitlement boundary", () => {
    const coverageEnd = new Date("2026-10-20T09:30:00.000Z");

    expect(nextWooEntitlementReconciliationAt(activationEnd, coverageEnd)).toEqual(coverageEnd);
  });

  it("rejects a future Moda boundary", () => {
    expect(() => currentWooEntitlementWindow(
      activationEnd,
      new Date(activationEnd.getTime() - 1),
    )).toThrow("not due");
  });
});

describe("Woo paid entitlement time reconciliation scheduling", () => {
  it("selects only due Woo paid active subscriptions", async () => {
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      shop: { findUnique: vi.fn().mockResolvedValue({ platform: "WOOCOMMERCE", status: "ACTIVE" }) },
      subscription: {
        findMany: vi.fn().mockResolvedValue([{ id: "sub-1", shopId: "shop-1" }]),
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };
    const database = {
      subscription: transaction.subscription,
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)),
    };
    const service = new WooPaidEntitlementTimeReconciliationService(
      database as never,
      { schedule: vi.fn() },
      () => new Date("2026-10-31T09:30:00.000Z"),
    );
    const result = await service.reconcileOnce(10);

    expect(result).toMatchObject({ selected: 1, unchanged: 1, errors: 0 });
    expect(transaction.subscription.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: "ACTIVE",
        providerSubscriptionId: { not: null },
        shop: { is: { platform: "WOOCOMMERCE", status: "ACTIVE" } },
        OR: expect.arrayContaining([
          { nextReconcileAt: { lte: new Date("2026-10-31T09:30:00.000Z") } },
          { nextReconcileAt: null, providerCoverageEndAt: { not: null } },
        ]),
      }),
    }));
  });

  it.each([
    { title: "normal rollover", daysLate: 0, cancelAtPeriodEnd: false },
    { title: "restored coverage after multiple missed boundaries opens only the current window", daysLate: 75, cancelAtPeriodEnd: false },
    { title: "scheduled cancellation before provider end", daysLate: 0, cancelAtPeriodEnd: true },
  ])("$title advances once using the current plan and resumes after commit", async ({ daysLate, cancelAtPeriodEnd }) => {
    const now = new Date(activationEnd.getTime() + daysLate * DAY_MS);
    const coverageEnd = new Date(now.getTime() + 31 * DAY_MS);
    const state = currentSubscription({ now, coverageEnd, cancelAtPeriodEnd });
    const harness = transitionHarness(state, now);
    const resume = { schedule: vi.fn(async () => {
      expect(harness.committed).toBe(true);
      return "resume-job";
    }) };
    const service = new WooPaidEntitlementTimeReconciliationService(
      harness.database as never,
      resume,
      () => now,
    );

    const result = await service.reconcileOnce(10);
    const expectedStart = new Date(activationEnd.getTime() + Math.floor(daysLate / 30) * 30 * DAY_MS);

    expect(result).toMatchObject({ selected: 1, rolledOver: 1, errors: 0 });
    expect(harness.transaction.billingPeriod.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        periodStart: expectedStart,
        periodEnd: new Date(expectedStart.getTime() + 30 * DAY_MS),
        planId: "plan-switched-during-period",
        includedRecoveryCreditsGranted: 80,
      }),
    }));
    expect(harness.transaction.billingPeriodEntitlementCounter.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { currentAllowanceQuantity: 80 },
    }));
    expect(harness.transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ currentPeriodStart: expectedStart }),
    }));
    expect(resume.schedule).toHaveBeenCalledWith({ shopId: "shop-1", trigger: "woo-billing-period-rollover" });
    const duplicate = await service.reconcileOnce(10);
    expect(duplicate.selected).toBe(0);
    expect(harness.transaction.billingPeriod.create).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent worker scans and re-reads the period after the first commit", async () => {
    const now = new Date("2026-10-31T09:30:00.000Z");
    const state = currentSubscription({
      now,
      coverageEnd: new Date("2026-12-01T09:30:00.000Z"),
      cancelAtPeriodEnd: false,
    });
    const harness = transitionHarness(state, now);
    const resume = { schedule: vi.fn(async () => "resume-job") };
    const first = new WooPaidEntitlementTimeReconciliationService(harness.database as never, resume, () => now);
    const second = new WooPaidEntitlementTimeReconciliationService(harness.database as never, resume, () => now);

    const results = await Promise.all([first.reconcileOnce(10), second.reconcileOnce(10)]);

    expect(results.reduce((count, result) => count + result.rolledOver, 0)).toBe(1);
    expect(results.reduce((count, result) => count + result.unchanged, 0)).toBe(1);
    expect(harness.transaction.billingPeriod.create).toHaveBeenCalledTimes(1);
    expect(resume.schedule).toHaveBeenCalledTimes(1);
  });

  it("freezes when non-canceled provider coverage expires without granting", async () => {
    const now = new Date("2026-10-31T09:30:00.000Z");
    const state = currentSubscription({ now, coverageEnd: now, cancelAtPeriodEnd: false });
    const harness = transitionHarness(state, now);
    const service = new WooPaidEntitlementTimeReconciliationService(
      harness.database as never,
      { schedule: vi.fn() },
      () => now,
    );

    const result = await service.reconcileOnce(10);

    expect(result).toMatchObject({ selected: 1, frozen: 1, errors: 0 });
    expect(harness.transaction.subscription.update).toHaveBeenCalledWith({
      where: { id: "subscription-1" },
      data: { status: "FROZEN", nextReconcileAt: null, lastSyncedAt: now },
    });
    expect(harness.transaction.billingPeriod.create).not.toHaveBeenCalled();
    expect(harness.transaction.billingPeriod.updateMany).not.toHaveBeenCalled();
  });

  it("finalizes a scheduled cancellation at the coverage deadline and never resumes paid capacity", async () => {
    const now = new Date("2026-11-02T09:30:00.000Z");
    const coverageEnd = new Date("2026-11-01T09:30:00.000Z");
    const state = currentSubscription({ now, coverageEnd, cancelAtPeriodEnd: true });
    const laterPeriodEnd = new Date("2026-11-30T09:30:00.000Z");
    state.currentPeriodEnd = laterPeriodEnd;
    state.billingPeriod.periodEnd = laterPeriodEnd;
    const harness = transitionHarness(state, now);
    harness.transaction.billingPlan = {
      findMany: vi.fn().mockResolvedValue([{ id: "free-plan" }]),
    };
    const resume = { schedule: vi.fn() };
    const service = new WooPaidEntitlementTimeReconciliationService(
      harness.database as never,
      resume,
      () => now,
    );

    const result = await service.reconcileOnce(10);

    expect(result).toMatchObject({ selected: 1, ended: 1, errors: 0 });
    expect(harness.transaction.billingPeriod.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { periodEnd: coverageEnd },
    }));
    expect(harness.transaction.billingPeriod.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "CLOSED", closeReason: "CONTRACT_ENDED" }),
    }));
    expect(harness.transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "ACTIVE",
        planId: "free-plan",
        providerSubscriptionId: null,
        providerCoverageEndAt: null,
        billingPeriodId: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      }),
    }));
    expect(resume.schedule).not.toHaveBeenCalled();
  });
});

function currentSubscription(input: {
  now: Date;
  coverageEnd: Date;
  cancelAtPeriodEnd: boolean;
}) {
  return {
    id: "subscription-1",
    shopId: "shop-1",
    status: "ACTIVE",
    planId: "plan-switched-during-period",
    providerSubscriptionId: "woo-contract-1",
    providerCoverageEndAt: input.coverageEnd,
    cancelAtPeriodEnd: input.cancelAtPeriodEnd,
    billingPeriodId: "period-old",
    currentPeriodStart: new Date("2026-10-01T09:30:00.000Z"),
    currentPeriodEnd: activationEnd,
    nextReconcileAt: input.now,
    plan: {
      id: "plan-switched-during-period",
      kind: "PAID_METERED",
      name: "Current paid plan",
      shopifyPlanHandle: "current-plan-handle",
      includedRecoveryConversationAllowance: 80,
    },
    billingPeriod: {
      id: "period-old",
      status: "OPEN",
      planKindSnapshot: "PAID_METERED",
      periodStart: new Date("2026-10-01T09:30:00.000Z"),
      periodEnd: activationEnd,
    },
  };
}

function transitionHarness(state: ReturnType<typeof currentSubscription>, now: Date) {
  let due = true;
  let committed = false;
  let transactionTail = Promise.resolve();
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    shop: { findUnique: vi.fn().mockResolvedValue({ platform: "WOOCOMMERCE", status: "ACTIVE" }) },
    subscription: {
      findMany: vi.fn(),
      findUnique: vi.fn().mockResolvedValue(state),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (data.nextReconcileAt === null || data.currentPeriodEnd instanceof Date) due = false;
        Object.assign(state, data);
        if (data.billingPeriodId === "period-new"
          && data.currentPeriodStart instanceof Date
          && data.currentPeriodEnd instanceof Date) {
          state.billingPeriod = {
            ...state.billingPeriod,
            id: "period-new",
            periodStart: data.currentPeriodStart,
            periodEnd: data.currentPeriodEnd,
          };
        }
      }),
    },
    billingPeriod: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "period-new" }),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    billingPeriodEntitlementCounter: {
      findUnique: vi.fn()
        .mockResolvedValueOnce({ id: "counter-old", grantedQuantity: 100, committedQuantity: 20, reservedQuantity: 0, forfeitedQuantity: 0, version: 1 })
        .mockResolvedValueOnce({ id: "counter-old", grantedQuantity: 100, committedQuantity: 20, reservedQuantity: 0, forfeitedQuantity: 80, version: 2 })
        .mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    usageEvent: { updateMany: vi.fn() },
    usageReservation: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: 0 } }),
      updateMany: vi.fn(),
    },
    billingPlan: { findMany: vi.fn() },
  };
  const database = {
    subscription: {
      findMany: vi.fn(async () => due ? [{ id: state.id, shopId: state.shopId }] : []),
    },
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => {
      const previous = transactionTail;
      let release = () => {};
      transactionTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        const result = await callback(transaction);
        committed = true;
        return result;
      } finally {
        release();
      }
    }),
  };
  return { transaction, database, get committed() { return committed; }, now };
}