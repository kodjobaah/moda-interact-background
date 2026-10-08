import { describe, expect, it, vi } from "vitest";

import { closeBillingPeriod } from "../../../../src/services/billing-period-transition/close-billing-period.js";

function transactionHarness() {
  let counter = {
    id: "counter-1",
    grantedQuantity: 10,
    committedQuantity: 4,
    reservedQuantity: 2,
    forfeitedQuantity: 0,
    version: 3,
  };
  const transaction = {
    usageEvent: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    usageReservation: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: 2 } }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    billingPeriodEntitlementCounter: {
      findUnique: vi.fn(async (input: any) => {
        if (input?.where?.id === counter.id) return { ...counter };
        if (input?.where?.billingPeriodId_counter?.billingPeriodId === "period-1") return { ...counter };
        return null;
      }),
      updateMany: vi.fn(async (input: any) => {
        counter = {
          ...counter,
          reservedQuantity: counter.reservedQuantity - Number(input.data.reservedQuantity.decrement ?? 0),
          forfeitedQuantity: counter.forfeitedQuantity + Number(input.data.forfeitedQuantity.increment ?? 0),
          version: counter.version + Number(input.data.version.increment ?? 0),
        };
        return { count: 1 };
      }),
    },
    billingPeriod: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return transaction;
}

describe("closeBillingPeriod", () => {
  it("closes a Paid period with canonical reservation release and counter invariants", async () => {
    const transaction = transactionHarness();
    const closedAt = new Date("2026-10-01T00:00:00.000Z");

    await closeBillingPeriod(transaction as never, {
      billingPeriodId: "period-1",
      planKind: "PAID_METERED",
      closedAt,
      closeReason: "PLAN_CHANGED",
      openPeriodFailureMessage: "period close failed",
      providerResponseSummary: "Billing period closed before Shopify App Event report",
    });

    expect(transaction.usageEvent.updateMany).toHaveBeenCalledWith({
      where: {
        billingPeriodId: "period-1",
        shopifyReportState: { in: ["PENDING", "RETRYABLE"] },
      },
      data: {
        shopifyReportState: "NEEDS_ATTENTION",
        nextReportAt: null,
        providerErrorCode: "PERIOD_CLOSED_BEFORE_REPORT",
        providerResponseSummary: "Billing period closed before Shopify App Event report",
      },
    });
    expect(transaction.usageReservation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: "RELEASED", releaseReason: "PERIOD_CLOSED" },
    }));
    expect(transaction.billingPeriodEntitlementCounter.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "counter-1", version: 3, reservedQuantity: 2 },
      data: expect.objectContaining({
        reservedQuantity: { decrement: 2 },
        forfeitedQuantity: { increment: 6 },
      }),
    }));
    expect(transaction.billingPeriod.updateMany).toHaveBeenCalledWith({
      where: { id: "period-1", status: "OPEN" },
      data: { status: "CLOSED", closedAt, closeReason: "PLAN_CHANGED" },
    });
  });

  it("closes a Free period without touching an included-credit counter", async () => {
    const transaction = transactionHarness();

    await closeBillingPeriod(transaction as never, {
      billingPeriodId: "period-1",
      planKind: "FREE",
      closedAt: new Date("2026-10-01T00:00:00.000Z"),
      closeReason: "CONTRACT_ENDED",
      openPeriodFailureMessage: "period close failed",
    });

    expect(transaction.billingPeriodEntitlementCounter.findUnique).not.toHaveBeenCalled();
    expect(transaction.usageReservation.aggregate).not.toHaveBeenCalled();
    expect(transaction.usageEvent.updateMany.mock.calls[0][0].data).not.toHaveProperty("providerResponseSummary");
  });

  it("fails before closing the period when the Paid counter does not close cleanly", async () => {
    const transaction = transactionHarness();
    transaction.billingPeriodEntitlementCounter.findUnique
      .mockReset()
      .mockResolvedValueOnce({ id: "counter-1", grantedQuantity: 10, committedQuantity: 4, reservedQuantity: 2, forfeitedQuantity: 0, version: 3 })
      .mockResolvedValueOnce({ id: "counter-1", grantedQuantity: 10, committedQuantity: 4, reservedQuantity: 0, forfeitedQuantity: 5, version: 4 });

    await expect(closeBillingPeriod(transaction as never, {
      billingPeriodId: "period-1",
      planKind: "PAID_METERED",
      closedAt: new Date("2026-10-01T00:00:00.000Z"),
      closeReason: "RENEWED_SAME_PLAN",
      openPeriodFailureMessage: "period close failed",
    })).rejects.toThrow("did not close cleanly");

    expect(transaction.billingPeriod.updateMany).not.toHaveBeenCalled();
  });

  it("preserves the caller-specific failure when the period is no longer OPEN", async () => {
    const transaction = transactionHarness();
    transaction.billingPeriod.updateMany.mockResolvedValue({ count: 0 });

    await expect(closeBillingPeriod(transaction as never, {
      billingPeriodId: "period-1",
      planKind: "FREE",
      closedAt: new Date("2026-10-01T00:00:00.000Z"),
      closeReason: "CONTRACT_ENDED",
      openPeriodFailureMessage: "Billing period was not open while closing contract",
    })).rejects.toThrow("Billing period was not open while closing contract");
  });
});
