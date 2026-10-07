import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { RefundCompletionService } from "../../../../src/services/recovery-credit-refund-correction/refund-completion.service.js";
import type { RefundRow } from "../../../../src/services/recovery-credit-refund-correction/refund-correction.types.js";

const now = new Date("2026-10-07T18:00:00.000Z");

function refundRow(overrides: Partial<RefundRow> = {}): RefundRow {
  return {
    id: "refund-1",
    shopId: "shop-1",
    purchaseId: "purchase-1",
    finalCreditQuantity: 1,
    expectedProviderAmount: new Prisma.Decimal("1.00"),
    automaticCorrectionUsageEventId: "correction-event-1",
    version: 7,
    ...overrides,
  } as RefundRow;
}

function harness() {
  const database = {
    recoveryCreditPurchase: {
      findUnique: vi.fn().mockResolvedValue({
        status: "WITHDRAWN",
        currentAmount: 1,
        reservedAmount: 0,
        version: 3,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    shopEntitlementCounter: {
      findUnique: vi.fn().mockResolvedValue({
        id: "counter-1",
        version: 4,
        refundingQuantity: 1,
        grantedQuantity: 1,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    recoveryCreditRefund: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    merchantSupportThread: {
      upsert: vi.fn().mockResolvedValue({ id: "thread-1" }),
      update: vi.fn().mockResolvedValue({ id: "thread-1" }),
    },
    merchantSupportMessage: {
      upsert: vi.fn().mockResolvedValue({ id: "message-1" }),
    },
    $transaction: vi.fn(),
  };
  database.$transaction.mockImplementation(async (callback: (transaction: typeof database) => unknown) => (
    callback(database)
  ));
  return {
    database,
    service: new RefundCompletionService(database as never, () => now),
  };
}

describe("RefundCompletionService", () => {
  it("atomically completes the financial refund and merchant billing message", async () => {
    const test = harness();

    await expect(test.service.complete(refundRow(), "USD")).resolves.toBe(true);

    expect(test.database.recoveryCreditPurchase.updateMany).toHaveBeenCalledWith({
      where: {
        id: "purchase-1",
        status: "WITHDRAWN",
        version: 3,
        reservedAmount: 0,
        currentAmount: 1,
      },
      data: {
        currentAmount: 0,
        status: "REFUNDED",
        version: { increment: 1 },
      },
    });
    expect(test.database.shopEntitlementCounter.updateMany).toHaveBeenCalledWith({
      where: {
        id: "counter-1",
        version: 4,
        refundingQuantity: { gte: 1 },
        grantedQuantity: { gte: 1 },
      },
      data: {
        refundingQuantity: { decrement: 1 },
        grantedQuantity: { decrement: 1 },
        version: { increment: 1 },
      },
    });
    expect(test.database.recoveryCreditRefund.updateMany).toHaveBeenCalledWith({
      where: {
        id: "refund-1",
        status: "REQUESTED",
        version: 7,
        automaticCorrectionUsageEventId: "correction-event-1",
      },
      data: expect.objectContaining({
        providerAmount: new Prisma.Decimal("1.00"),
        providerCurrency: "USD",
        providerConfirmedAt: now,
        providerConfirmedByPlatformAdminId: null,
        providerActionKind: null,
        status: "COMPLETED",
        completedAt: now,
        version: { increment: 1 },
      }),
    });
    expect(test.database.merchantSupportMessage.upsert).toHaveBeenCalledWith({
      where: { sourceKey: expect.any(String) },
      create: expect.objectContaining({
        threadId: "thread-1",
        kind: "SYSTEM",
        state: "AVAILABLE",
        sourceLanguageTag: "en-GB",
        systemCode: "BILLING_REFUND_COMPLETED",
        availableAt: now,
      }),
      update: {},
    });
    expect(test.database.merchantSupportThread.update).toHaveBeenCalledWith({
      where: { id: "thread-1" },
      data: { lastMessageAt: now },
    });
    expect(test.database.$transaction).toHaveBeenCalledTimes(1);
  });

  it("returns false before mutation when purchase or counter state is no longer completable", async () => {
    const test = harness();
    test.database.recoveryCreditPurchase.findUnique.mockResolvedValue({
      status: "WITHDRAWN",
      currentAmount: 1,
      reservedAmount: 1,
      version: 3,
    });

    await expect(test.service.complete(refundRow(), "USD")).resolves.toBe(false);

    expect(test.database.recoveryCreditPurchase.updateMany).not.toHaveBeenCalled();
    expect(test.database.shopEntitlementCounter.updateMany).not.toHaveBeenCalled();
    expect(test.database.recoveryCreditRefund.updateMany).not.toHaveBeenCalled();
    expect(test.database.merchantSupportMessage.upsert).not.toHaveBeenCalled();
  });

  it("fails the transaction before publishing the merchant message when a financial CAS loses", async () => {
    const test = harness();
    test.database.shopEntitlementCounter.updateMany.mockResolvedValue({ count: 0 });

    await expect(test.service.complete(refundRow(), "USD")).rejects.toThrow(
      "automatic refund completion CAS failed",
    );

    expect(test.database.merchantSupportThread.upsert).not.toHaveBeenCalled();
    expect(test.database.merchantSupportMessage.upsert).not.toHaveBeenCalled();
  });

  it("rejects incomplete frozen completion evidence without opening a transaction", async () => {
    const test = harness();

    await expect(test.service.complete(refundRow({ finalCreditQuantity: null }), "USD")).resolves.toBe(false);

    expect(test.database.$transaction).not.toHaveBeenCalled();
  });
});
