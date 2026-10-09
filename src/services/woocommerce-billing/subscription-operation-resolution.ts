import { BillingOperationKind } from "@prisma/client";

export const WOO_RECURRING_OPERATION_KINDS = [
  BillingOperationKind.SUBSCRIPTION_CREATE,
  BillingOperationKind.PLAN_SWITCH,
  BillingOperationKind.CANCEL,
];

export type RecurringIntent = {
  id: string;
  kind: "SUBSCRIPTION_CREATE" | "PLAN_SWITCH" | "CANCEL";
  state: "INITIATING" | "AWAITING_CONFIRMATION" | "CONFIRMED" | "OUTCOME_UNKNOWN" | "FAILED";
  createdAt: Date;
  merchantPricingPlanId: string | null;
  quotedAmountMinor: number | null;
};

export type WooRecurringOperation = RecurringIntent & {
  providerReference: string | null;
  merchantPricingPlan: { shopifyPlanHandle: string } | null;
};

export type PlanIntentResolution =
  | { kind: "none" }
  | { kind: "stale" }
  | { kind: "resolved"; operation: RecurringIntent }
  | { kind: "conflict"; reason: "AMBIGUOUS_PLAN_INTENT" | "PROVIDER_PLAN_MISMATCH" | "PROVIDER_SNAPSHOT_TIME_MISSING" };

export function resolvePlanIntent(
  operations: readonly RecurringIntent[],
  providerAt: Date | null,
  providerPriceMinor: number | null,
): PlanIntentResolution {
  const candidates = operations.filter((operation) =>
    (operation.kind === "SUBSCRIPTION_CREATE" || operation.kind === "PLAN_SWITCH")
    && operation.state !== "FAILED"
    && operation.state !== "INITIATING");
  if (candidates.length === 0) return { kind: "none" };

  const latestCreatedAt = Math.max(...candidates.map(({ createdAt }) => createdAt.getTime()));
  const latest = candidates.filter(({ createdAt }) => createdAt.getTime() === latestCreatedAt);
  if (!Number.isFinite(latestCreatedAt) || latest.length !== 1) {
    return { kind: "conflict", reason: "AMBIGUOUS_PLAN_INTENT" };
  }

  const operation = latest[0];
  if (!providerAt) return { kind: "conflict", reason: "PROVIDER_SNAPSHOT_TIME_MISSING" };
  if (!operation || providerAt.getTime() < latestCreatedAt) return { kind: "stale" };
  if (!operation.merchantPricingPlanId
    || operation.quotedAmountMinor === null
    || providerPriceMinor === null
    || operation.quotedAmountMinor !== providerPriceMinor) {
    return { kind: "conflict", reason: "PROVIDER_PLAN_MISMATCH" };
  }
  return { kind: "resolved", operation };
}

export function contractPlanOperations(
  operations: readonly WooRecurringOperation[],
  contractId: string,
): WooRecurringOperation[] {
  return operations.filter((operation) => operation.providerReference === contractId);
}

export function uniqueCancelOperation(
  operations: readonly WooRecurringOperation[],
  contractId: string,
): WooRecurringOperation | null {
  const cancellations = operations.filter((operation) => operation.kind === "CANCEL"
    && operation.providerReference === contractId && operation.state !== "FAILED");
  return cancellations.length === 1 ? cancellations[0] ?? null : null;
}