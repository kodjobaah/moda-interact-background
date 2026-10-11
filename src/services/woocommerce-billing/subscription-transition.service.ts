import {
  BillingPlanKind,
  SubscriptionProjectionStatus,
} from "@prisma/client";
import type { Prisma } from "@prisma/client";

import { reduceFinancialEvidence } from "./subscription-evidence-reducer.js";
import { contractPlanOperations, resolvePlanIntent, uniqueCancelOperation, type WooRecurringOperation } from "./subscription-operation-resolution.js";
import {
  parseWooSubscriptionEvidence,
  PermanentSubscriptionEvidenceError,
  type WooSubscriptionEvidence,
} from "./subscription-receipt-evidence.js";
import { reduceTerminationEvidence } from "./subscription-termination-reducer.js";
import { activationEvidence, canActivateCurrentFree, latestCreateMatches } from "./subscription-activation-evidence.js";
import { applyCurrentPlanIntent, confirmWooOperation, findPaidPlan } from "./subscription-plan-intent-projection.js";
import { operationForReceipt } from "./subscription-receipt-operation-correlation.js";
import { nextWooEntitlementReconciliationAt } from "./paid-entitlement-window.js";
import {
  endWooPaidSubscription,
  type CurrentWooSubscription,
} from "./subscription-period-projection.js";
import { activateWooPaidSubscription } from "./subscription-period-activation.js";

export type { WooRecurringOperation } from "./subscription-operation-resolution.js";

type Transaction = Prisma.TransactionClient;

export type SubscriptionTransitionResult = {
  kind: "projected" | "unchanged" | "historical";
  billingOperationId: string | null;
};

export async function transitionWooSubscription(
  transaction: Transaction,
  input: {
    shopId: string;
    contractId: string;
    current: CurrentWooSubscription;
    claimedReceipt: { topic: string; normalizedPayload: unknown };
    receipts: readonly { topic: string; normalizedPayload: unknown }[];
    operations: readonly WooRecurringOperation[];
    now: Date;
  },
): Promise<SubscriptionTransitionResult> {
  const evidence = input.receipts.map((receipt) =>
    parseWooSubscriptionEvidence(receipt.topic, input.contractId, receipt.normalizedPayload));
  const claimedEvidence = parseWooSubscriptionEvidence(
    input.claimedReceipt.topic,
    input.contractId,
    input.claimedReceipt.normalizedPayload,
  );
  const termination = reduceTerminationEvidence(terminationObservations(evidence), input.now);
  if (termination.kind === "conflict") throw new PermanentSubscriptionEvidenceError(termination.reason);

  const activation = activationEvidence(evidence);
  let current = input.current;
  if (current.providerSubscriptionId !== input.contractId) {
    if (!canActivateCurrentFree(current) || !activation || termination.kind === "ended"
      || !latestCreateMatches(input.operations, input.contractId)) {
      return { kind: "historical", billingOperationId: operationForReceipt(claimedEvidence, input.operations) };
    }
    const resolution = resolvePlanIntent(
      contractPlanOperations(input.operations, input.contractId),
      activation.planObservedAt ?? activation.financial.providerAt,
      activation.planPriceMinor,
      activation.planName,
    );
    if (resolution.kind !== "resolved" || resolution.operation.kind !== "SUBSCRIPTION_CREATE") {
      throw new PermanentSubscriptionEvidenceError(resolution.kind === "conflict" ? resolution.reason : "CREATE_INTENT_UNRESOLVED");
    }
    const target = await findPaidPlan(transaction, resolution.operation, input.shopId);
    const paidCoverage = reduceFinancialEvidence(evidence.flatMap(({ financial }) =>
      financial?.health === "ACTIVE" ? [financial] : []));
    if (paidCoverage.kind !== "resolved" || !paidCoverage.evidence.coverageEndAt) {
      throw new PermanentSubscriptionEvidenceError("ACTIVATION_FINANCIAL_EVIDENCE_CONFLICT");
    }
    await activateWooPaidSubscription(transaction, current, target, input.contractId, activation.activationAt, paidCoverage.evidence.coverageEndAt, input.now);
    await confirmWooOperation(transaction, resolution.operation.id);
    const activated = await transaction.subscription.findUnique({
      where: { id: current.id },
      include: { plan: true, billingPeriod: { include: { entitlementCounters: true } } },
    });
    if (!activated) throw new Error("Woo activated subscription could not be reloaded");
    current = activated;
  }

  if (current.providerSubscriptionId !== input.contractId || current.plan?.kind !== BillingPlanKind.PAID_METERED) {
    throw new PermanentSubscriptionEvidenceError("CURRENT_PROVIDER_CONTRACT_INCONSISTENT");
  }
  if (termination.kind === "ended") {
    await endWooPaidSubscription(transaction, current, input.contractId, termination.endAt, input.now);
    return { kind: "projected", billingOperationId: operationForReceipt(claimedEvidence, input.operations) };
  }

  const currentInput = { ...input, current };
  const planResult = await applyCurrentPlanIntent(transaction, currentInput, evidence);
  assertRenewalPaymentIsCausal(claimedEvidence, evidence);
  const financial = reduceFinancialEvidence(evidence.flatMap(({ financial }) => financial ? [financial] : []));
  if (financial.kind === "conflict") throw new PermanentSubscriptionEvidenceError(financial.reason);
  if (financial.kind === "resolved") {
    await transaction.subscription.update({
      where: { id: current.id },
      data: {
        status: financial.evidence.health === "PAUSED"
          ? SubscriptionProjectionStatus.FROZEN
          : SubscriptionProjectionStatus.ACTIVE,
        nextReconcileAt: financial.evidence.health === "PAUSED" || !current.currentPeriodEnd
          ? null
          : nextWooEntitlementReconciliationAt(current.currentPeriodEnd, financial.evidence.coverageEndAt ?? current.providerCoverageEndAt ?? input.now),
        ...(financial.evidence.health === "ACTIVE" && financial.evidence.coverageEndAt
          ? { providerCoverageEndAt: financial.evidence.coverageEndAt }
          : {}),
        lastSyncedAt: input.now,
        lastSyncErrorCode: null,
        lastSyncErrorAt: null,
      },
    });
  }

  const billingOperationId = operationForReceipt(claimedEvidence, input.operations);
  if (termination.kind === "scheduled") {
    await transaction.subscription.update({
      where: { id: current.id },
      data: {
        status: SubscriptionProjectionStatus.ACTIVE,
        cancelAtPeriodEnd: true,
        providerCoverageEndAt: termination.endAt,
        nextReconcileAt: current.currentPeriodEnd
          ? nextWooEntitlementReconciliationAt(current.currentPeriodEnd, termination.endAt)
          : termination.endAt,
        lastSyncedAt: input.now,
        lastSyncErrorCode: null,
        lastSyncErrorAt: null,
      },
    });
    const cancelOperation = uniqueCancelOperation(input.operations, input.contractId);
    if (cancelOperation) {
      await confirmWooOperation(transaction, cancelOperation.id);
    }
  }
  return {
    kind: planResult || termination.kind === "scheduled" ? "projected" : billingOperationId ? "projected" : "unchanged",
    billingOperationId,
  };
}

export function assertRenewalPaymentIsCausal(
  claimed: WooSubscriptionEvidence,
  evidence: readonly WooSubscriptionEvidence[],
): void {
  if (claimed.topic !== "saas_billing_contract.renewed") return;
  const payment = claimed.financial;
  if (!payment?.paymentId) throw new PermanentSubscriptionEvidenceError("RENEWAL_PAYMENT_EVIDENCE_MISSING");
  const priorPayments = evidence.filter(({ topic, financial }) =>
    (topic === "saas_billing_contract.activated" || topic === "saas_billing_contract.renewed")
    && financial !== null
    && financial.providerAt.getTime() <= payment.providerAt.getTime());
  if (priorPayments.some(({ topic, financial }) => financial?.providerAt.getTime() === payment.providerAt.getTime()
    && (topic !== "saas_billing_contract.renewed" || financial.paymentId !== payment.paymentId))) {
    throw new PermanentSubscriptionEvidenceError("RENEWAL_PAYMENT_NOT_CURRENT");
  }
}

function terminationObservations(evidence: readonly WooSubscriptionEvidence[]) {
  return evidence.flatMap((item) => item.termEndAt
    ? [{
        state: item.topic === "saas_billing_contract.prepaid_term_ended" ? "PREPAID_TERM_ENDED" as const : "CANCEL_SCHEDULED" as const,
        endAt: item.termEndAt,
        providerAt: item.providerModifiedAt,
      }]
    : []);
}
