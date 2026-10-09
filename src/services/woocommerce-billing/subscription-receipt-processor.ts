import {
  ShopPlatform,
} from "@prisma/client";
import { Prisma, type PrismaClient } from "@prisma/client";

import { lockShop, lockSubscription } from "../billing-subscription-reconciliation/locking.js";
import { completeWooReceipt, quarantineWooReceipt, recordPermanentWooReceiptConflict, type WooReceiptProcessingOutcome } from "./subscription-receipt-bookkeeping.js";
import { resolveContractShop } from "./subscription-receipt-operation-correlation.js";
import {
  PermanentSubscriptionEvidenceError,
} from "./subscription-receipt-evidence.js";
import { WOO_RECURRING_OPERATION_KINDS } from "./subscription-operation-resolution.js";
import {
  transitionWooSubscription,
  type WooRecurringOperation,
} from "./subscription-transition.service.js";

type ReceiptRow = {
  id: string;
  topic: string;
  providerContractId: string | null;
  normalizedPayload: Prisma.JsonValue;
  billingOperationId: string | null;
};
type ClaimRow = Pick<ReceiptRow, "id" | "topic" | "providerContractId" | "normalizedPayload" | "billingOperationId">;
export async function processNextWooSubscriptionReceipt(
  database: PrismaClient,
  now: Date,
): Promise<WooReceiptProcessingOutcome> {
  let claimedId: string | null = null;
  let contractId: string | null = null;
  try {
    return await database.$transaction(async (transaction) => {
      const [receipt] = await transaction.$queryRaw<ClaimRow[]>(Prisma.sql`
        SELECT "id", "topic", "providerContractId", "normalizedPayload", "billingOperationId"
        FROM "woocommerce"."WooCommerceBillingWebhookReceipt"
        WHERE "processedAt" IS NULL AND "processingError" IS NULL
          AND "topic" IN (
            'saas_billing_contract.activated',
            'saas_billing_contract.updated',
            'saas_billing_contract.renewed',
            'saas_billing_contract.paused',
            'saas_billing_contract.canceled',
            'saas_billing_contract.prepaid_term_ended',
            'saas_billing_contract.refunded'
          )
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);
      if (!receipt) return "empty";
      claimedId = receipt.id;
      contractId = receipt.providerContractId;
      if (!receipt.providerContractId) {
        await quarantineWooReceipt(transaction, receipt.id, "PROVIDER_CONTRACT_ID_MISSING", now);
        return "attention";
      }

      const shopId = await resolveContractShop(transaction, receipt.providerContractId);
      if (!shopId) {
        await quarantineWooReceipt(transaction, receipt.id, "CONTRACT_NOT_CORRELATED", now);
        return "attention";
      }
      await lockShop(transaction, shopId);
      const shop = await transaction.shop.findUnique({ where: { id: shopId }, select: { platform: true } });
      if (shop?.platform !== ShopPlatform.WOOCOMMERCE) {
        await quarantineWooReceipt(transaction, receipt.id, "CONTRACT_SHOP_PLATFORM_MISMATCH", now);
        return "attention";
      }

      const beforeLock = await transaction.subscription.findUnique({ where: { shopId }, select: { id: true } });
      if (!beforeLock) throw new PermanentSubscriptionEvidenceError("SUBSCRIPTION_MISSING");
      await lockSubscription(transaction, beforeLock.id);
      const current = await transaction.subscription.findUnique({
        where: { shopId },
        include: { plan: true, billingPeriod: { include: { entitlementCounters: true } } },
      });
      if (!current) throw new PermanentSubscriptionEvidenceError("SUBSCRIPTION_MISSING");

      const operations = await transaction.billingOperation.findMany({
        where: { shopId, kind: { in: WOO_RECURRING_OPERATION_KINDS } },
        include: { merchantPricingPlan: { select: { displayName: true, shopifyPlanHandle: true } } },
      }) as WooRecurringOperation[];
      const allReceipts = await transaction.wooCommerceBillingWebhookReceipt.findMany({
        where: { providerContractId: receipt.providerContractId, topic: { in: WOO_SUBSCRIPTION_TOPICS } },
        select: { topic: true, normalizedPayload: true },
      });
      const result = await transitionWooSubscription(transaction, {
        shopId,
        contractId: receipt.providerContractId,
        current,
        claimedReceipt: { topic: receipt.topic, normalizedPayload: receipt.normalizedPayload },
        receipts: allReceipts,
        operations,
        now,
      });
      const operationId = preserveOperationLink(receipt, result.billingOperationId, operations, receipt.providerContractId);
      await completeWooReceipt(transaction, receipt.id, now, operationId);
      return result.kind === "historical" ? "historical" : "processed";
    });
  } catch (error) {
    if (!(error instanceof PermanentSubscriptionEvidenceError) || !claimedId) throw error;
    return recordPermanentWooReceiptConflict(database, claimedId, contractId, error.code, now);
  }
}

const WOO_SUBSCRIPTION_TOPICS = [
  "saas_billing_contract.activated",
  "saas_billing_contract.updated",
  "saas_billing_contract.renewed",
  "saas_billing_contract.paused",
  "saas_billing_contract.canceled",
  "saas_billing_contract.prepaid_term_ended",
  "saas_billing_contract.refunded",
];

function preserveOperationLink(
  receipt: ReceiptRow,
  proposedId: string | null,
  operations: readonly WooRecurringOperation[],
  contractId: string,
): string | null {
  if (receipt.billingOperationId === null) return proposedId;
  const existing = operations.find(({ id }) => id === receipt.billingOperationId);
  const expectedKind = receipt.topic === "saas_billing_contract.activated"
    ? "SUBSCRIPTION_CREATE"
    : receipt.topic === "saas_billing_contract.updated"
      ? "PLAN_SWITCH"
      : receipt.topic === "saas_billing_contract.canceled"
        ? "CANCEL"
        : null;
  if (!existing || existing.providerReference !== contractId || existing.kind !== expectedKind
    || proposedId !== null && proposedId !== receipt.billingOperationId) {
    throw new PermanentSubscriptionEvidenceError("RECEIPT_OPERATION_LINK_CONFLICT");
  }
  if (proposedId !== null && !operations.some(({ id, providerReference, kind }) =>
    id === proposedId && providerReference === contractId && kind === expectedKind)) {
    throw new PermanentSubscriptionEvidenceError("RECEIPT_OPERATION_LINK_CONFLICT");
  }
  return receipt.billingOperationId;
}
