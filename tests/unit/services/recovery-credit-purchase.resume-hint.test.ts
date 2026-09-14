import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  schedule: vi.fn(),
}));

vi.mock("../../../src/lib/db.js", () => ({
  default: {},
}));

vi.mock("../../../src/services/recovery-capacity-resume.service.js", () => ({
  recoveryCapacityResumeService: {
    schedule: hoisted.schedule,
  },
}));

import { RecoveryCreditPurchaseService } from "../../../src/services/recovery-credit-purchase.service.js";

const input = {
  shopId: "shop-1",
  billingPeriodId: "period-1",
  providerPlanHandle: "pro-2026",
  packMeterHandle: "pack-meter",
  providerSubscriptionId: "subscription-1",
  providerUnits: 3,
  providerCostAmount: "12.50",
  providerCostCurrency: "USD",
};

function activatedHarness(events: string[]) {
  const transaction = {
    recoveryCreditPurchase: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => [
        {
          id: "purchase-1",
          creditsGranted: 5,
          version: 0,
          currentAmount: 0,
          reservedAmount: 0,
          providerSubscriptionIdSnapshot: "subscription-1",
          providerUsageQuantityBeforeSnapshot: 2,
          providerUsageCostBeforeSnapshot: "10.00",
          providerUsageCostCurrencyBeforeSnapshot: "USD",
        },
      ]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    shopEntitlementCounter: {
      upsert: vi.fn(async () => ({ id: "counter-1" })),
    },
  };

  const database = {
    recoveryCreditPurchase: {},
    shopEntitlementCounter: {},
    usageEvent: {},
    $transaction: vi.fn(
      async (
        callback: (tx: typeof transaction) => Promise<unknown>,
      ) => {
        events.push("transaction-start");
        const result = await callback(transaction);
        events.push("transaction-complete");
        return result;
      },
    ),
  };

  return {
    service: new RecoveryCreditPurchaseService(
      database as never,
      3,
      () => new Date("2026-09-13T12:00:00.000Z"),
    ),
    database,
    transaction,
  };
}

function zeroActivationHarness(events: string[]) {
  const transaction = {
    recoveryCreditPurchase: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(),
    },
    shopEntitlementCounter: {
      upsert: vi.fn(),
    },
  };

  const database = {
    recoveryCreditPurchase: {},
    shopEntitlementCounter: {},
    usageEvent: {},
    $transaction: vi.fn(
      async (
        callback: (tx: typeof transaction) => Promise<unknown>,
      ) => {
        events.push("transaction-start");
        const result = await callback(transaction);
        events.push("transaction-complete");
        return result;
      },
    ),
  };

  return {
    service: new RecoveryCreditPurchaseService(
      database as never,
      3,
      () => new Date("2026-09-13T12:00:00.000Z"),
    ),
    database,
    transaction,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RecoveryCreditPurchaseService capacity-resume hint", () => {
  it("schedules the tenant resume hint only after a committed activation transaction", async () => {
    const events: string[] = [];
    const test = activatedHarness(events);
    hoisted.schedule.mockImplementation(async () => {
      events.push("schedule");
      return "job-id";
    });

    const result = await test.service.reconcileProviderConfirmed(input);
    events.push("method-return");

    expect(result).toMatchObject({
      activatedCount: 1,
      alreadyMatchedUnits: 0,
      eligibleCandidateCount: 1,
      confirmedDelta: 1,
      discrepancy: null,
    });
    expect(events).toEqual([
      "transaction-start",
      "transaction-complete",
      "schedule",
      "method-return",
    ]);
    expect(hoisted.schedule).toHaveBeenCalledTimes(1);
    expect(hoisted.schedule).toHaveBeenCalledWith({
      shopId: "shop-1",
      trigger: "purchase-activation-period-1",
    });
    expect(test.transaction.recoveryCreditPurchase.updateMany).toHaveBeenCalledTimes(1);
    expect(test.transaction.shopEntitlementCounter.upsert).toHaveBeenCalledTimes(1);
  });

  it("does not schedule a resume hint when reconciliation activates no purchase", async () => {
    const events: string[] = [];
    const test = zeroActivationHarness(events);

    const result = await test.service.reconcileProviderConfirmed({
      ...input,
      providerUnits: 0,
    });
    events.push("method-return");

    expect(result).toMatchObject({
      activatedCount: 0,
      alreadyMatchedUnits: 0,
      eligibleCandidateCount: 0,
      confirmedDelta: 0,
      discrepancy: null,
    });
    expect(events).toEqual([
      "transaction-start",
      "transaction-complete",
      "method-return",
    ]);
    expect(hoisted.schedule).not.toHaveBeenCalled();
    expect(test.transaction.recoveryCreditPurchase.updateMany).not.toHaveBeenCalled();
    expect(test.transaction.shopEntitlementCounter.upsert).not.toHaveBeenCalled();
  });

  it("returns the committed activation result when resume scheduling fails after commit", async () => {
    const events: string[] = [];
    const test = activatedHarness(events);
    const error = new Error("redis unavailable");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    hoisted.schedule.mockImplementation(async () => {
      events.push("schedule");
      throw error;
    });

    await expect(test.service.reconcileProviderConfirmed(input)).resolves.toMatchObject({
      activatedCount: 1,
      confirmedDelta: 1,
    });
    events.push("method-return");

    expect(events).toEqual([
      "transaction-start",
      "transaction-complete",
      "schedule",
      "method-return",
    ]);
    expect(test.database.$transaction).toHaveBeenCalledTimes(1);
    expect(test.transaction.recoveryCreditPurchase.updateMany).toHaveBeenCalledTimes(1);
    expect(test.transaction.shopEntitlementCounter.upsert).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to schedule capacity resume after purchase activation for shop shop-1",
      error,
    );

    consoleError.mockRestore();
  });
});
