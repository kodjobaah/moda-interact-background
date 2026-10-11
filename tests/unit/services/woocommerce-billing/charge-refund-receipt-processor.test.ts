import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  correlate: vi.fn(),
  settle: vi.fn(),
}));

vi.mock("../../../../src/services/woocommerce-billing/charge-receipt-correlation.js", () => ({
  correlateAndLockChargePurchase: mocks.correlate,
}));
vi.mock("../../../../src/services/woocommerce-billing/charge-refund-settlement.js", () => ({
  settleWooRefundReceipt: mocks.settle,
}));

import { processNextWooRefundReceipt } from "../../../../src/services/woocommerce-billing/charge-refund-receipt-processor.js";

function harness() {
  const receipt = {
    id: "receipt-1",
    topic: "saas_billing_contract.refunded",
    providerContractId: "charge-1",
    normalizedPayload: { charge: { id: "charge-1", status: "refunded" } },
    billingOperationId: "operation-1",
    receivedAt: new Date("2026-10-11T00:00:00Z"),
  };
  const queryRaw = vi.fn().mockResolvedValue([receipt]);
  const receiptUpdate = vi.fn().mockResolvedValue({ count: 1 });
  const transaction = {
    $queryRaw: queryRaw,
    wooCommerceBillingWebhookReceipt: { updateMany: receiptUpdate },
  };
  const database = {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(transaction)),
  };
  return { receipt, database, transaction, queryRaw, receiptUpdate };
}

describe("processNextWooRefundReceipt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.correlate.mockResolvedValue({ errorCode: "CHARGE_CORRELATION_NOT_READY" });
    mocks.settle.mockResolvedValue(null);
  });

  it("leaves an unmatched provider refund retryable and creates no local refund", async () => {
    const test = harness();

    await expect(processNextWooRefundReceipt(test.database as never, new Date(), null)).resolves
      .toMatchObject({ outcome: "retryable", processingError: "WOO_REFUND_REQUEST_NOT_FOUND" });
    expect(test.receiptUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { processingError: "WOO_REFUND_REQUEST_NOT_FOUND" },
    }));
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it("correlates the exact contract and operation before settling a refunded receipt", async () => {
    const test = harness();
    const link = { shop: { id: "shop-1" }, operation: { id: "operation-1" }, purchase: { id: "purchase-1" } };
    mocks.correlate.mockResolvedValueOnce({ link });

    await expect(processNextWooRefundReceipt(test.database as never, new Date("2026-10-11T00:00:01Z"), null))
      .resolves.toMatchObject({ outcome: "processed" });
    expect(mocks.correlate).toHaveBeenCalledWith(
      test.transaction,
      "charge-1",
      "operation-1",
    );
    expect(mocks.settle).toHaveBeenCalledWith(
      test.transaction,
      link,
      test.receipt,
      "charge-1",
      null,
      new Date("2026-10-11T00:00:01Z"),
    );
  });

  it("records invalid provider money without asking correlation or settlement to mutate allowance", async () => {
    const test = harness();
    test.receipt.normalizedPayload = {
      charge: {
        id: "charge-1",
        status: "refunded",
        transactions: [{ completed_at: "2026-10-10T00:00:00Z", amount_refunded: "NaN" }],
      },
    };

    await expect(processNextWooRefundReceipt(test.database as never, new Date(), null)).resolves
      .toMatchObject({ outcome: "retryable", processingError: "WOO_REFUND_AMOUNT_EVIDENCE_INVALID" });
    expect(mocks.correlate).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
  });
});