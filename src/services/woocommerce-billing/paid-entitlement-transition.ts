import {
  BillingPeriodCloseReason,
  BillingPeriodEntitlementCounterKind,
  BillingPeriodStatus,
  BillingPlanKind,
  SubscriptionProjectionStatus,
} from "@prisma/client";
import type { Prisma } from "@prisma/client";

import { closeBillingPeriod } from "../billing-period-transition/close-billing-period.js";
import {
  ensureSuccessorBillingPeriod,
  findCompatibleSuccessorBillingPeriod,
} from "../billing-period-transition/successor-billing-period.js";
import { endWooPaidSubscription } from "./subscription-period-projection.js";
import {
  currentWooEntitlementWindow,
  nextWooEntitlementReconciliationAt,
} from "./paid-entitlement-window.js";

type Transaction = Prisma.TransactionClient;
type CurrentSubscription = Prisma.SubscriptionGetPayload<{
  include: { plan: true; billingPeriod: { include: { entitlementCounters: true } } };
}>;

export type WooPaidEntitlementOutcome = "rolled-over" | "frozen" | "ended" | "unchanged";

export async function reconcileWooPaidSubscriptionInTransaction(
  transaction: Transaction,
  current: CurrentSubscription,
  now: Date,
): Promise<WooPaidEntitlementOutcome> {
  if (current.status !== SubscriptionProjectionStatus.ACTIVE
    || current.plan?.kind !== BillingPlanKind.PAID_METERED
    || !current.providerSubscriptionId) return "unchanged";

  const coverageEnd = current.providerCoverageEndAt;
  if (current.cancelAtPeriodEnd && coverageEnd && coverageEnd.getTime() <= now.getTime()) {
    await endWooPaidSubscription(transaction, current, current.providerSubscriptionId, coverageEnd, now);
    return "ended";
  }
  if (!coverageEnd || coverageEnd.getTime() <= now.getTime()) {
    await transaction.subscription.update({
      where: { id: current.id },
      data: { status: SubscriptionProjectionStatus.FROZEN, nextReconcileAt: null, lastSyncedAt: now },
    });
    return "frozen";
  }

  const period = current.billingPeriod;
  const previousPeriodEnd = current.currentPeriodEnd;
  if (!previousPeriodEnd || !current.currentPeriodStart || !period
    || current.billingPeriodId !== period.id
    || period.status !== BillingPeriodStatus.OPEN
    || period.planKindSnapshot !== BillingPlanKind.PAID_METERED
    || period.periodStart.getTime() !== current.currentPeriodStart.getTime()
    || period.periodEnd.getTime() !== previousPeriodEnd.getTime()) {
    throw new Error("Woo current paid entitlement period is inconsistent");
  }
  if (previousPeriodEnd.getTime() > now.getTime()) {
    await transaction.subscription.update({
      where: { id: current.id },
      data: { nextReconcileAt: nextWooEntitlementReconciliationAt(previousPeriodEnd, coverageEnd) },
    });
    return "unchanged";
  }

  const allowance = current.plan.includedRecoveryConversationAllowance;
  if (!Number.isSafeInteger(allowance) || (allowance ?? -1) < 0) {
    throw new Error("Woo paid plan allowance is invalid");
  }
  const window = currentWooEntitlementWindow(previousPeriodEnd, now);
  const successorInput = {
    shopId: current.shopId,
    subscriptionId: current.id,
    planId: current.plan.id,
    shopifyPlanHandleSnapshot: current.plan.shopifyPlanHandle,
    planNameSnapshot: current.plan.name,
    planKindSnapshot: BillingPlanKind.PAID_METERED,
    includedRecoveryCreditsGranted: allowance,
    periodStart: window.periodStart,
    periodEnd: window.periodEnd,
    errors: {
      closedPeriod: "Woo entitlement cadence already has a closed successor period",
      incompatiblePeriod: "Woo entitlement cadence has an incompatible successor period",
      incompatibleIncludedCounter: "Woo successor included-credit counter has an incompatible grant",
    },
  };
  const existingSuccessor = await findCompatibleSuccessorBillingPeriod(transaction, successorInput);
  if (existingSuccessor && current.billingPeriodId === existingSuccessor.id) return "unchanged";

  await closeBillingPeriod(transaction, {
    billingPeriodId: period.id,
    planKind: BillingPlanKind.PAID_METERED,
    closedAt: period.periodEnd,
    closeReason: BillingPeriodCloseReason.RENEWED_SAME_PLAN,
    openPeriodFailureMessage: "Woo paid entitlement period changed during close",
  });
  const successor = await ensureSuccessorBillingPeriod(transaction, successorInput, existingSuccessor);
  await transaction.billingPeriodEntitlementCounter.update({
    where: {
      billingPeriodId_counter: {
        billingPeriodId: successor.id,
        counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
      },
    },
    data: { currentAllowanceQuantity: allowance },
  });
  await transaction.subscription.update({
    where: { id: current.id },
    data: {
      billingPeriodId: successor.id,
      currentPeriodStart: window.periodStart,
      currentPeriodEnd: window.periodEnd,
      nextReconcileAt: nextWooEntitlementReconciliationAt(window.periodEnd, coverageEnd),
      lastSyncedAt: now,
      lastSyncErrorCode: null,
      lastSyncErrorAt: null,
    },
  });
  return "rolled-over";
}