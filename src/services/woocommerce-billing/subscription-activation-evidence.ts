import {
  BillingPlanKind,
  SubscriptionProjectionStatus,
} from "@prisma/client";

import type { WooRecurringOperation } from "./subscription-operation-resolution.js";
import type { CurrentWooSubscription } from "./subscription-period-projection.js";
import { PermanentSubscriptionEvidenceError, type WooSubscriptionEvidence } from "./subscription-receipt-evidence.js";

export function activationEvidence(
  evidence: readonly WooSubscriptionEvidence[],
): (WooSubscriptionEvidence & { activationAt: Date; financial: NonNullable<WooSubscriptionEvidence["financial"]> }) | null {
  const activations = evidence.filter((item) => item.topic === "saas_billing_contract.activated" && item.activationAt && item.financial);
  if (activations.length === 0) return null;
  const first = activations[0]!;
  if (activations.some(({ activationAt, planPriceMinor }) =>
    activationAt!.getTime() !== first.activationAt!.getTime() || planPriceMinor !== first.planPriceMinor)) {
    throw new PermanentSubscriptionEvidenceError("CONTRADICTORY_ACTIVATION_TIME");
  }
  const latestAt = Math.max(...activations.map(({ financial }) => financial!.providerAt.getTime()));
  return activations.find(({ financial }) => financial!.providerAt.getTime() === latestAt) as
    WooSubscriptionEvidence & { activationAt: Date; financial: NonNullable<WooSubscriptionEvidence["financial"]> };
}

export function canActivateCurrentFree(current: CurrentWooSubscription): boolean {
  return current.status === SubscriptionProjectionStatus.ACTIVE
    && current.plan?.kind === BillingPlanKind.FREE
    && current.providerSubscriptionId === null
    && current.billingPeriodId === null
    && current.currentPeriodStart === null
    && current.currentPeriodEnd === null;
}

export function latestCreateMatches(
  operations: readonly WooRecurringOperation[],
  contractId: string,
): boolean {
  const creates = operations.filter((operation) => operation.kind === "SUBSCRIPTION_CREATE" && operation.state !== "FAILED");
  if (!creates.length) return false;
  const newestAt = Math.max(...creates.map(({ createdAt }) => createdAt.getTime()));
  const latest = creates.filter(({ createdAt }) => createdAt.getTime() === newestAt);
  return latest.length === 1 && latest[0]?.providerReference === contractId && latest[0].state !== "CONFIRMED";
}