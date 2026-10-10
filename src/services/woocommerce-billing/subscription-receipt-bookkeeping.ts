import {
  BillingOperationKind,
  SubscriptionProjectionStatus,
} from "@prisma/client";
import type { Prisma, PrismaClient } from "@prisma/client";

import { lockShop, lockSubscription } from "../billing-subscription-reconciliation/locking.js";
import { resolveContractShop } from "./subscription-receipt-operation-correlation.js";

export type WooReceiptProcessingOutcome = "empty" | "processed" | "historical" | "attention";

export async function completeWooReceipt(
  transaction: Prisma.TransactionClient,
  receiptId: string,
  processedAt: Date,
  billingOperationId: string | null,
): Promise<void> {
  const updated = await transaction.wooCommerceBillingWebhookReceipt.updateMany({
    where: { id: receiptId, processedAt: null },
    data: {
      processedAt,
      processingError: null,
      ...(billingOperationId ? { billingOperationId } : {}),
    },
  });
  if (updated.count !== 1) throw new Error("Woo subscription receipt claim was lost before completion");
}

export async function quarantineWooReceipt(
  transaction: Prisma.TransactionClient,
  receiptId: string,
  code: string,
): Promise<void> {
  // A quarantined receipt remains unprocessed but is excluded by the claim's
  // processingError IS NULL predicate. The DB forbids an error with processedAt.
  const updated = await transaction.wooCommerceBillingWebhookReceipt.updateMany({
    where: { id: receiptId, processedAt: null, processingError: null },
    data: { processingError: code.slice(0, 128) },
  });
  if (updated.count !== 1) throw new Error("Woo subscription receipt quarantine was lost before completion");
}

export async function recordPermanentWooReceiptConflict(
  database: PrismaClient,
  receiptId: string,
  knownContractId: string | null,
  code: string,
  now: Date,
): Promise<WooReceiptProcessingOutcome> {
  return database.$transaction(async (transaction) => {
    const receipt = await transaction.wooCommerceBillingWebhookReceipt.findUnique({ where: { id: receiptId } });
    if (!receipt || receipt.processedAt || receipt.processingError) return "empty";
    const contractId = receipt.providerContractId ?? knownContractId;
    const shopId = contractId ? await resolveContractShop(transaction, contractId) : null;
    if (!shopId) {
      await quarantineWooReceipt(transaction, receiptId, code);
      return "attention";
    }

    await lockShop(transaction, shopId);
    const subscription = await transaction.subscription.findUnique({ where: { shopId }, select: { id: true } });
    if (subscription) {
      await lockSubscription(transaction, subscription.id);
      const current = await transaction.subscription.findUnique({
        where: { id: subscription.id },
        select: { providerSubscriptionId: true },
      });
      if (current?.providerSubscriptionId === contractId) {
        await transaction.subscription.update({
          where: { id: subscription.id },
          data: {
            status: SubscriptionProjectionStatus.FROZEN,
            lastSyncErrorCode: code.slice(0, 128),
            lastSyncErrorAt: now,
          },
        });
      }
    }
    await transaction.billingOperation.updateMany({
      where: {
        shopId,
        providerReference: contractId,
        kind: {
          in: [BillingOperationKind.SUBSCRIPTION_CREATE, BillingOperationKind.PLAN_SWITCH, BillingOperationKind.CANCEL],
        },
      },
      data: { lastErrorCode: code.slice(0, 128) },
    });
    // The permanent reason is recorded on the Subscription and matching
    // BillingOperations above. Processed receipts must have no processingError.
    await transaction.wooCommerceBillingWebhookReceipt.update({
      where: { id: receiptId },
      data: { processedAt: now, processingError: null },
    });
    return subscription ? "attention" : "historical";
  });
}