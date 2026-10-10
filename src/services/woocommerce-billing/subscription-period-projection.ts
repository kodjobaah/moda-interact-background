import {
  BillingPeriodCloseReason,
  BillingPeriodEntitlementCounterKind,
  BillingPeriodStatus,
  BillingPlanKind,
  SubscriptionProjectionStatus,
} from "@prisma/client";
import type { BillingPlan, Prisma } from "@prisma/client";

import { closeBillingPeriod } from "../billing-period-transition/close-billing-period.js";
import { PermanentSubscriptionEvidenceError } from "./subscription-receipt-evidence.js";

type Transaction = Prisma.TransactionClient;
export type CurrentWooSubscription = Prisma.SubscriptionGetPayload<{
  include: { plan: true; billingPeriod: { include: { entitlementCounters: true } } };
}>;
export type WooPaidPlan = Pick<BillingPlan, "id" | "name" | "kind" | "shopifyPlanHandle" | "includedRecoveryConversationAllowance">;

const WOO_MODA_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

export async function switchWooSubscriptionPlan(
  transaction: Transaction,
  current: CurrentWooSubscription,
  plan: WooPaidPlan,
  now: Date,
): Promise<void> {
  requirePaidPlan(plan);
  const period = current.billingPeriod;
  if (!period || current.billingPeriodId !== period.id || period.status !== BillingPeriodStatus.OPEN
    || current.currentPeriodStart?.getTime() !== period.periodStart.getTime()
    || current.currentPeriodEnd?.getTime() !== period.periodEnd.getTime()) {
    throw new PermanentSubscriptionEvidenceError("CURRENT_PAID_PERIOD_INCONSISTENT");
  }
  const counter = await transaction.billingPeriodEntitlementCounter.findUnique({
    where: {
      billingPeriodId_counter: {
        billingPeriodId: period.id,
        counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
      },
    },
  });
  if (!counter || counter.shopId !== current.shopId || counter.grantedQuantity < 0) {
    throw new PermanentSubscriptionEvidenceError("CURRENT_PAID_COUNTER_MISSING");
  }
  const obligations = counter.committedQuantity + counter.reservedQuantity + counter.forfeitedQuantity;
  if (obligations > counter.grantedQuantity) {
    throw new PermanentSubscriptionEvidenceError("CURRENT_PAID_COUNTER_INCONSISTENT");
  }
  await transaction.billingPeriod.update({
    where: { id: period.id },
    data: {
      planId: plan.id,
      shopifyPlanHandleSnapshot: plan.shopifyPlanHandle,
      planNameSnapshot: plan.name,
      planKindSnapshot: BillingPlanKind.PAID_METERED,
      includedRecoveryCreditsGranted: plan.includedRecoveryConversationAllowance,
    },
  });
  await transaction.billingPeriodEntitlementCounter.update({
    where: { id: counter.id },
    data: {
      currentAllowanceQuantity: plan.includedRecoveryConversationAllowance,
      grantedQuantity: Math.max(counter.grantedQuantity, obligations, plan.includedRecoveryConversationAllowance!),
      version: { increment: 1 },
    },
  });
  await transaction.subscription.update({
    where: { id: current.id },
    data: {
      planId: plan.id,
      lastSyncedAt: now,
      lastSyncErrorCode: null,
      lastSyncErrorAt: null,
    },
  });
}

export async function endWooPaidSubscription(
  transaction: Transaction,
  current: CurrentWooSubscription,
  contractId: string,
  endAt: Date,
  now: Date,
): Promise<void> {
  const period = current.billingPeriod;
  if (current.providerSubscriptionId !== contractId || !period || current.billingPeriodId !== period.id
    || period.status !== BillingPeriodStatus.OPEN || period.planKindSnapshot !== BillingPlanKind.PAID_METERED) {
    throw new PermanentSubscriptionEvidenceError("TERMINAL_SUBSCRIPTION_STATE_INCONSISTENT");
  }
  const periodEnd = new Date(Math.min(period.periodEnd.getTime(), endAt.getTime()));
  if (periodEnd.getTime() <= period.periodStart.getTime()) {
    throw new PermanentSubscriptionEvidenceError("TERMINAL_PERIOD_BOUNDARY_INVALID");
  }
  const collision = await transaction.billingPeriod.findUnique({
    where: {
      shopId_periodStart_periodEnd: {
        shopId: current.shopId,
        periodStart: period.periodStart,
        periodEnd,
      },
    },
    select: { id: true },
  });
  if (collision && collision.id !== period.id) {
    throw new PermanentSubscriptionEvidenceError("TERMINAL_PERIOD_BOUNDARY_CONFLICT");
  }
  if (periodEnd.getTime() !== period.periodEnd.getTime()) {
    await transaction.billingPeriod.update({ where: { id: period.id }, data: { periodEnd } });
  }
  await closeBillingPeriod(transaction, {
    billingPeriodId: period.id,
    planKind: BillingPlanKind.PAID_METERED,
    closedAt: now,
    closeReason: BillingPeriodCloseReason.CONTRACT_ENDED,
    openPeriodFailureMessage: "Woo terminal billing period changed during close",
  });
  const freePlans = await transaction.billingPlan.findMany({
    where: { kind: BillingPlanKind.FREE, active: true },
    select: { id: true },
    take: 2,
  });
  if (freePlans.length !== 1) throw new PermanentSubscriptionEvidenceError("FREE_PLAN_NOT_UNIQUE");
  await transaction.subscription.update({
    where: { id: current.id },
    data: {
      status: SubscriptionProjectionStatus.ACTIVE,
      planId: freePlans[0]!.id,
      providerSubscriptionId: null,
      providerCoverageEndAt: null,
      billingPeriodId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
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