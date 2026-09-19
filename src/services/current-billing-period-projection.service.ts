import {
  BillingPeriodEntitlementCounterKind,
  BillingPeriodStatus,
  BillingPlanKind,
  Prisma,
} from "@prisma/client";

export type CurrentBillingPeriodPlanProjection = {
  id: string;
  name: string;
  kind: BillingPlanKind;
  shopifyPlanHandle: string;
  includedRecoveryConversationAllowance: number | null;
};

export type CurrentBillingPeriodProjectionConflictReason =
  | "CLOSED_PERIOD"
  | "SUBSCRIPTION_MISMATCH"
  | "HANDLE_MISMATCH"
  | "PLAN_MISMATCH"
  | "PLAN_NAME_MISMATCH"
  | "PLAN_KIND_MISMATCH"
  | "INCLUDED_GRANT_MISMATCH"
  | "FREE_INCLUDED_COUNTER_PRESENT"
  | "INVALID_INCLUDED_ALLOWANCE"
  | "PAID_COUNTER_MISMATCH";

export type CurrentBillingPeriodProjectionResult =
  | {
      kind: "READY";
      billingPeriodId: string;
      repaired: boolean;
    }
  | {
      kind: "CONFLICT";
      billingPeriodId: string | null;
      reason: CurrentBillingPeriodProjectionConflictReason;
    };

export async function ensureCurrentBillingPeriodProjection(
  transaction: Prisma.TransactionClient,
  input: {
    shopId: string;
    subscriptionId: string;
    periodStart: Date;
    periodEnd: Date;
    providerPlanHandle: string;
    plan: CurrentBillingPeriodPlanProjection;
  },
): Promise<CurrentBillingPeriodProjectionResult> {
  const expectedGrant = input.plan.kind === BillingPlanKind.PAID_METERED
    ? input.plan.includedRecoveryConversationAllowance
    : null;
  if (input.plan.kind === BillingPlanKind.PAID_METERED
    && (!Number.isSafeInteger(expectedGrant) || (expectedGrant ?? -1) < 0)) {
    return { kind: "CONFLICT", billingPeriodId: null, reason: "INVALID_INCLUDED_ALLOWANCE" };
  }

  const existingPeriod = await transaction.billingPeriod.findUnique({
    where: {
      shopId_periodStart_periodEnd: {
        shopId: input.shopId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
      },
    },
  });
  if (!existingPeriod) {
    const period = await transaction.billingPeriod.create({
      data: {
        shopId: input.shopId,
        subscriptionId: input.subscriptionId,
        planId: input.plan.id,
        shopifyPlanHandleSnapshot: input.providerPlanHandle,
        planNameSnapshot: input.plan.name,
        planKindSnapshot: input.plan.kind,
        includedRecoveryCreditsGranted: expectedGrant,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        status: BillingPeriodStatus.OPEN,
      },
    });
    if (input.plan.kind === BillingPlanKind.PAID_METERED) {
      await transaction.billingPeriodEntitlementCounter.create({
        data: {
          shopId: input.shopId,
          billingPeriodId: period.id,
          counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
          grantedQuantity: expectedGrant as number,
          committedQuantity: 0,
          reservedQuantity: 0,
          forfeitedQuantity: 0,
        },
      });
    }
    return { kind: "READY", billingPeriodId: period.id, repaired: true };
  }

  if (existingPeriod.status === BillingPeriodStatus.CLOSED) {
    return { kind: "CONFLICT", billingPeriodId: existingPeriod.id, reason: "CLOSED_PERIOD" };
  }
  if (existingPeriod.subscriptionId !== input.subscriptionId) {
    return { kind: "CONFLICT", billingPeriodId: existingPeriod.id, reason: "SUBSCRIPTION_MISMATCH" };
  }
  if (existingPeriod.shopifyPlanHandleSnapshot !== null
    && existingPeriod.shopifyPlanHandleSnapshot !== input.providerPlanHandle) {
    return { kind: "CONFLICT", billingPeriodId: existingPeriod.id, reason: "HANDLE_MISMATCH" };
  }
  if (existingPeriod.planId !== null && existingPeriod.planId !== input.plan.id) {
    return { kind: "CONFLICT", billingPeriodId: existingPeriod.id, reason: "PLAN_MISMATCH" };
  }
  if (existingPeriod.planNameSnapshot !== null && existingPeriod.planNameSnapshot !== input.plan.name) {
    return { kind: "CONFLICT", billingPeriodId: existingPeriod.id, reason: "PLAN_NAME_MISMATCH" };
  }
  if (existingPeriod.planKindSnapshot !== null && existingPeriod.planKindSnapshot !== input.plan.kind) {
    return { kind: "CONFLICT", billingPeriodId: existingPeriod.id, reason: "PLAN_KIND_MISMATCH" };
  }
  if (existingPeriod.includedRecoveryCreditsGranted !== null
    && existingPeriod.includedRecoveryCreditsGranted !== expectedGrant) {
    return { kind: "CONFLICT", billingPeriodId: existingPeriod.id, reason: "INCLUDED_GRANT_MISMATCH" };
  }

  const counter = await transaction.billingPeriodEntitlementCounter.findUnique({
    where: {
      billingPeriodId_counter: {
        billingPeriodId: existingPeriod.id,
        counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
      },
    },
  });
  if (input.plan.kind === BillingPlanKind.FREE && counter) {
    return { kind: "CONFLICT", billingPeriodId: existingPeriod.id, reason: "FREE_INCLUDED_COUNTER_PRESENT" };
  }
  if (input.plan.kind === BillingPlanKind.PAID_METERED && counter) {
    const quantitiesValid = [counter.grantedQuantity, counter.committedQuantity, counter.reservedQuantity, counter.forfeitedQuantity]
      .every((quantity) => Number.isSafeInteger(quantity) && quantity >= 0);
    if (counter.shopId !== input.shopId
      || counter.billingPeriodId !== existingPeriod.id
      || counter.grantedQuantity !== expectedGrant
      || !quantitiesValid
      || counter.committedQuantity + counter.reservedQuantity + counter.forfeitedQuantity > counter.grantedQuantity) {
      return { kind: "CONFLICT", billingPeriodId: existingPeriod.id, reason: "PAID_COUNTER_MISMATCH" };
    }
  }

  const incomplete = existingPeriod.planId === null
    || existingPeriod.shopifyPlanHandleSnapshot === null
    || existingPeriod.planNameSnapshot === null
    || existingPeriod.planKindSnapshot === null
    || existingPeriod.includedRecoveryCreditsGranted === null && expectedGrant !== null;
  if (incomplete) {
    await transaction.billingPeriod.update({
      where: { id: existingPeriod.id },
      data: {
        planId: input.plan.id,
        shopifyPlanHandleSnapshot: input.providerPlanHandle,
        planNameSnapshot: input.plan.name,
        planKindSnapshot: input.plan.kind,
        includedRecoveryCreditsGranted: expectedGrant,
        status: BillingPeriodStatus.OPEN,
      },
    });
  }
  let repaired = incomplete;
  if (input.plan.kind === BillingPlanKind.PAID_METERED && !counter) {
    await transaction.billingPeriodEntitlementCounter.create({
      data: {
        shopId: input.shopId,
        billingPeriodId: existingPeriod.id,
        counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
        grantedQuantity: expectedGrant as number,
        committedQuantity: 0,
        reservedQuantity: 0,
        forfeitedQuantity: 0,
      },
    });
    repaired = true;
  }
  return { kind: "READY", billingPeriodId: existingPeriod.id, repaired };
}