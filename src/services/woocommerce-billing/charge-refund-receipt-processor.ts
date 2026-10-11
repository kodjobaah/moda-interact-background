import { Prisma, type PrismaClient } from "@prisma/client";

import { correlateAndLockChargePurchase } from "./charge-receipt-correlation.js";
import { parseWooRefundEvidence } from "./charge-refund-evidence.js";
import { settleWooRefundReceipt } from "./charge-refund-settlement.js";

export type WooRefundReceiptCursor = { receivedAt: Date; id: string };
export type WooRefundReceiptDatabase = Pick<PrismaClient, "$transaction">;

type Receipt = {
  id: string;
  topic: string;
  providerContractId: string | null;
  normalizedPayload: Prisma.JsonValue;
  billingOperationId: string | null;
  receivedAt: Date;
};

export type WooRefundReceiptAttempt = {
  outcome: "empty" | "processed" | "retryable";
  cursor?: WooRefundReceiptCursor;
  processingError?: string;
};

export async function processNextWooRefundReceipt(
  database: WooRefundReceiptDatabase,
  now: Date,
  cursor: WooRefundReceiptCursor | null,
): Promise<WooRefundReceiptAttempt> {
  return withTransactionRetry(() => database.$transaction(async (transaction) => {
    const cursorFilter = cursor
      ? Prisma.sql`AND ("receivedAt", "id") > (${cursor.receivedAt}, ${cursor.id})`
      : Prisma.empty;
    const [receipt] = await transaction.$queryRaw<Receipt[]>(Prisma.sql`
      SELECT "id", "topic", "providerContractId", "normalizedPayload", "billingOperationId", "receivedAt"
      FROM "woocommerce"."WooCommerceBillingWebhookReceipt"
      WHERE "processedAt" IS NULL
        AND "topic" = 'saas_billing_contract.refunded'
        AND "normalizedPayload" ? 'charge'
        ${cursorFilter}
      ORDER BY "receivedAt" ASC, "id" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    if (!receipt) return { outcome: "empty" as const };
    const receiptCursor = { receivedAt: receipt.receivedAt, id: receipt.id };
    const evidence = parseWooRefundEvidence(receipt.normalizedPayload, receipt.providerContractId);
    if (evidence.errorCode) {
      await recordError(transaction, receipt.id, evidence.errorCode);
      return { outcome: "retryable" as const, cursor: receiptCursor, processingError: evidence.errorCode };
    }

    const correlation = await correlateAndLockChargePurchase(
      transaction,
      receipt.providerContractId!,
      receipt.billingOperationId,
    );
    if (!correlation.link) {
      const code = correlation.errorCode === "CHARGE_CORRELATION_NOT_READY"
        ? "WOO_REFUND_REQUEST_NOT_FOUND"
        : `WOO_REFUND_${correlation.errorCode}`;
      await recordError(transaction, receipt.id, code);
      return { outcome: "retryable" as const, cursor: receiptCursor, processingError: code };
    }

    const error = await settleWooRefundReceipt(
      transaction,
      correlation.link,
      receipt,
      receipt.providerContractId!,
      evidence.money,
      now,
    );
    return error
      ? { outcome: "retryable" as const, cursor: receiptCursor, processingError: error }
      : { outcome: "processed" as const, cursor: receiptCursor };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

async function recordError(
  transaction: Prisma.TransactionClient,
  receiptId: string,
  code: string,
): Promise<void> {
  const updated = await transaction.wooCommerceBillingWebhookReceipt.updateMany({
    where: { id: receiptId, processedAt: null },
    data: { processingError: code.slice(0, 128) },
  });
  if (updated.count !== 1) throw new Error("Woo refund receipt claim was lost before error recording");
}

async function withTransactionRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError)
        || !["P2002", "P2034"].includes(error.code) || attempt === 2) throw error;
    }
  }
  throw new Error("Woo refund receipt transaction retry limit exceeded");
}