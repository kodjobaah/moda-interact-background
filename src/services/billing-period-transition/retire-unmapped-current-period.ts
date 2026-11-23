import {
  BillingPeriodCloseReason,
  BillingPeriodStatus,
  type BillingPlanKind,
  type Prisma,
} from "@prisma/client";

import { closeBillingPeriod } from "./close-billing-period.js";

/**
 * Retire only the period currently attached to a locked subscription.
 * Historical periods remain intact. The caller must detach the current
 * subscription pointer in the same transaction after this returns.
 */
export async function retireUnmappedCurrentPeriod(
  transaction: Prisma.TransactionClient,
  input: { subscriptionId: string; billingPeriodId: string | null; now: Date; closeReason?: BillingPeriodCloseReason },
): Promise<void> {
  if (!input.billingPeriodId) return;
  const period = await transaction.billingPeriod.findUnique({
    where: { id: input.billingPeriodId },
    select: { id: true, subscriptionId: true, status: true, planKindSnapshot: true, planId: true },
  });
  if (!period || period.subscriptionId !== input.subscriptionId) {
    throw new Error("Current billing period is missing or belongs to another subscription during plan unmapping");
  }
  if (period.status === BillingPeriodStatus.CLOSED) return;
  let kind: BillingPlanKind | null = period.planKindSnapshot;
  if (!kind && period.planId) {
    const plan = await transaction.billingPlan.findUnique({
      where: { id: period.planId }, select: { kind: true },
    });
    kind = plan?.kind ?? null;
  }
  if (!kind) throw new Error("Open billing period kind is unavailable during plan unmapping");
  await closeBillingPeriod(transaction, {
    billingPeriodId: period.id,
    planKind: kind,
    closedAt: input.now,
    closeReason: input.closeReason ?? BillingPeriodCloseReason.PLAN_CHANGED,
    openPeriodFailureMessage: "Current billing period changed while unmapping the provider plan",
  });
}
