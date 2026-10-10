import type { Prisma } from "@prisma/client";

import { contractPlanOperations, resolvePlanIntent, uniqueCancelOperation, WOO_RECURRING_OPERATION_KINDS, type WooRecurringOperation } from "./subscription-operation-resolution.js";
import type { WooSubscriptionEvidence } from "./subscription-receipt-evidence.js";

export async function resolveContractShop(
  transaction: Prisma.TransactionClient,
  contractId: string,
): Promise<string | null> {
  const [operations, subscriptions] = await Promise.all([
    transaction.billingOperation.findMany({
      where: { providerReference: contractId, kind: { in: WOO_RECURRING_OPERATION_KINDS } },
      select: { shopId: true },
    }),
    transaction.subscription.findMany({
      where: { providerSubscriptionId: contractId },
      select: { shopId: true },
    }),
  ]);
  const shops = new Set([...operations, ...subscriptions].map(({ shopId }) => shopId));
  return shops.size === 1 ? [...shops][0]! : null;
}

export function operationForReceipt(
  receipt: WooSubscriptionEvidence | undefined,
  operations: readonly WooRecurringOperation[],
): string | null {
  if (!receipt) return null;
  if (receipt.topic === "saas_billing_contract.activated") {
    const creates = operations.filter((operation) => operation.kind === "SUBSCRIPTION_CREATE"
      && operation.providerReference === receipt.contractId
      && operation.state !== "FAILED"
      && operation.merchantPricingPlan?.displayName === receipt.planName
      && operation.quotedAmountMinor === receipt.planPriceMinor);
    return creates.length === 1 ? creates[0]!.id : null;
  }
  if (receipt.topic === "saas_billing_contract.updated") {
    const resolution = resolvePlanIntent(
      contractPlanOperations(operations, receipt.contractId),
      receipt.planObservedAt,
      receipt.planPriceMinor,
      receipt.planName,
    );
    return resolution.kind === "resolved" && resolution.operation.kind === "PLAN_SWITCH" ? resolution.operation.id : null;
  }
  if (receipt.topic === "saas_billing_contract.canceled") {
    const cancel = uniqueCancelOperation(operations, receipt.contractId);
    return cancel?.id ?? null;
  }
  return null;
}