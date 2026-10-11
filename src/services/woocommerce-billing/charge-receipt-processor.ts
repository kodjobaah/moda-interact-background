import { Prisma, type PrismaClient } from "@prisma/client";
import { recoveryCapacityResumeService } from "../recovery-capacity-resume.service.js";
import { completeChargeReceipt, recordChargeReceiptError } from "./charge-receipt-bookkeeping.js";
import { parseChargePaymentEvidence } from "./charge-payment-evidence.js";
import { correlateAndLockChargePurchase } from "./charge-receipt-correlation.js";
import { readWooChargeEnvelope, type WooChargeTopic } from "./charge-receipt-envelope.js";
import { transitionChargePurchase } from "./charge-purchase-transition.js";
import {
  reportChargeResumeScheduleFailure,
  reportProcessedChargeReceipt,
  reportRetryableChargeReceipt,
} from "./charge-receipt-reporting.js";
const CHARGE_TOPICS = [
  "saas_billing_contract.activated",
  "saas_billing_contract.canceled",
  "saas_billing_contract.prepaid_term_ended",
] as const;

export type ChargeReceiptCursor = { receivedAt: Date; id: string };
export type ChargeReceiptDatabase = Pick<PrismaClient, "$transaction">;
type ClaimedReceipt = {
  id: string;
  topic: string;
  providerContractId: string | null;
  normalizedPayload: Prisma.JsonValue;
  billingOperationId: string | null;
  receivedAt: Date;
};

export type ChargeReceiptAttempt = {
  outcome: "empty" | "processed" | "retryable";
  cursor?: ChargeReceiptCursor;
  transition?: "activated" | "replayed" | "canceled" | "cancellation_replayed";
};

export async function processNextWooChargeReceipt(
  database: ChargeReceiptDatabase,
  now: Date,
  cursor: ChargeReceiptCursor | null,
  resumeScheduler: Pick<typeof recoveryCapacityResumeService, "schedule"> = recoveryCapacityResumeService,
): Promise<ChargeReceiptAttempt> {
  const result = await withTransactionRetry(() => database.$transaction(async (transaction) => {
    const cursorFilter = cursor
      ? Prisma.sql`AND ("receivedAt", "id") > (${cursor.receivedAt}, ${cursor.id})`
      : Prisma.empty;
    const [receipt] = await transaction.$queryRaw<ClaimedReceipt[]>(Prisma.sql`
      SELECT "id", "topic", "providerContractId", "normalizedPayload", "billingOperationId", "receivedAt"
      FROM "woocommerce"."WooCommerceBillingWebhookReceipt"
      WHERE "processedAt" IS NULL
        AND "normalizedPayload" ? 'charge'
        AND "topic" IN (${Prisma.join(CHARGE_TOPICS)})
        ${cursorFilter}
      ORDER BY "receivedAt" ASC, "id" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    if (!receipt) return { kind: "empty" as const };
    const receiptCursor = { receivedAt: receipt.receivedAt, id: receipt.id };
    const wrapper = readWooChargeEnvelope(receipt.normalizedPayload, receipt.providerContractId, receipt.topic);
    if (!wrapper.charge || !receipt.providerContractId || wrapper.errorCode) {
      const code = wrapper.errorCode ?? "CHARGE_PROVIDER_STATUS_CONFLICT";
      await recordChargeReceiptError(transaction, receipt.id, code);
      return { kind: "retryable" as const, cursor: receiptCursor, processingError: code, receipt };
    }

    const correlation = await correlateAndLockChargePurchase(transaction, receipt.providerContractId, receipt.billingOperationId);
    if (!correlation.link) {
      await recordChargeReceiptError(transaction, receipt.id, correlation.errorCode);
      return { kind: "retryable" as const, cursor: receiptCursor, processingError: correlation.errorCode, receipt };
    }
    const link = correlation.link;
    const payment = receipt.topic === "saas_billing_contract.activated"
      ? parseChargePaymentEvidence(wrapper.charge)
      : undefined;
    if (payment && !payment.evidence) {
      await recordChargeReceiptError(transaction, receipt.id, payment.errorCode, link.operation.id);
      return {
        kind: "retryable" as const,
        cursor: receiptCursor,
        processingError: payment.errorCode,
        receipt,
        operationId: link.operation.id,
        shopId: link.shop.id,
        purchaseId: link.purchase.id,
      };
    }

    const transition = await transitionChargePurchase(transaction, link, {
      topic: receipt.topic as WooChargeTopic,
      providerContractId: receipt.providerContractId,
      receivedAt: receipt.receivedAt,
      ...(payment?.evidence ? { paymentEvidence: payment.evidence } : {}),
    });
    if (transition.errorCode) {
      await recordChargeReceiptError(transaction, receipt.id, transition.errorCode, link.operation.id);
      return {
        kind: "retryable" as const,
        cursor: receiptCursor,
        processingError: transition.errorCode,
        receipt,
        operationId: link.operation.id,
        shopId: link.shop.id,
        purchaseId: link.purchase.id,
      };
    }
    await completeChargeReceipt(transaction, receipt.id, now, link.operation.id);
    return {
      kind: "processed" as const,
      cursor: receiptCursor,
      transition: transition.outcome,
      newlyActivated: transition.newlyActivated,
      shopId: link.shop.id,
      operationId: link.operation.id,
      purchaseId: link.purchase.id,
      receipt,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));

  if (result.kind === "empty") return { outcome: "empty" };
  if (result.kind === "retryable") {
    reportRetryableChargeReceipt({
      receiptId: result.receipt.id,
      topic: result.receipt.topic,
      providerContractId: result.receipt.providerContractId,
      processingError: result.processingError,
      ...(result.operationId ? { operationId: result.operationId } : {}),
      ...(result.shopId ? { shopId: result.shopId } : {}),
      ...(result.purchaseId ? { purchaseId: result.purchaseId } : {}),
    });
    return { outcome: "retryable", cursor: result.cursor };
  }
  if (result.newlyActivated) {
    try {
      await resumeScheduler.schedule({
        shopId: result.shopId,
        trigger: `woo-purchase-activation-${result.purchaseId}`,
      });
    } catch {
      reportChargeResumeScheduleFailure({
        receiptId: result.receipt.id,
        topic: result.receipt.topic,
        providerContractId: result.receipt.providerContractId,
        shopId: result.shopId,
        operationId: result.operationId,
        purchaseId: result.purchaseId,
        outcome: "activated",
      });
    }
  }
  reportProcessedChargeReceipt({
    receiptId: result.receipt.id,
    topic: result.receipt.topic,
    providerContractId: result.receipt.providerContractId,
    shopId: result.shopId,
    operationId: result.operationId,
    purchaseId: result.purchaseId,
    outcome: result.transition,
  });
  return { outcome: "processed", cursor: result.cursor, transition: result.transition };
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
  throw new Error("Woo charge receipt transaction retry limit exceeded");
}