import type { Prisma } from "@prisma/client";

export async function recordChargeReceiptError(
  transaction: Prisma.TransactionClient,
  receiptId: string,
  code: string,
  operationId?: string,
): Promise<void> {
  const updated = await transaction.wooCommerceBillingWebhookReceipt.updateMany({
    where: { id: receiptId, processedAt: null },
    data: { processingError: code, ...(operationId ? { billingOperationId: operationId } : {}) },
  });
  if (updated.count !== 1) throw new Error("Woo charge receipt claim was lost before error recording");
}

export async function completeChargeReceipt(
  transaction: Prisma.TransactionClient,
  receiptId: string,
  processedAt: Date,
  operationId: string,
): Promise<void> {
  const updated = await transaction.wooCommerceBillingWebhookReceipt.updateMany({
    where: { id: receiptId, processedAt: null },
    data: { processedAt, processingError: null, billingOperationId: operationId },
  });
  if (updated.count !== 1) throw new Error("Woo charge receipt claim was lost before completion");
}