import { describe, expect, it } from "vitest";
import { SubscriptionProjectionStatus } from "@prisma/client";

import {
  classifySubscriptionReconciliation,
  RETRYABLE_PLAN_CHANGE_SYNC_ERRORS,
  sameDate,
  type ReconciliationClassificationRow,
} from "../../../../src/services/billing-subscription-reconciliation/classification.js";

const nextReconcileAt = new Date("2026-09-12T12:00:00.000Z");
const expectedNextReconcileAt = nextReconcileAt.toISOString();
const pendingEffectiveAt = new Date("2026-09-12T11:00:00.000Z");
const job = { subscriptionId: "subscription-1", expectedNextReconcileAt };

function makeRow(overrides: {
  id?: string;
  status?: string;
  reinstallPendingAt?: Date | null;
  shopifyShopId?: string | null;
  onboardingCompleted?: boolean;
  subscription?: Partial<NonNullable<ReconciliationClassificationRow["subscription"]>> | null;
} = {}): ReconciliationClassificationRow {
  const baseSubscription: NonNullable<ReconciliationClassificationRow["subscription"]> = {
    id: "subscription-1",
    status: SubscriptionProjectionStatus.NO_CONTRACT,
    planId: null,
    pendingPlanId: "plan-pending",
    pendingShopifyPlanHandle: "pending-handle",
    pendingEffectiveAt,
    nextReconcileAt,
    billingPeriodId: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    lastSyncErrorCode: null,
  };
  const { subscription, ...shopOverrides } = overrides;
  return {
    id: "shop-1",
    status: "ACTIVE",
    reinstallPendingAt: null,
    shopifyShopId: "gid://shopify/Shop/1",
    onboardingCompleted: false,
    ...shopOverrides,
    subscription: subscription === null
      ? null
      : { ...baseSubscription, ...subscription },
  };
}

function classify(row: ReconciliationClassificationRow | null, jobOverride = job) {
  return classifySubscriptionReconciliation(row, jobOverride);
}

describe("classifySubscriptionReconciliation", () => {
  it("accepts reinstall before applying the ACTIVE-shop state machine", () => {
    const reinstallPendingAt = new Date("2026-09-11T12:00:00.000Z");
    const result = classify(makeRow({
      status: "UNINSTALLED",
      reinstallPendingAt,
      subscription: { status: SubscriptionProjectionStatus.FROZEN },
    }));

    expect(result).toMatchObject({
      type: "accepted",
      kind: "reinstall",
      expected: { subscriptionId: "subscription-1", nextReconcileAt, reinstallPendingAt },
    });
  });

  it("accepts initial activation without requiring pendingEffectiveAt", () => {
    const result = classify(makeRow({
      subscription: { pendingEffectiveAt: null },
    }));

    expect(result).toMatchObject({
      type: "accepted",
      kind: "initial-activation",
      expected: {
        subscriptionId: "subscription-1",
        pendingPlanId: "plan-pending",
        pendingShopifyPlanHandle: "pending-handle",
        pendingEffectiveAt: null,
        nextReconcileAt,
      },
    });
  });

  it("accepts cycle discovery and preserves its period-style snapshot shape", () => {
    const result = classify(makeRow({
      onboardingCompleted: true,
      subscription: {
        status: SubscriptionProjectionStatus.ACTIVE,
        planId: "plan-current",
        pendingPlanId: null,
        pendingShopifyPlanHandle: null,
        pendingEffectiveAt: null,
      },
    }));

    expect(result).toMatchObject({ type: "accepted", kind: "cycle-discovery" });
    if (result.type !== "accepted") throw new Error("expected accepted classification");
    expect(result.expected).toEqual({
      subscriptionId: "subscription-1",
      currentPlanId: "plan-current",
      billingPeriodId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      nextReconcileAt,
    });
  });

  it("accepts rollover when period-date fields are null", () => {
    const result = classify(makeRow({
      onboardingCompleted: true,
      subscription: {
        status: SubscriptionProjectionStatus.ACTIVE,
        planId: "plan-current",
        billingPeriodId: "period-current",
        pendingPlanId: null,
        pendingShopifyPlanHandle: null,
        pendingEffectiveAt: null,
      },
    }));

    expect(result).toMatchObject({ type: "accepted", kind: "rollover" });
    if (result.type !== "accepted") throw new Error("expected accepted classification");
    expect(result.expected.currentPeriodStart).toBeNull();
    expect(result.expected.currentPeriodEnd).toBeNull();
  });

  it("accepts established plan changes and preserves nullable current-cycle fields", () => {
    const result = classify(makeRow({
      onboardingCompleted: true,
      subscription: {
        status: SubscriptionProjectionStatus.ACTIVE,
        planId: "plan-current",
        pendingPlanId: "plan-target",
        pendingShopifyPlanHandle: "target-handle",
        pendingEffectiveAt,
      },
    }));

    expect(result).toMatchObject({
      type: "accepted",
      kind: "established-plan-change",
      expected: {
        subscriptionId: "subscription-1",
        currentPlanId: "plan-current",
        pendingPlanId: "plan-target",
        pendingShopifyPlanHandle: "target-handle",
        pendingEffectiveAt,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        billingPeriodId: null,
        nextReconcileAt,
      },
    });
  });

  it.each(RETRYABLE_PLAN_CHANGE_SYNC_ERRORS)("accepts retryable SYNC_ERROR %s", (lastSyncErrorCode) => {
    const result = classify(makeRow({
      onboardingCompleted: true,
      subscription: {
        status: SubscriptionProjectionStatus.SYNC_ERROR,
        planId: "plan-current",
        pendingPlanId: "plan-target",
        pendingShopifyPlanHandle: "target-handle",
        pendingEffectiveAt,
        lastSyncErrorCode,
      },
    }));

    expect(result).toMatchObject({ type: "accepted", kind: "established-plan-change" });
  });

  it("uses the same period-style expected shape for frozen reconciliation without pending keys", () => {
    const result = classify(makeRow({
      onboardingCompleted: true,
      subscription: {
        status: SubscriptionProjectionStatus.FROZEN,
        planId: "plan-current",
        billingPeriodId: "period-current",
        pendingPlanId: "plan-legacy-pending",
        pendingShopifyPlanHandle: "legacy-handle",
        pendingEffectiveAt,
      },
    }));

    expect(result).toMatchObject({ type: "accepted", kind: "frozen-reconciliation" });
    if (result.type !== "accepted") throw new Error("expected accepted classification");
    expect(Object.keys(result.expected).sort()).toEqual([
      "billingPeriodId",
      "currentPeriodEnd",
      "currentPeriodStart",
      "currentPlanId",
      "nextReconcileAt",
      "subscriptionId",
    ]);
    expect(result.expected.billingPeriodId).toBe("period-current");
  });

  it.each([
    ["missing row", null],
    ["missing subscription", makeRow({ subscription: null })],
    ["missing Shopify ID", makeRow({ shopifyShopId: null })],
  ])("skips %s first", (_label, row) => {
    expect(classify(row as ReconciliationClassificationRow | null)).toEqual({
      type: "skip",
      reason: "missing-shop-subscription-or-shopify-id",
    });
  });

  it("skips uninstalled rows that are not due before testing the subscription fence", () => {
    expect(classify(makeRow({
      status: "UNINSTALLED",
      reinstallPendingAt: null,
      subscription: { id: "other-subscription", nextReconcileAt: null },
    }))).toEqual({ type: "skip", reason: "uninstalled-reconciliation-not-due" });
  });

  it("skips subscription-id mismatch before stale-schedule mismatch", () => {
    expect(classify(makeRow({
      subscription: { id: "other-subscription", nextReconcileAt: new Date("2026-09-12T13:00:00.000Z") },
    }))).toEqual({
      type: "skip",
      reason: "subscription-id-mismatch",
      fields: { currentSubscriptionId: "other-subscription" },
    });
  });

  it("skips stale next-reconcile schedules with their original evidence", () => {
    const currentNextReconcileAt = new Date("2026-09-12T13:00:00.000Z");
    expect(classify(makeRow({ subscription: { nextReconcileAt: currentNextReconcileAt } }))).toEqual({
      type: "skip",
      reason: "stale-next-reconcile-at",
      fields: { currentNextReconcileAt: currentNextReconcileAt.toISOString() },
    });
  });

  it("skips inactive shops before normal subscription-state classification", () => {
    expect(classify(makeRow({ status: "SUSPENDED" }))).toEqual({
      type: "skip",
      reason: "shop-not-active",
      fields: { shopStatus: "SUSPENDED" },
    });
  });

  it("skips a cleared schedule before reporting ineligible subscription state", () => {
    expect(classify(makeRow({
      onboardingCompleted: true,
      subscription: {
        status: SubscriptionProjectionStatus.CANCELLED,
        planId: null,
        pendingPlanId: null,
        pendingShopifyPlanHandle: null,
        pendingEffectiveAt: null,
        nextReconcileAt: null,
      },
    }))).toEqual({ type: "skip", reason: "next-reconcile-at-cleared" });
  });

  it("skips non-retryable SYNC_ERROR plan changes", () => {
    const result = classify(makeRow({
      onboardingCompleted: true,
      subscription: {
        status: SubscriptionProjectionStatus.SYNC_ERROR,
        planId: "plan-current",
        pendingPlanId: "plan-target",
        pendingShopifyPlanHandle: "target-handle",
        pendingEffectiveAt,
        lastSyncErrorCode: "UNRELATED_ERROR",
      },
    }));

    expect(result).toMatchObject({
      type: "skip",
      reason: "subscription-state-ineligible",
      fields: {
        shopStatus: "ACTIVE",
        subscriptionStatus: SubscriptionProjectionStatus.SYNC_ERROR,
        onboardingCompleted: true,
        hasPlan: true,
        hasBillingPeriod: false,
        hasPendingPlan: true,
        hasPendingPlanHandle: true,
        hasPendingEffectiveAt: true,
      },
    });
  });

  it("keeps the frozen-state predicate permissive while reporting state evidence", () => {
    const result = classify(makeRow({
      onboardingCompleted: true,
      subscription: {
        status: SubscriptionProjectionStatus.CANCELLED,
        planId: null,
        pendingPlanId: null,
        pendingShopifyPlanHandle: null,
        pendingEffectiveAt: null,
      },
    }));

    expect(result).toMatchObject({
      type: "skip",
      reason: "subscription-state-ineligible",
      fields: { hasPlan: false, hasBillingPeriod: false },
    });
  });

  it("classifies immutable plain data without database, provider, or queue collaborators", () => {
    const immutableRow = Object.freeze(makeRow({
      subscription: Object.freeze({ pendingEffectiveAt: null }),
    }));

    expect(classify(immutableRow)).toMatchObject({ type: "accepted", kind: "initial-activation" });
  });
});

describe("sameDate", () => {
  it("preserves null and timestamp equality semantics", () => {
    expect(sameDate(null, null)).toBe(true);
    expect(sameDate(null, new Date(0))).toBe(false);
    expect(sameDate(new Date(1), new Date(1))).toBe(true);
    expect(sameDate(new Date(1), new Date(2))).toBe(false);
  });
});