import {
  BillingPeriodEntitlementCounterKind,
  BillingPeriodStatus,
  BillingPlanKind,
  SubscriptionProjectionStatus,
} from "@prisma/client";
import type { Prisma } from "@prisma/client";

import { PermanentSubscriptionEvidenceError } from "./subscription-receipt-evidence.js";
import type { CurrentWooSubscription, WooPaidPlan } from "./subscription-period-projection.js";
import { nextWooEntitlementReconciliationAt } from "./paid-entitlement-window.js";

type Transaction = Prisma.TransactionClient;

const WOO_MODA_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

export async function activateWooPaidSubscription(
  transaction: Transaction,
  current: CurrentWooSubscription,
  plan: WooPaidPlan,
  contractId: string,
  activationAt: Date,
  coverageEndAt: Date,
  now: Date,
): Promise<void> {
  requirePaidPlan(plan);
  if (current.status !== SubscriptionProjectionStatus.ACTIVE
    || current.plan?.kind !== BillingPlanKind.FREE
    || current.providerSubscriptionId !== null
    || current.billingPeriodId !== null
    || current.currentPeriodStart !== null
    || current.currentPeriodEnd !== null) {
    throw new PermanentSubscriptionEvidenceError("FREE_SUBSCRIPTION_NOT_ACTIVATABLE");
  }
  const periodStart = activationAt;
  const periodEnd = new Date(periodStart.getTime() + WOO_MODA_PERIOD_MS);
  const period = await transaction.billingPeriod.create({
    data: {
      shopId: current.shopId,
      subscriptionId: current.id,
      planId: plan.id,
      shopifyPlanHandleSnapshot: plan.shopifyPlanHandle,
      planNameSnapshot: plan.name,
      planKindSnapshot: BillingPlanKind.PAID_METERED,
      includedRecoveryCreditsGranted: plan.includedRecoveryConversationAllowance,
      periodStart,
      periodEnd,
      status: BillingPeriodStatus.OPEN,
    },
  });
  await transaction.billingPeriodEntitlementCounter.create({
    data: {
      shopId: current.shopId,
      billingPeriodId: period.id,
      counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
      grantedQuantity: plan.includedRecoveryConversationAllowance!,
      committedQuantity: 0,
      reservedQuantity: 0,
      forfeitedQuantity: 0,
    },
  });
  await transaction.subscription.update({
    where: { id: current.id },
    data: {
      status: SubscriptionProjectionStatus.ACTIVE,
      planId: plan.id,
      providerSubscriptionId: contractId,
      providerCoverageEndAt: coverageEndAt,
      cancelAtPeriodEnd: false,
      billingPeriodId: period.id,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      nextReconcileAt: nextWooEntitlementReconciliationAt(periodEnd, coverageEndAt),
      lastSyncedAt: now,
      lastSyncErrorCode: null,
      lastSyncErrorAt: null,
    },
  });
}

function requirePaidPlan(plan: WooPaidPlan): asserts plan is WooPaidPlan & { includedRecoveryConversationAllowance: number } {
  const allowance = plan.includedRecoveryConversationAllowance;
  if (plan.kind !== BillingPlanKind.PAID_METERED || !Number.isSafeInteger(allowance) || (allowance ?? -1) < 0) {
    throw new PermanentSubscriptionEvidenceError("TARGET_PAID_PLAN_INVALID");
  }
}