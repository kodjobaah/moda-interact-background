import { Prisma, SubscriptionProjectionStatus } from "@prisma/client";

export type GenericExistingSubscription = {
  id: string;
  status: SubscriptionProjectionStatus;
  planId: string | null;
  pendingPlanId: string | null;
  pendingShopifyPlanHandle: string | null;
  pendingEffectiveAt: Date | null;
  billingPeriodId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  nextReconcileAt: Date | null;
};

export async function readLockedGenericSubscription(
  transaction: Prisma.TransactionClient,
  shopId: string,
  existing: GenericExistingSubscription | null,
) {
  if (existing) {
    await transaction.$queryRaw(Prisma.sql`
      SELECT "id"
      FROM "billing"."Subscription"
      WHERE "id" = ${existing.id}
      FOR UPDATE
    `);
  } else {
    await transaction.subscription.upsert({
      where: { shopId },
      update: {},
      create: { shopId, status: SubscriptionProjectionStatus.NO_CONTRACT },
    });
    const shell = await transaction.subscription.findUnique({ where: { shopId }, select: { id: true } });
    if (!shell) return null;
    await transaction.$queryRaw(Prisma.sql`
      SELECT "id"
      FROM "billing"."Subscription"
      WHERE "id" = ${shell.id}
      FOR UPDATE
    `);
  }

  const current = await transaction.subscription.findUnique({
    where: { shopId },
    select: {
      id: true,
      status: true,
      planId: true,
      billingPeriodId: true,
      currentPeriodStart: true,
      currentPeriodEnd: true,
      pendingPlanId: true,
      pendingShopifyPlanHandle: true,
      pendingEffectiveAt: true,
      nextReconcileAt: true,
    },
  });
  if (!current) return null;

  if (existing) {
    return matchesExpectedProjection(current, existing) ? current : null;
  }
  const emptyShell = current.status === SubscriptionProjectionStatus.NO_CONTRACT
    && current.planId === null
    && current.billingPeriodId === null
    && current.pendingPlanId === null
    && current.pendingShopifyPlanHandle === null
    && current.pendingEffectiveAt === null;
  return emptyShell ? current : null;
}

function matchesExpectedProjection(
  current: GenericExistingSubscription,
  expected: GenericExistingSubscription,
): boolean {
  return current.id === expected.id
    && current.status === expected.status
    && current.planId === expected.planId
    && current.billingPeriodId === expected.billingPeriodId
    && sameDate(current.currentPeriodStart ?? null, expected.currentPeriodStart ?? null)
    && sameDate(current.currentPeriodEnd ?? null, expected.currentPeriodEnd ?? null)
    && current.pendingPlanId === expected.pendingPlanId
    && current.pendingShopifyPlanHandle === expected.pendingShopifyPlanHandle
    && sameDate(current.pendingEffectiveAt ?? null, expected.pendingEffectiveAt ?? null)
    && sameDate(current.nextReconcileAt ?? null, expected.nextReconcileAt ?? null);
}

function sameDate(left: Date | null, right: Date | null): boolean {
  return left === null && right === null
    || left !== null && right !== null && left.getTime() === right.getTime();
}
