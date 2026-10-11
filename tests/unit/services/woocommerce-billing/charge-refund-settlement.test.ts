import { Prisma, RecoveryCreditPurchaseStatus, RecoveryCreditRefundStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { settleWooRefundReceipt } from "../../../../src/services/woocommerce-billing/charge-refund-settlement.js";

function harness() {
  const refundUpdate = vi.fn().mockResolvedValue({ count: 1 });
  const purchaseUpdate = vi.fn().mockResolvedValue({ count: 1 });
  const counterUpdate = vi.fn().mockResolvedValue({ count: 1 });
  const receiptUpdate = vi.fn().mockResolvedValue({ count: 1 });
  const transaction = {
    recoveryCreditRefund: {
      findMany: vi.fn().mockResolvedValue([{
        id: "refund-1",
        shopId: "shop-1",
        purchaseId: "purchase-1",
        provider: "WOOCOMMERCE",
        status: RecoveryCreditRefundStatus.PROVIDER_ACTION_REQUIRED,
        finalCreditQuantity: 4,
        expectedProviderAmount: null,
        expectedProviderCurrency: null,
        providerReference: null,
        version: 2,
      }]),
      updateMany: refundUpdate,
    },
    recoveryCreditPurchase: { updateMany: purchaseUpdate },
    shopEntitlementCounter: { updateMany: counterUpdate },
    wooCommerceBillingWebhookReceipt: { updateMany: receiptUpdate },
    merchantSupportThread: { upsert: vi.fn().mockResolvedValue({ id: "thread-1" }), update: vi.fn() },
    merchantSupportMessage: { upsert: vi.fn() },
  };
  const link = {
    shop: { id: "shop-1" },
    operation: { id: "operation-1", state: "CONFIRMED" },
    purchase: {
      id: "purchase-1",
      provider: "WOOCOMMERCE",
      providerReference: "charge-1",
      status: RecoveryCreditPurchaseStatus.WITHDRAWN,
      reservedAmount: 0,
      currentAmount: 4,
      version: 5,
    },
    counter: { id: "counter-1", version: 6, refundingQuantity: 4, grantedQuantity: 4 },
  } as never;
  return { transaction, link, refundUpdate, purchaseUpdate, counterUpdate, receiptUpdate };
}

describe("settleWooRefundReceipt", () => {
  it("completes the held allowance without a provider amount", async () => {
    const test = harness();

    await expect(settleWooRefundReceipt(
      test.transaction as never,
      test.link,
      { id: "receipt-1", receivedAt: new Date("2026-10-11T00:00:00Z") },
      "charge-1",
      null,
      new Date("2026-10-11T00:00:01Z"),
    )).resolves.toBeNull();

    expect(test.purchaseUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: RecoveryCreditPurchaseStatus.REFUNDED, currentAmount: 0 }),
    }));
    expect(test.counterUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { refundingQuantity: { decrement: 4 }, grantedQuantity: { decrement: 4 }, version: { increment: 1 } },
    }));
    expect(test.refundUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        providerReference: "charge-1",
        providerActionKind: "REFUND",
        status: RecoveryCreditRefundStatus.COMPLETED,
      }),
    }));
    expect(test.receiptUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ processedAt: expect.any(Date), processingError: null }),
    }));
  });

  it("stores different provider money only as optional evidence", async () => {
    const test = harness();

    await settleWooRefundReceipt(
      test.transaction as never,
      test.link,
      { id: "receipt-1", receivedAt: new Date("2026-10-11T00:00:00Z") },
      "charge-1",
      { amount: new Prisma.Decimal("999.99"), currency: "USD" },
      new Date("2026-10-11T00:00:01Z"),
    );

    expect(test.refundUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ providerAmount: new Prisma.Decimal("999.99"), providerCurrency: "USD" }),
    }));
    expect(test.purchaseUpdate).toHaveBeenCalledOnce();
  });

  it("leaves a rejected refund and allowance untouched when a refunded receipt conflicts", async () => {
    const test = harness();
    test.transaction.recoveryCreditRefund.findMany.mockResolvedValueOnce([{
      id: "refund-1",
      shopId: "shop-1",
      purchaseId: "purchase-1",
      provider: "WOOCOMMERCE",
      status: RecoveryCreditRefundStatus.REJECTED,
      finalCreditQuantity: 4,
      expectedProviderAmount: null,
      expectedProviderCurrency: null,
      providerReference: null,
      version: 2,
    }]);

    await expect(settleWooRefundReceipt(
      test.transaction as never,
      test.link,
      { id: "receipt-1", receivedAt: new Date("2026-10-11T00:00:00Z") },
      "charge-1",
      null,
      new Date("2026-10-11T00:00:01Z"),
    )).resolves.toBe("WOO_REFUND_AFTER_REJECTION_CONFLICT");
    expect(test.purchaseUpdate).not.toHaveBeenCalled();
    expect(test.counterUpdate).not.toHaveBeenCalled();
    expect(test.refundUpdate).not.toHaveBeenCalled();
  });
});