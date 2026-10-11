import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import { lockShop, lockSubscription } from "../billing-subscription-reconciliation/locking.js";

type ChargeDatabase = Pick<PrismaClient, "$transaction">;
type Transaction = Prisma.TransactionClient;

export type ChargeReceiptLink = {
  shop: NonNullable<Awaited<ReturnType<Transaction["shop"]["findUnique"]>>>;
  subscription: NonNullable<Awaited<ReturnType<Transaction["subscription"]["findUnique"]>>>;
  operation: NonNullable<Awaited<ReturnType<Transaction["billingOperation"]["findUnique"]>>>;
  purchase: NonNullable<Awaited<ReturnType<Transaction["recoveryCreditPurchase"]["findUnique"]>>>;
  counter: Awaited<ReturnType<Transaction["shopEntitlementCounter"]["findUnique"]>>;
};

export type ChargeCorrelationResult =
  | { link: ChargeReceiptLink; errorCode?: never }
  | { link?: never; errorCode: "CHARGE_CORRELATION_NOT_READY" | "CHARGE_OPERATION_AMBIGUOUS" | "CHARGE_OPERATION_STATE_CONFLICT" | "CHARGE_PURCHASE_LINK_CONFLICT" | "CHARGE_PURCHASE_STATE_CONFLICT" | "CHARGE_TENANT_CONFLICT" };

export async function correlateAndLockChargePurchase(
  transaction: Transaction,
  providerContractId: string,
  receiptOperationId: string | null,
): Promise<ChargeCorrelationResult> {
  const operations = await transaction.billingOperation.findMany({
    where: { kind: "ONE_TIME_CHARGE", providerReference: providerContractId },
    take: 2,
  });
  if (operations.length === 0) return { errorCode: "CHARGE_CORRELATION_NOT_READY" };
  if (operations.length > 1) return { errorCode: "CHARGE_OPERATION_AMBIGUOUS" };

  const candidate = operations[0];
  if (!candidate || receiptOperationId && receiptOperationId !== candidate.id) {
    return { errorCode: "CHARGE_OPERATION_STATE_CONFLICT" };
  }
  const subscriptionRef = await transaction.subscription.findUnique({
    where: { shopId: candidate.shopId },
    select: { id: true },
  });
  if (!subscriptionRef) return { errorCode: "CHARGE_TENANT_CONFLICT" };

  await lockShop(transaction, candidate.shopId);
  const shop = await transaction.shop.findUnique({ where: { id: candidate.shopId } });
  if (!shop || shop.platform !== "WOOCOMMERCE") return { errorCode: "CHARGE_TENANT_CONFLICT" };

  await lockSubscription(transaction, subscriptionRef.id);
  const subscription = await transaction.subscription.findUnique({ where: { id: subscriptionRef.id } });
  if (!subscription || subscription.shopId !== shop.id) return { errorCode: "CHARGE_TENANT_CONFLICT" };

  await transaction.$queryRaw(Prisma.sql`
    SELECT "id" FROM "billing"."BillingOperation" WHERE "id" = ${candidate.id} FOR UPDATE
  `);
  const operation = await transaction.billingOperation.findUnique({ where: { id: candidate.id } });
  if (!operation || operation.kind !== "ONE_TIME_CHARGE" || operation.providerReference !== providerContractId
    || operation.shopId !== shop.id || receiptOperationId && receiptOperationId !== operation.id
    || !operation.recoveryCreditPurchaseId || !operation.merchantPricingUsageEventId
    || !Number.isSafeInteger(operation.quotedAmountMinor) || (operation.quotedAmountMinor ?? 0) <= 0
    || operation.quotedCurrency !== "USD") {
    return { errorCode: "CHARGE_OPERATION_STATE_CONFLICT" };
  }

  await transaction.$queryRaw(Prisma.sql`
    SELECT "id" FROM "billing"."RecoveryCreditPurchase"
    WHERE "id" = ${operation.recoveryCreditPurchaseId} FOR UPDATE
  `);
  const purchase = await transaction.recoveryCreditPurchase.findUnique({
    where: { id: operation.recoveryCreditPurchaseId },
  });
  if (!purchase || purchase.shopId !== subscription.shopId) {
    return { errorCode: purchase ? "CHARGE_TENANT_CONFLICT" : "CHARGE_PURCHASE_LINK_CONFLICT" };
  }
  if (purchase.provider !== "WOOCOMMERCE") return { errorCode: "CHARGE_TENANT_CONFLICT" };
  if (!Number.isSafeInteger(purchase.creditsGranted) || purchase.creditsGranted <= 0) {
    return { errorCode: "CHARGE_PURCHASE_STATE_CONFLICT" };
  }

  await transaction.$queryRaw(Prisma.sql`
    SELECT "id" FROM "billing"."ShopEntitlementCounter"
    WHERE "shopId" = ${shop.id} AND "counter"::text = 'PURCHASED_RECOVERY_CREDITS'
    FOR UPDATE
  `);
  const counter = await transaction.shopEntitlementCounter.findUnique({
    where: { shopId_counter: { shopId: shop.id, counter: "PURCHASED_RECOVERY_CREDITS" } },
  });
  return { link: { shop, subscription, operation, purchase, counter } };
}