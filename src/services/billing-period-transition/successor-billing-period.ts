import {
  BillingPeriodEntitlementCounterKind,
  BillingPeriodStatus,
  BillingPlanKind,
} from "@prisma/client";
import type { Prisma } from "@prisma/client";

type Transition = Prisma.TransactionClient;

type SuccessorBillingPeriodIdentity = {
  shopId: string;
  subscriptionId: string;
  planId: string;
  shopifyPlanHandleSnapshot: string;
  planNameSnapshot: string;
  planKindSnapshot: BillingPlanKind;
  includedRecoveryCreditsGranted: number | null;
  periodStart: Date;
  periodEnd: Date;
};

type SuccessorBillingPeriodErrors = {
  closedPeriod: string;
  incompatiblePeriod: string;
  incompatibleIncludedCounter: string;
};

export type EnsureSuccessorBillingPeriodInput = SuccessorBillingPeriodIdentity & {
  errors: SuccessorBillingPeriodErrors;
};

export type CompatibleSuccessorBillingPeriod = { id: string };

export async function findCompatibleSuccessorBillingPeriod(
  transaction: Transition,
  input: EnsureSuccessorBillingPeriodInput,
): Promise<CompatibleSuccessorBillingPeriod | null> {
  const successor = await transaction.billingPeriod.findUnique({
    where: {
      shopId_periodStart_periodEnd: {
        shopId: input.shopId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
      },
    },
  });
  if (!successor) return null;
  if (successor.status === BillingPeriodStatus.CLOSED) {
    throw new Error(input.errors.closedPeriod);
  }
  if (
    successor.shopId !== input.shopId
    || successor.subscriptionId !== input.subscriptionId
    || successor.planId !== input.planId
    || successor.shopifyPlanHandleSnapshot !== input.shopifyPlanHandleSnapshot
    || successor.planNameSnapshot !== input.planNameSnapshot
    || successor.planKindSnapshot !== input.planKindSnapshot
    || successor.includedRecoveryCreditsGranted !== input.includedRecoveryCreditsGranted
    || successor.periodStart.getTime() !== input.periodStart.getTime()
    || successor.periodEnd.getTime() !== input.periodEnd.getTime()
    || successor.status !== BillingPeriodStatus.OPEN
  ) {
    throw new Error(input.errors.incompatiblePeriod);
  }
  return { id: successor.id };
}

export async function ensureSuccessorBillingPeriod(
  transaction: Transition,
  input: EnsureSuccessorBillingPeriodInput,
  existingSuccessor: CompatibleSuccessorBillingPeriod | null,
): Promise<CompatibleSuccessorBillingPeriod> {
  const period = existingSuccessor ?? await transaction.billingPeriod.create({
    data: {
      shopId: input.shopId,
      subscriptionId: input.subscriptionId,
      planId: input.planId,
      shopifyPlanHandleSnapshot: input.shopifyPlanHandleSnapshot,
      planNameSnapshot: input.planNameSnapshot,
      planKindSnapshot: input.planKindSnapshot,
      includedRecoveryCreditsGranted: input.includedRecoveryCreditsGranted,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      status: BillingPeriodStatus.OPEN,
    },
  });

  if (input.planKindSnapshot === BillingPlanKind.PAID_METERED) {
    const expectedGrant = input.includedRecoveryCreditsGranted;
    if (expectedGrant === null) {
      throw new Error(input.errors.incompatibleIncludedCounter);
    }
    const counter = await transaction.billingPeriodEntitlementCounter.findUnique({
      where: {
        billingPeriodId_counter: {
          billingPeriodId: period.id,
          counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
        },
      },
    });
    if (counter && counter.grantedQuantity !== expectedGrant) {
      throw new Error(input.errors.incompatibleIncludedCounter);
    }
    await transaction.billingPeriodEntitlementCounter.upsert({
      where: {
        billingPeriodId_counter: {
          billingPeriodId: period.id,
          counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
        },
      },
      update: {},
      create: {
        shopId: input.shopId,
        billingPeriodId: period.id,
        counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
        grantedQuantity: expectedGrant,
        committedQuantity: 0,
        reservedQuantity: 0,
        forfeitedQuantity: 0,
      },
    });
  }

  return { id: period.id };
}
