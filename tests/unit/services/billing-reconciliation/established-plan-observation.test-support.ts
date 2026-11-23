import { SubscriptionProjectionStatus } from "@prisma/client";
import { vi } from "vitest";

import { EstablishedPlanObservationService } from "../../../../src/services/billing-reconciliation/established-plan-observation.service.js";

export const now = new Date("2026-09-12T12:00:00.000Z");
export const currentCycleStart = new Date("2026-09-01T00:00:00.000Z");
export const currentCycleEnd = new Date("2026-10-01T00:00:00.000Z");
export const targetCycleEnd = new Date("2026-11-01T00:00:00.000Z");

export const currentPlan = {
  id: "plan-current",
  active: true,
  name: "Current",
  kind: "PAID_METERED" as const,
  shopifyPlanHandle: "pro-2026",
  shopifyUsageEventHandle: "recovery-old",
  shopifyRecoveryCreditPackEventHandle: "old-pack",
  recoveryCreditPackEnabled: false,
  includedRecoveryConversationAllowance: 50,
};

export const targetPlan = {
  id: "plan-target",
  active: true,
  name: "Target",
  kind: "PAID_METERED" as const,
  shopifyPlanHandle: "pro-2027",
  shopifyUsageEventHandle: "recovery-new",
  shopifyRecoveryCreditPackEventHandle: "pack-new",
  recoveryCreditPackEnabled: false,
  includedRecoveryConversationAllowance: 100,
};

export const existing = {
  id: "subscription-1",
  status: SubscriptionProjectionStatus.ACTIVE,
  planId: "plan-current",
  pendingPlanId: "plan-target",
  pendingShopifyPlanHandle: "pro-2027",
  pendingEffectiveAt: new Date("2026-09-01T00:00:00.000Z"),
  billingPeriodId: "period-old",
  currentPeriodStart: currentCycleStart,
  currentPeriodEnd: currentCycleEnd,
};

export const provider = {
  planHandle: "pro-2027",
  usageEventHandles: ["recovery-new", "pack-new"],
  pendingPlanHandle: null,
  pendingEffectiveAt: null,
  status: SubscriptionProjectionStatus.ACTIVE,
  currentPeriodStart: currentCycleEnd,
  currentPeriodEnd: targetCycleEnd,
  trialEndsAt: null,
  cancelAtPeriodEnd: false,
  providerSubscriptionId: "provider-subscription-1",
  providerUsageSnapshot: [],
  providerUsagePricingSnapshot: [],
};

export function establishedPlanObservationHarness() {
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    merchantPricingPlan: { findUnique: vi.fn().mockResolvedValue({ usageEvents: [{ eventHandle: "recovery-new" }, { eventHandle: "pack-new" }] }) },
    billingPeriod: { findUnique: vi.fn().mockResolvedValue({
      id: "period-old", subscriptionId: existing.id, status: "CLOSED", planKindSnapshot: "PAID_METERED",
    }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    billingPlan: { findUnique: vi.fn().mockResolvedValue(currentPlan) },
    usageEvent: { updateMany: vi.fn() },
    usageReservation: { aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: 0 } }), updateMany: vi.fn() },
    billingPeriodEntitlementCounter: {
      findUnique: vi.fn().mockResolvedValue(null), updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    subscription: {
      findUnique: vi.fn().mockImplementation(async () => existing),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const database = {
    billingPlan: { findUnique: vi.fn().mockResolvedValue(currentPlan) },
    subscription: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)),
  };
  const scheduler = { enqueue: vi.fn().mockResolvedValue(undefined) };
  const logger = { warn: vi.fn(), error: vi.fn() };
  const capacityResume = { schedule: vi.fn().mockResolvedValue("resume-job") };
  const transition = {
    transition: vi.fn().mockResolvedValue({
      kind: "transitioned" as const,
      billingPeriodId: "period-new",
      nextReconcileAt: null,
      planKind: "PAID_METERED" as const,
    }),
  };
  const service = new EstablishedPlanObservationService(
    database as never,
    scheduler,
    logger as never,
    capacityResume,
    transition as never,
  );
  return { database, transaction, scheduler, logger, capacityResume, transition, service };
}

export const paidPrerequisiteCases = [
  ["null Paid allowance", "INVALID_INCLUDED_ALLOWANCE", { includedRecoveryConversationAllowance: null }],
  ["negative Paid allowance", "INVALID_INCLUDED_ALLOWANCE", { includedRecoveryConversationAllowance: -1 }],
  ["non-integer Paid allowance", "INVALID_INCLUDED_ALLOWANCE", { includedRecoveryConversationAllowance: 1.5 }],
  ["unsafe Paid allowance", "INVALID_INCLUDED_ALLOWANCE", { includedRecoveryConversationAllowance: Number.MAX_SAFE_INTEGER + 1 }],
  ["enabled Paid pack meter null", "MISSING_USAGE_METER", { recoveryCreditPackEnabled: true, shopifyRecoveryCreditPackEventHandle: null }],
  ["provider omits Paid pack meter", "MISSING_USAGE_METER", { recoveryCreditPackEnabled: true, providerUsageEventHandles: ["recovery-new"] }],
] as const;

export const freePrerequisiteCases = [
  ["enabled Free pack meter null", { shopifyRecoveryCreditPackEventHandle: null, providerUsageEventHandles: [] }],
  ["provider omits Free pack meter", { shopifyRecoveryCreditPackEventHandle: "pack-new", providerUsageEventHandles: [] }],
] as const;
