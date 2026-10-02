import type { BillingSubscriptionReconcileJob } from "@modainteract/moda-interact-shared/billing";
import { SubscriptionProjectionStatus } from "@prisma/client";

export const RETRYABLE_PLAN_CHANGE_SYNC_ERRORS = [
  "UNEXPECTED_IMMEDIATE_PLAN_CHANGE",
  "MISSING_BILLING_CYCLE",
  "MISSING_USAGE_METER",
  "INVALID_INCLUDED_ALLOWANCE",
] as const;

export type InitialActivationExpected = {
  subscriptionId: string;
  pendingPlanId: string;
  pendingShopifyPlanHandle: string;
  pendingEffectiveAt: Date;
  nextReconcileAt: Date | null;
};

export type FreeCycleExpected = {
  subscriptionId: string;
  currentPlanId: string;
  nextReconcileAt: Date;
};

export type RolloverExpected = {
  subscriptionId: string;
  currentPlanId: string;
  billingPeriodId: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  nextReconcileAt: Date;
};

export type EstablishedPlanChangeExpected = {
  subscriptionId: string;
  currentPlanId: string;
  pendingPlanId: string;
  pendingShopifyPlanHandle: string;
  pendingEffectiveAt: Date;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  billingPeriodId: string | null;
  nextReconcileAt: Date;
};

export type ReinstallExpected = {
  subscriptionId: string;
  nextReconcileAt: Date;
  reinstallPendingAt: Date;
};

type ClassificationSubscription = {
  id: string;
  status: SubscriptionProjectionStatus;
  planId: string | null;
  pendingPlanId: string | null;
  pendingShopifyPlanHandle: string | null;
  pendingEffectiveAt: Date | null;
  nextReconcileAt: Date | null;
  billingPeriodId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  lastSyncErrorCode: string | null;
};

export type ReconciliationClassificationRow = {
  id: string;
  status: string;
  reinstallPendingAt: Date | null;
  shopifyShopId: string | null;
  settings: { onboardingCompleted: boolean } | null;
  subscription: ClassificationSubscription | null;
};

export type ClassifiedReconciliationRow = Omit<ReconciliationClassificationRow, "shopifyShopId" | "subscription"> & {
  shopifyShopId: string;
  subscription: Omit<ClassificationSubscription, "nextReconcileAt"> & { nextReconcileAt: Date };
};

export type ReconciliationSkipReason =
  | "missing-shop-subscription-or-shopify-id"
  | "uninstalled-reconciliation-not-due"
  | "subscription-id-mismatch"
  | "stale-next-reconcile-at"
  | "shop-not-active"
  | "next-reconcile-at-cleared"
  | "subscription-state-ineligible";

export type ReconciliationClassification =
  | { type: "skip"; reason: ReconciliationSkipReason; fields?: Record<string, unknown> }
  | { type: "accepted"; kind: "reinstall"; expected: ReinstallExpected; row: ClassifiedReconciliationRow }
  | { type: "accepted"; kind: "initial-activation"; expected: InitialActivationExpected; row: ClassifiedReconciliationRow }
  | { type: "accepted"; kind: "cycle-discovery"; expected: RolloverExpected; row: ClassifiedReconciliationRow }
  | { type: "accepted"; kind: "rollover"; expected: RolloverExpected; row: ClassifiedReconciliationRow }
  | { type: "accepted"; kind: "established-plan-change"; expected: EstablishedPlanChangeExpected; row: ClassifiedReconciliationRow }
  | { type: "accepted"; kind: "frozen-reconciliation"; expected: RolloverExpected; row: ClassifiedReconciliationRow };

type ReconciliationJobFence = Pick<BillingSubscriptionReconcileJob, "subscriptionId" | "expectedNextReconcileAt">;

export function sameDate(left: Date | null, right: Date | null): boolean {
  return left === null && right === null
    || left !== null && right !== null && left.getTime() === right.getTime();
}

export function classifySubscriptionReconciliation(
  row: ReconciliationClassificationRow | null,
  job: ReconciliationJobFence,
): ReconciliationClassification {
  if (!row || !row.subscription || !row.shopifyShopId) {
    return { type: "skip", reason: "missing-shop-subscription-or-shopify-id" };
  }

  const subscription = row.subscription;
  if (row.status === "UNINSTALLED") {
    if (row.reinstallPendingAt == null || subscription.nextReconcileAt === null) {
      return { type: "skip", reason: "uninstalled-reconciliation-not-due" };
    }
    if (subscription.id !== job.subscriptionId) {
      return {
        type: "skip",
        reason: "subscription-id-mismatch",
        fields: { currentSubscriptionId: subscription.id },
      };
    }
    if (subscription.nextReconcileAt.toISOString() !== job.expectedNextReconcileAt) {
      return {
        type: "skip",
        reason: "stale-next-reconcile-at",
        fields: { currentNextReconcileAt: subscription.nextReconcileAt.toISOString() },
      };
    }
    return {
      type: "accepted",
      kind: "reinstall",
      expected: {
        subscriptionId: subscription.id,
        nextReconcileAt: subscription.nextReconcileAt,
        reinstallPendingAt: row.reinstallPendingAt,
      },
      row: row as ClassifiedReconciliationRow,
    };
  }

  if (row.status !== "ACTIVE") {
    return { type: "skip", reason: "shop-not-active", fields: { shopStatus: row.status } };
  }

  const isInitialActivation = subscription.status === SubscriptionProjectionStatus.NO_CONTRACT
    && subscription.planId === null
    && subscription.pendingPlanId !== null
    && subscription.pendingShopifyPlanHandle !== null
    && subscription.nextReconcileAt !== null;
  const isCycleDiscovery = row.settings?.onboardingCompleted === true
    && (subscription.status === SubscriptionProjectionStatus.ACTIVE || subscription.status === SubscriptionProjectionStatus.TRIALING)
    && subscription.planId !== null
    && subscription.billingPeriodId === null
    && subscription.pendingPlanId === null
    && subscription.pendingShopifyPlanHandle === null
    && subscription.pendingEffectiveAt === null
    && subscription.nextReconcileAt !== null;
  const isRollover = row.settings?.onboardingCompleted === true
    && (subscription.status === SubscriptionProjectionStatus.ACTIVE || subscription.status === SubscriptionProjectionStatus.TRIALING)
    && subscription.planId !== null
    && subscription.billingPeriodId !== null
    && subscription.pendingPlanId === null
    && subscription.pendingShopifyPlanHandle === null
    && subscription.pendingEffectiveAt === null
    && subscription.nextReconcileAt !== null;
  const isFrozenReconciliation = row.settings?.onboardingCompleted === true
    && subscription.status === SubscriptionProjectionStatus.FROZEN
    && subscription.planId !== null
    && subscription.nextReconcileAt !== null;
  const isEstablishedPlanChange = row.settings?.onboardingCompleted === true
    && (
      subscription.status === SubscriptionProjectionStatus.ACTIVE
      || subscription.status === SubscriptionProjectionStatus.TRIALING
      || (subscription.status === SubscriptionProjectionStatus.SYNC_ERROR
        && RETRYABLE_PLAN_CHANGE_SYNC_ERRORS.includes(subscription.lastSyncErrorCode as typeof RETRYABLE_PLAN_CHANGE_SYNC_ERRORS[number]))
    )
    && subscription.planId !== null
    && subscription.pendingPlanId !== null
    && subscription.pendingShopifyPlanHandle !== null
    && subscription.pendingEffectiveAt !== null
    && subscription.nextReconcileAt !== null;

  if (subscription.id !== job.subscriptionId) {
    return {
      type: "skip",
      reason: "subscription-id-mismatch",
      fields: { currentSubscriptionId: subscription.id },
    };
  }
  if (!subscription.nextReconcileAt) {
    return { type: "skip", reason: "next-reconcile-at-cleared" };
  }
  if (subscription.nextReconcileAt.toISOString() !== job.expectedNextReconcileAt) {
    return {
      type: "skip",
      reason: "stale-next-reconcile-at",
      fields: { currentNextReconcileAt: subscription.nextReconcileAt.toISOString() },
    };
  }
  if (!isInitialActivation && !isCycleDiscovery && !isRollover && !isEstablishedPlanChange && !isFrozenReconciliation) {
    return {
      type: "skip",
      reason: "subscription-state-ineligible",
      fields: {
        shopStatus: row.status,
        subscriptionStatus: subscription.status,
        onboardingCompleted: row.settings?.onboardingCompleted ?? null,
        hasPlan: subscription.planId !== null,
        hasBillingPeriod: subscription.billingPeriodId !== null,
        hasPendingPlan: subscription.pendingPlanId !== null,
        hasPendingPlanHandle: subscription.pendingShopifyPlanHandle !== null,
        hasPendingEffectiveAt: subscription.pendingEffectiveAt !== null,
      },
    };
  }

  const acceptedRow = row as ClassifiedReconciliationRow;
  const periodExpected: RolloverExpected = {
    subscriptionId: subscription.id,
    currentPlanId: subscription.planId!,
    billingPeriodId: subscription.billingPeriodId!,
    currentPeriodStart: subscription.currentPeriodStart!,
    currentPeriodEnd: subscription.currentPeriodEnd!,
    nextReconcileAt: subscription.nextReconcileAt,
  };
  if (isInitialActivation) {
    return {
      type: "accepted",
      kind: "initial-activation",
      expected: {
        subscriptionId: subscription.id,
        pendingPlanId: subscription.pendingPlanId!,
        pendingShopifyPlanHandle: subscription.pendingShopifyPlanHandle!,
        pendingEffectiveAt: subscription.pendingEffectiveAt!,
        nextReconcileAt: subscription.nextReconcileAt,
      },
      row: acceptedRow,
    };
  }
  if (isCycleDiscovery) {
    return { type: "accepted", kind: "cycle-discovery", expected: periodExpected, row: acceptedRow };
  }
  if (isRollover) {
    return { type: "accepted", kind: "rollover", expected: periodExpected, row: acceptedRow };
  }
  if (isEstablishedPlanChange) {
    return {
      type: "accepted",
      kind: "established-plan-change",
      expected: {
        subscriptionId: subscription.id,
        currentPlanId: subscription.planId!,
        pendingPlanId: subscription.pendingPlanId!,
        pendingShopifyPlanHandle: subscription.pendingShopifyPlanHandle!,
        pendingEffectiveAt: subscription.pendingEffectiveAt!,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        billingPeriodId: subscription.billingPeriodId,
        nextReconcileAt: subscription.nextReconcileAt,
      },
      row: acceptedRow,
    };
  }
  return { type: "accepted", kind: "frozen-reconciliation", expected: periodExpected, row: acceptedRow };
}