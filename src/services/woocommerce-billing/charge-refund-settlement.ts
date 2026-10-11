import {
  Prisma,
  RecoveryCreditPurchaseStatus,
  RecoveryCreditRefundStatus,
} from "@prisma/client";
import type { Prisma as PrismaTypes } from "@prisma/client";

import { createRefundCompletionSupportMessage } from "../recovery-credit-refund-correction/refund-completion-support-message.js";
import type { WooRefundMoneyEvidence } from "./charge-refund-evidence.js";
import type { ChargeReceiptLink } from "./charge-receipt-correlation.js";

const WOO_REFUND_STATES = [
  RecoveryCreditRefundStatus.REQUESTED,
  RecoveryCreditRefundStatus.PROVIDER_ACTION_REQUIRED,
  RecoveryCreditRefundStatus.NEEDS_ATTENTION,
  RecoveryCreditRefundStatus.REJECTED,
  RecoveryCreditRefundStatus.COMPLETED,
] as const;

type RefundForSettlement = {
  id: string;
  shopId: string;
  purchaseId: string;
  provider: string;
  status: RecoveryCreditRefundStatus;
  finalCreditQuantity: number | null;
  expectedProviderAmount: Prisma.Decimal | null;
  expectedProviderCurrency: string | null;
  providerReference: string | null;
  version: number;
};

type RefundReceipt = { id: string; receivedAt: Date };

export async function settleWooRefundReceipt(
  transaction: Prisma.TransactionClient,
  link: ChargeReceiptLink,
  receipt: RefundReceipt,
  providerContractId: string,
  money: WooRefundMoneyEvidence | null,
  now: Date,
): Promise<string | null> {
  const refunds = await transaction.recoveryCreditRefund.findMany({
    where: { purchaseId: link.purchase.id, provider: "WOOCOMMERCE", status: { in: [...WOO_REFUND_STATES] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 2,
    select: {
      id: true,
      shopId: true,
      purchaseId: true,
      provider: true,
      status: true,
      finalCreditQuantity: true,
      expectedProviderAmount: true,
      expectedProviderCurrency: true,
      providerReference: true,
      version: true,
    },
  });
  if (refunds.length === 0) return markReceiptError(transaction, receipt.id, "WOO_REFUND_REQUEST_NOT_FOUND", link.operation.id);
  if (refunds.length !== 1) return markReceiptError(transaction, receipt.id, "WOO_REFUND_REQUEST_AMBIGUOUS", link.operation.id);
  const refund = refunds[0] as RefundForSettlement;

  if (refund.status === RecoveryCreditRefundStatus.REJECTED) {
    return markReceiptError(transaction, receipt.id, "WOO_REFUND_AFTER_REJECTION_CONFLICT", link.operation.id);
  }
  if (refund.status === RecoveryCreditRefundStatus.COMPLETED) {
    if (link.purchase.status !== RecoveryCreditPurchaseStatus.REFUNDED
      || refund.providerReference !== providerContractId) {
      return markReceiptError(transaction, receipt.id, "WOO_REFUND_STATE_CONFLICT", link.operation.id);
    }
    await markReceiptProcessed(transaction, receipt.id, receipt.receivedAt, link.operation.id);
    return null;
  }
  if (refund.status !== RecoveryCreditRefundStatus.PROVIDER_ACTION_REQUIRED) {
    return markReceiptError(transaction, receipt.id, "WOO_REFUND_HOLD_NOT_READY", link.operation.id);
  }

  const quantity = refund.finalCreditQuantity;
  const counter = link.counter;
  if (refund.shopId !== link.shop.id || refund.purchaseId !== link.purchase.id
    || refund.provider !== "WOOCOMMERCE" || quantity === null || quantity <= 0
    || refund.expectedProviderAmount !== null || refund.expectedProviderCurrency !== null
    || link.operation.state !== "CONFIRMED"
    || link.purchase.provider !== "WOOCOMMERCE"
    || link.purchase.providerReference !== providerContractId
    || link.purchase.status !== RecoveryCreditPurchaseStatus.WITHDRAWN
    || link.purchase.reservedAmount !== 0 || link.purchase.currentAmount !== quantity
    || !counter || counter.refundingQuantity < quantity || counter.grantedQuantity < quantity) {
    await transaction.recoveryCreditRefund.updateMany({
      where: { id: refund.id, status: RecoveryCreditRefundStatus.PROVIDER_ACTION_REQUIRED, version: refund.version },
      data: { status: RecoveryCreditRefundStatus.NEEDS_ATTENTION, reason: "WOO_REFUND_STATE_CONFLICT", version: { increment: 1 } },
    });
    return markReceiptError(transaction, receipt.id, "WOO_REFUND_STATE_CONFLICT", link.operation.id);
  }

  const purchaseUpdate = await transaction.recoveryCreditPurchase.updateMany({
    where: {
      id: link.purchase.id,
      provider: "WOOCOMMERCE",
      providerReference: providerContractId,
      status: RecoveryCreditPurchaseStatus.WITHDRAWN,
      version: link.purchase.version,
      reservedAmount: 0,
      currentAmount: quantity,
    },
    data: { status: RecoveryCreditPurchaseStatus.REFUNDED, currentAmount: 0, version: { increment: 1 } },
  });
  const counterUpdate = await transaction.shopEntitlementCounter.updateMany({
    where: {
      id: counter.id,
      version: counter.version,
      refundingQuantity: { gte: quantity },
      grantedQuantity: { gte: quantity },
    },
    data: {
      refundingQuantity: { decrement: quantity },
      grantedQuantity: { decrement: quantity },
      version: { increment: 1 },
    },
  });
  const refundUpdate = await transaction.recoveryCreditRefund.updateMany({
    where: {
      id: refund.id,
      provider: "WOOCOMMERCE",
      status: RecoveryCreditRefundStatus.PROVIDER_ACTION_REQUIRED,
      version: refund.version,
      finalCreditQuantity: quantity,
    },
    data: {
      providerReference: providerContractId,
      providerActionKind: "REFUND",
      providerConfirmedAt: receipt.receivedAt,
      providerConfirmedByPlatformAdminId: null,
      ...(money ? { providerAmount: money.amount, providerCurrency: money.currency } : {}),
      status: RecoveryCreditRefundStatus.COMPLETED,
      completedAt: now,
      version: { increment: 1 },
    },
  });
  if (purchaseUpdate.count !== 1 || counterUpdate.count !== 1 || refundUpdate.count !== 1) {
    throw new Error("Woo refund allowance settlement compare-and-set failed");
  }
  await createRefundCompletionSupportMessage(transaction, {
    shopId: link.shop.id,
    refundId: refund.id,
    body: "Your recovery-credit refund has completed. The refundable purchased credits have been removed after WooCommerce confirmed the provider refund.",
    availableAt: now,
  });
  await markReceiptProcessed(transaction, receipt.id, now, link.operation.id);
  return null;
}

async function markReceiptError(
  transaction: Prisma.TransactionClient,
  receiptId: string,
  code: string,
  operationId?: string,
): Promise<string> {
  await transaction.wooCommerceBillingWebhookReceipt.updateMany({
    where: { id: receiptId, processedAt: null },
    data: { processingError: code, ...(operationId ? { billingOperationId: operationId } : {}) },
  });
  return code;
}

async function markReceiptProcessed(
  transaction: Prisma.TransactionClient,
  receiptId: string,
  processedAt: Date,
  operationId: string,
): Promise<void> {
  const updated = await transaction.wooCommerceBillingWebhookReceipt.updateMany({
    where: { id: receiptId, processedAt: null },
    data: { processedAt, processingError: null, billingOperationId: operationId },
  });
  if (updated.count !== 1) throw new Error("Woo refund receipt claim was lost before completion");
}