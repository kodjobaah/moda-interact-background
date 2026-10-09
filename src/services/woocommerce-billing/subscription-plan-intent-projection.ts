import { BillingPlanKind } from "@prisma/client";
import type { Prisma } from "@prisma/client";

import { contractPlanOperations, resolvePlanIntent, type RecurringIntent, type WooRecurringOperation } from "./subscription-operation-resolution.js";
import { PermanentSubscriptionEvidenceError, type WooSubscriptionEvidence } from "./subscription-receipt-evidence.js";
import { switchWooSubscriptionPlan, type CurrentWooSubscription, type WooPaidPlan } from "./subscription-period-projection.js";

type Transaction = Prisma.TransactionClient;

export async function applyCurrentPlanIntent(
  transaction: Transaction,
  input: { shopId: string; contractId: string; current: CurrentWooSubscription; now: Date; operations: readonly WooRecurringOperation[] },
  evidence: readonly WooSubscriptionEvidence[],
): Promise<string | null> {
  const resolutions = evidence
    .filter(({ topic }) => topic === "saas_billing_contract.updated" && input.current.providerSubscriptionId === input.contractId)
    .map(({ planObservedAt, planPriceMinor }) =>
      resolvePlanIntent(contractPlanOperations(input.operations, input.contractId), planObservedAt, planPriceMinor));
  const conflicts = resolutions.filter((value) => value.kind === "conflict");
  if (conflicts.length) throw new PermanentSubscriptionEvidenceError("PLAN_INTENT_EVIDENCE_CONFLICT");
  const resolved = resolutions.filter((value): value is Extract<typeof value, { kind: "resolved" }> => value.kind === "resolved");
  const operationIds = [...new Set(resolved.map(({ operation }) => operation.id))];
  if (operationIds.length > 1) throw new PermanentSubscriptionEvidenceError("AMBIGUOUS_PLAN_INTENT");
  const resolution = resolved[0];
  if (!resolution || resolution.operation.kind !== "PLAN_SWITCH") return null;
  const target = await findPaidPlan(transaction, resolution.operation, input.shopId);
  await switchWooSubscriptionPlan(transaction, input.current, target, input.now);
  await confirmWooOperation(transaction, resolution.operation.id);
  return resolution.operation.id;
}

export async function findPaidPlan(
  transaction: Transaction,
  operation: RecurringIntent,
  shopId: string,
): Promise<WooPaidPlan> {
  const row = await transaction.billingOperation.findUnique({
    where: { id: operation.id },
    select: { shopId: true, merchantPricingPlan: { select: { shopifyPlanHandle: true } } },
  });
  if (row?.shopId !== shopId || !row.merchantPricingPlan) throw new PermanentSubscriptionEvidenceError("OPERATION_PLAN_MISSING");
  const plan = await transaction.billingPlan.findUnique({
    where: { shopifyPlanHandle: row.merchantPricingPlan.shopifyPlanHandle },
    select: { id: true, name: true, kind: true, shopifyPlanHandle: true, includedRecoveryConversationAllowance: true },
  });
  if (!plan || plan.kind !== BillingPlanKind.PAID_METERED) throw new PermanentSubscriptionEvidenceError("MATERIALIZED_PAID_PLAN_MISSING");
  return plan;
}

export async function confirmWooOperation(transaction: Transaction, operationId: string): Promise<void> {
  await transaction.billingOperation.updateMany({
    where: { id: operationId, state: { in: ["INITIATING", "AWAITING_CONFIRMATION", "OUTCOME_UNKNOWN"] } },
    data: { state: "CONFIRMED", lastErrorCode: null },
  });
}