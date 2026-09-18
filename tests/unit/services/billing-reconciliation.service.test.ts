import { describe, expect, it, vi } from "vitest";

import { BillingReconciliationService } from "../../../src/services/billing-reconciliation.service.js";
import { SamePlanBillingPeriodRolloverService } from "../../../src/services/same-plan-billing-period-rollover.service.js";
import { ShopifyPlanChangeTransitionService } from "../../../src/services/shopify-plan-change-transition.service.js";
import { recoveryCapacityResumeService } from "../../../src/services/recovery-capacity-resume.service.js";

const providerSubscription = {
  planHandle: "pro-2026",
  usageEventHandles: ["recovery-meter"],
  pendingPlanHandle: "pro-2027",
  pendingEffectiveAt: new Date("2026-10-01T00:00:00.000Z"),
  status: "ACTIVE" as const,
  currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
  currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
  trialEndsAt: null,
  cancelAtPeriodEnd: false,
  providerSubscriptionId: "sub-1",
  providerUsageSnapshot: [{
    handle: "recovery-meter",
    quantity: 7,
    costAmount: "7.00",
    costCurrency: "USD",
  }, {
    handle: "pack-meter",
    quantity: 2,
    costAmount: "20.00",
    costCurrency: "USD",
  }],
};

function harness({
  partnerResult = providerSubscription,
  partnerError,
  plan = { id: "plan-1", active: true, kind: "PAID_METERED", shopifyUsageEventHandle: "recovery-meter", shopifyRecoveryCreditPackEventHandle: "pack-meter" },
  modaQuantity = 5,
  nowValue = () => new Date("2026-09-12T12:00:00.000Z"),
  queue,
} = {}) {
  const subscriptionUpsert = vi.fn();
  const database = {
    shop: {
      findMany: vi.fn().mockResolvedValue([{ id: "shop-1", shopifyShopId: "gid://shopify/Shop/1" }]),
    },
    shopSettings: {
      findUnique: vi.fn().mockResolvedValue({ onboardingCompleted: true }),
    },
    billingPlan: {
      findUnique: vi.fn()
        .mockResolvedValueOnce(plan)
        .mockResolvedValueOnce({ id: "plan-2", active: true }),
    },
    billingPeriod: {
      upsert: vi.fn().mockResolvedValue({ id: "period-1" }),
    },
    subscription: {
      upsert: subscriptionUpsert,
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue({
        id: "subscription-1",
        billingPeriodId: "period-1",
        plan: { kind: "PAID_METERED", shopifyUsageEventHandle: "recovery-meter" },
        pendingShopifyPlanHandle: null,
        pendingPlanId: null,
        pendingEffectiveAt: null,
      }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "subscription-1" }),
    },
    $transaction: vi.fn(),
    usageEvent: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: modaQuantity } }),
    },
  };
  const partner = {
    getActiveSubscription: vi.fn().mockImplementation(async () => {
      if (partnerError) throw partnerError;
      return partnerResult;
    }),
    getSubscriptionReconciliationSnapshot: vi.fn().mockImplementation(async () => {
      return { activeSubscription: await partner.getActiveSubscription("gid://shopify/Shop/1"), latestLifecycleEvent: null };
    }),
  };
  const publisher = { publishDue: vi.fn().mockResolvedValue({ selected: 0, claimed: 0, reported: 0, retryable: 0, needsAttention: 0 }) };
  const purchases = {
    reconcileProviderConfirmed: vi.fn().mockResolvedValue({
      activatedCount: 1,
      alreadyMatchedUnits: 0,
      eligibleCandidateCount: 1,
      confirmedDelta: 1,
      discrepancy: null,
    }),
  };
  const logger = { warn: vi.fn(), error: vi.fn() };
  const service = new BillingReconciliationService(
    database as never,
    partner,
    publisher,
    purchases,
    logger as never,
    nowValue,
    queue,
  );
  return { database, partner, publisher, purchases, logger, service };
}

describe("BillingReconciliationService", () => {
  it("passes the configured shop and usage batches through one cycle", async () => {
    const test = harness();
    const runtimeConfig = {
      billingReconciliationShopBatchSize: 15,
      shopifyUsagePublishBatchSize: 12,
      shopifyUsageRetryBaseSeconds: 7,
      shopifyUsageRetryMaxSeconds: 70,
      billingFrozenRecheckSeconds: 90,
      billingProviderRetrySeconds: 30,
    } as const;

    await test.service.reconcileOnce(runtimeConfig);

    expect(test.database.shop.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 15 }));
    expect(test.publisher.publishDue).toHaveBeenCalledWith({ runtimeConfig });
  });

  it("fails closed before the boundary and never exposes the stale pack meter", async () => {
    const queue = { add: vi.fn().mockResolvedValue({}) };
    const test = harness({ queue, plan: { id: "plan-target", active: true, kind: "PAID_METERED", shopifyUsageEventHandle: "recovery-new", shopifyRecoveryCreditPackEventHandle: "pack-new" }, partnerResult: { ...providerSubscription, planHandle: "pro-2027", usageEventHandles: ["recovery-new"], currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z") } });
    test.database.billingPlan.findUnique.mockImplementation(async ({ where }: { where: { id?: string; shopifyPlanHandle?: string } }) => where.id ? { id: "plan-current", active: true, kind: "PAID_METERED", shopifyRecoveryCreditPackEventHandle: "old-pack" } : { id: "plan-target", active: true, kind: "PAID_METERED", shopifyUsageEventHandle: "recovery-new", shopifyRecoveryCreditPackEventHandle: "pack-new" });
    test.database.subscription.findUnique.mockResolvedValue({ id: "subscription-1", status: "ACTIVE", planId: "plan-current", pendingPlanId: "plan-target", pendingShopifyPlanHandle: "pro-2027", pendingEffectiveAt: new Date("2026-10-01T00:00:00.000Z"), billingPeriodId: "period-old", currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"), nextReconcileAt: new Date("2026-09-12T12:00:00.000Z") });

    const result = await test.service.reconcileOnce();

    expect(result.subscriptionErrors).toBe(0);
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SYNC_ERROR", lastSyncErrorCode: "UNEXPECTED_IMMEDIATE_PLAN_CHANGE" }) }));
    expect(test.purchases.reconcileProviderConfirmed).toHaveBeenCalled();
  });

  it("schedules plan-change capacity resume after a successful rotating Paid transition", async () => {
    const queue = { add: vi.fn().mockResolvedValue({}) };
    const test = harness({ nowValue: () => new Date("2026-10-01T00:00:01.000Z"), queue, plan: { id: "plan-target", active: true, kind: "PAID_METERED", shopifyPlanHandle: "pro-2027", shopifyUsageEventHandle: "recovery-new", shopifyRecoveryCreditPackEventHandle: "pack-new", recoveryCreditPackEnabled: false, includedRecoveryConversationAllowance: 100 }, partnerResult: { ...providerSubscription, planHandle: "pro-2027", usageEventHandles: ["recovery-new"], currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z") } });
    test.database.billingPlan.findUnique.mockImplementation(async ({ where }: { where: { id?: string; shopifyPlanHandle?: string } }) => where.id ? { id: "plan-current", active: true, kind: "PAID_METERED", shopifyPlanHandle: "pro-2026", shopifyUsageEventHandle: "recovery-old", shopifyRecoveryCreditPackEventHandle: "old-pack", recoveryCreditPackEnabled: false, includedRecoveryConversationAllowance: 50 } : { id: "plan-target", active: true, kind: "PAID_METERED", shopifyPlanHandle: "pro-2027", shopifyUsageEventHandle: "recovery-new", shopifyRecoveryCreditPackEventHandle: "pack-new", recoveryCreditPackEnabled: false, includedRecoveryConversationAllowance: 100 });
    test.database.subscription.findUnique.mockResolvedValue({ id: "subscription-1", status: "ACTIVE", planId: "plan-current", pendingPlanId: "plan-target", pendingShopifyPlanHandle: "pro-2027", pendingEffectiveAt: new Date("2026-10-01T00:00:00.000Z"), billingPeriodId: "period-old", currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"), nextReconcileAt: new Date("2026-09-12T12:00:00.000Z") });
    const transition = vi.spyOn(ShopifyPlanChangeTransitionService.prototype, "transition").mockResolvedValue({ kind: "transitioned", billingPeriodId: "period-new", nextReconcileAt: null, planKind: "PAID_METERED" });
    const resume = vi.spyOn(recoveryCapacityResumeService, "schedule").mockResolvedValue(undefined);

    await expect(test.service.reconcileOnce()).resolves.toMatchObject({ subscriptionErrors: 0 });

    expect(resume).toHaveBeenCalledWith({ shopId: "shop-1", trigger: "plan-change" });
    transition.mockRestore();
    resume.mockRestore();
  });

  it("swallows rotating capacity-resume enqueue failure after a successful transition", async () => {
    const queue = { add: vi.fn().mockResolvedValue({}) };
    const test = harness({ nowValue: () => new Date("2026-10-01T00:00:01.000Z"), queue, plan: { id: "plan-target", active: true, kind: "PAID_METERED", shopifyPlanHandle: "pro-2027", shopifyUsageEventHandle: "recovery-new", shopifyRecoveryCreditPackEventHandle: "pack-new", recoveryCreditPackEnabled: false, includedRecoveryConversationAllowance: 100 }, partnerResult: { ...providerSubscription, planHandle: "pro-2027", usageEventHandles: ["recovery-new"], currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z") } });
    test.database.billingPlan.findUnique.mockImplementation(async ({ where }: { where: { id?: string; shopifyPlanHandle?: string } }) => where.id ? { id: "plan-current", active: true, kind: "PAID_METERED", shopifyPlanHandle: "pro-2026", shopifyUsageEventHandle: "recovery-old", shopifyRecoveryCreditPackEventHandle: "old-pack", recoveryCreditPackEnabled: false, includedRecoveryConversationAllowance: 50 } : { id: "plan-target", active: true, kind: "PAID_METERED", shopifyPlanHandle: "pro-2027", shopifyUsageEventHandle: "recovery-new", shopifyRecoveryCreditPackEventHandle: "pack-new", recoveryCreditPackEnabled: false, includedRecoveryConversationAllowance: 100 });
    test.database.subscription.findUnique.mockResolvedValue({ id: "subscription-1", status: "ACTIVE", planId: "plan-current", pendingPlanId: "plan-target", pendingShopifyPlanHandle: "pro-2027", pendingEffectiveAt: new Date("2026-10-01T00:00:00.000Z"), billingPeriodId: "period-old", currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"), nextReconcileAt: new Date("2026-09-12T12:00:00.000Z") });
    const transition = vi.spyOn(ShopifyPlanChangeTransitionService.prototype, "transition").mockResolvedValue({ kind: "transitioned", billingPeriodId: "period-new", nextReconcileAt: null, planKind: "PAID_METERED" });
    vi.spyOn(recoveryCapacityResumeService, "schedule").mockRejectedValue(new Error("Redis unavailable"));

    await expect(test.service.reconcileOnce()).resolves.toMatchObject({ subscriptionErrors: 0 });

    expect(test.logger.warn).toHaveBeenCalledWith("billing.recovery_capacity_resume.enqueue_failed", expect.objectContaining({ shopId: "shop-1" }));
    transition.mockRestore();
    vi.restoreAllMocks();
  });

  it("fails closed for a mapped unexpected provider-current plan without exposing a pack meter", async () => {
    const queue = { add: vi.fn().mockResolvedValue({}) };
    const currentPlan = { id: "plan-current", active: true, kind: "PAID_METERED", shopifyPlanHandle: "pro-2026", shopifyUsageEventHandle: "recovery-old", shopifyRecoveryCreditPackEventHandle: "old-pack", recoveryCreditPackEnabled: false, includedRecoveryConversationAllowance: 50 };
    const targetPlan = { id: "plan-target", active: true, kind: "PAID_METERED", shopifyPlanHandle: "pro-2027", shopifyUsageEventHandle: "recovery-new", shopifyRecoveryCreditPackEventHandle: "pack-new", recoveryCreditPackEnabled: false, includedRecoveryConversationAllowance: 100 };
    const thirdPlan = { id: "plan-third", active: true, kind: "PAID_METERED", shopifyPlanHandle: "pro-2028", shopifyUsageEventHandle: "recovery-third", shopifyRecoveryCreditPackEventHandle: "pack-third", recoveryCreditPackEnabled: false, includedRecoveryConversationAllowance: 200 };
    const test = harness({ queue, plan: thirdPlan, partnerResult: { ...providerSubscription, planHandle: "pro-2028", usageEventHandles: ["recovery-third"], currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z") } });
    test.database.billingPlan.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => where.id ? currentPlan : thirdPlan);
    test.database.subscription.findUnique.mockResolvedValue({ id: "subscription-1", status: "ACTIVE", planId: "plan-current", pendingPlanId: "plan-target", pendingShopifyPlanHandle: "pro-2027", pendingEffectiveAt: new Date("2026-10-01T00:00:00.000Z"), billingPeriodId: "period-old", currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"), nextReconcileAt: new Date("2026-09-12T12:00:00.000Z") });
    const transition = vi.spyOn(ShopifyPlanChangeTransitionService.prototype, "transition");

    const result = await test.service.reconcileOnce();

    expect(result.subscriptionErrors).toBe(0);
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SYNC_ERROR", lastSyncErrorCode: "UNEXPECTED_IMMEDIATE_PLAN_CHANGE", nextReconcileAt: new Date("2026-09-12T12:01:00.000Z") }) }));
    expect(test.purchases.reconcileProviderConfirmed).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledOnce();
    expect(transition).not.toHaveBeenCalled();
    transition.mockRestore();
  });

  it.each([
    ["missing cycle", { currentPeriodStart: null, currentPeriodEnd: null }],
    ["invalid cycle", { currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z") }],
  ] as const)("fails closed for rotating provider-current target with %s", async (_label, cycle) => {
    const queue = { add: vi.fn().mockResolvedValue({}) };
    const targetPlan = { id: "plan-target", active: true, kind: "PAID_METERED", shopifyPlanHandle: "pro-2027", shopifyUsageEventHandle: "recovery-new", shopifyRecoveryCreditPackEventHandle: "pack-new", recoveryCreditPackEnabled: false, includedRecoveryConversationAllowance: 100 };
    const test = harness({ queue, plan: targetPlan, partnerResult: { ...providerSubscription, planHandle: "pro-2027", usageEventHandles: ["recovery-new"], ...cycle } });
    const currentPlan = { id: "plan-current", active: true, kind: "PAID_METERED", shopifyPlanHandle: "pro-2026", shopifyUsageEventHandle: "recovery-old", shopifyRecoveryCreditPackEventHandle: "old-pack", recoveryCreditPackEnabled: false, includedRecoveryConversationAllowance: 50 };
    test.database.billingPlan.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => where.id ? currentPlan : targetPlan);
    test.database.subscription.findUnique.mockResolvedValue({ id: "subscription-1", status: "ACTIVE", planId: "plan-current", pendingPlanId: "plan-target", pendingShopifyPlanHandle: "pro-2027", pendingEffectiveAt: new Date("2026-09-01T00:00:00.000Z"), billingPeriodId: "period-old", currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"), nextReconcileAt: new Date("2026-09-12T12:00:00.000Z") });
    const transition = vi.spyOn(ShopifyPlanChangeTransitionService.prototype, "transition");

    const result = await test.service.reconcileOnce();

    expect(result.subscriptionErrors).toBe(0);
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SYNC_ERROR", lastSyncErrorCode: "MISSING_BILLING_CYCLE" }) }));
    expect(test.purchases.reconcileProviderConfirmed).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledOnce();
    expect(transition).not.toHaveBeenCalled();
    transition.mockRestore();
  });

  it.each([
    ["null Paid allowance", "INVALID_INCLUDED_ALLOWANCE", { kind: "PAID_METERED", includedRecoveryConversationAllowance: null }],
    ["negative Paid allowance", "INVALID_INCLUDED_ALLOWANCE", { kind: "PAID_METERED", includedRecoveryConversationAllowance: -1 }],
    ["non-integer Paid allowance", "INVALID_INCLUDED_ALLOWANCE", { kind: "PAID_METERED", includedRecoveryConversationAllowance: 1.5 }],
    ["unsafe Paid allowance", "INVALID_INCLUDED_ALLOWANCE", { kind: "PAID_METERED", includedRecoveryConversationAllowance: Number.MAX_SAFE_INTEGER + 1 }],
    ["missing normal Paid meter config", "MISSING_USAGE_METER", { kind: "PAID_METERED", shopifyUsageEventHandle: null }],
    ["provider omits normal Paid meter", "MISSING_USAGE_METER", { kind: "PAID_METERED", providerUsageEventHandles: [] }],
    ["enabled Paid pack meter null", "MISSING_USAGE_METER", { kind: "PAID_METERED", recoveryCreditPackEnabled: true, shopifyRecoveryCreditPackEventHandle: null }],
    ["provider omits Paid pack meter", "MISSING_USAGE_METER", { kind: "PAID_METERED", recoveryCreditPackEnabled: true, providerUsageEventHandles: ["recovery-new"] }],
    ["enabled Free pack meter null", "MISSING_USAGE_METER", { kind: "FREE", recoveryCreditPackEnabled: true, shopifyRecoveryCreditPackEventHandle: null, includedRecoveryConversationAllowance: null }],
    ["provider omits Free pack meter", "MISSING_USAGE_METER", { kind: "FREE", recoveryCreditPackEnabled: true, shopifyRecoveryCreditPackEventHandle: "pack-new", providerUsageEventHandles: [] }],
  ] as const)("fails closed for rotating target prerequisite: %s", async (_label, expectedCode, mutation) => {
    const queue = { add: vi.fn().mockResolvedValue({}) };
    const targetPlan = { id: "plan-target", active: true, name: "Target", shopifyPlanHandle: "pro-2027", shopifyUsageEventHandle: "recovery-new", shopifyRecoveryCreditPackEventHandle: "pack-new", recoveryCreditPackEnabled: false, includedRecoveryConversationAllowance: 100, ...mutation };
    const currentPlan = { id: "plan-current", active: true, name: "Current", kind: "PAID_METERED", shopifyPlanHandle: "pro-2026", shopifyUsageEventHandle: "recovery-old", shopifyRecoveryCreditPackEventHandle: "old-pack", recoveryCreditPackEnabled: false, includedRecoveryConversationAllowance: 50 };
    const test = harness({ queue, plan: targetPlan, partnerResult: { ...providerSubscription, planHandle: "pro-2027", usageEventHandles: mutation.providerUsageEventHandles ?? ["recovery-new", "pack-new"], currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z") } });
    test.database.billingPlan.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => where.id ? currentPlan : targetPlan);
    test.database.subscription.findUnique.mockResolvedValue({ id: "subscription-1", status: "ACTIVE", planId: "plan-current", pendingPlanId: "plan-target", pendingShopifyPlanHandle: "pro-2027", pendingEffectiveAt: new Date("2026-09-01T00:00:00.000Z"), billingPeriodId: "period-old", currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"), nextReconcileAt: new Date("2026-09-12T12:00:00.000Z") });
    const transition = vi.spyOn(ShopifyPlanChangeTransitionService.prototype, "transition");

    const result = await test.service.reconcileOnce();

    expect(result.subscriptionErrors).toBe(0);
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SYNC_ERROR", lastSyncErrorCode: expectedCode }) }));
    expect(test.purchases.reconcileProviderConfirmed).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledOnce();
    expect(transition).not.toHaveBeenCalled();
    transition.mockRestore();
  });

  it("does not schedule plan-change capacity resume after a successful Free transition", async () => {
    const queue = { add: vi.fn().mockResolvedValue({}) };
    const targetPlan = { id: "plan-target", active: true, kind: "FREE", shopifyPlanHandle: "pro-2027", shopifyUsageEventHandle: null, shopifyRecoveryCreditPackEventHandle: null, recoveryCreditPackEnabled: false, includedRecoveryConversationAllowance: null };
    const test = harness({ queue, plan: targetPlan, partnerResult: { ...providerSubscription, planHandle: "pro-2027", usageEventHandles: [], currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z") } });
    const currentPlan = { id: "plan-current", active: true, kind: "PAID_METERED", shopifyPlanHandle: "pro-2026", shopifyUsageEventHandle: "recovery-old", shopifyRecoveryCreditPackEventHandle: null, recoveryCreditPackEnabled: false, includedRecoveryConversationAllowance: 50 };
    test.database.billingPlan.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => where.id ? currentPlan : targetPlan);
    test.database.subscription.findUnique.mockResolvedValue({ id: "subscription-1", status: "ACTIVE", planId: "plan-current", pendingPlanId: "plan-target", pendingShopifyPlanHandle: "pro-2027", pendingEffectiveAt: new Date("2026-09-01T00:00:00.000Z"), billingPeriodId: "period-old", currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"), nextReconcileAt: new Date("2026-09-12T12:00:00.000Z") });
    const transition = vi.spyOn(ShopifyPlanChangeTransitionService.prototype, "transition").mockResolvedValue({ kind: "transitioned", billingPeriodId: null, nextReconcileAt: null, planKind: "FREE" });
    const resume = vi.spyOn(recoveryCapacityResumeService, "schedule").mockResolvedValue(undefined);

    await test.service.reconcileOnce();

    expect(resume).not.toHaveBeenCalled();
    transition.mockRestore();
    resume.mockRestore();
  });

  it("fails closed when the expected effective target transition returns not-applicable", async () => {
    const queue = { add: vi.fn().mockResolvedValue({}) };
    const targetPlan = { id: "plan-target", active: true, kind: "PAID_METERED", shopifyPlanHandle: "pro-2027", shopifyUsageEventHandle: "recovery-new", shopifyRecoveryCreditPackEventHandle: "pack-new", recoveryCreditPackEnabled: false, includedRecoveryConversationAllowance: 100 };
    const test = harness({ queue, plan: targetPlan, partnerResult: { ...providerSubscription, planHandle: "pro-2027", usageEventHandles: ["recovery-new"], currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z") } });
    const currentPlan = { id: "plan-current", active: true, kind: "PAID_METERED", shopifyPlanHandle: "pro-2026", shopifyUsageEventHandle: "recovery-old", shopifyRecoveryCreditPackEventHandle: null, recoveryCreditPackEnabled: false, includedRecoveryConversationAllowance: 50 };
    test.database.billingPlan.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => where.id ? currentPlan : targetPlan);
    test.database.subscription.findUnique.mockResolvedValue({ id: "subscription-1", status: "ACTIVE", planId: "plan-current", pendingPlanId: "plan-target", pendingShopifyPlanHandle: "pro-2027", pendingEffectiveAt: new Date("2026-09-01T00:00:00.000Z"), billingPeriodId: "period-old", currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"), nextReconcileAt: new Date("2026-09-12T12:00:00.000Z") });
    const transition = vi.spyOn(ShopifyPlanChangeTransitionService.prototype, "transition").mockResolvedValue({ kind: "not-applicable" });

    const result = await test.service.reconcileOnce();

    expect(result.subscriptionErrors).toBe(0);
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SYNC_ERROR", lastSyncErrorCode: "UNEXPECTED_IMMEDIATE_PLAN_CHANGE" }) }));
    expect(test.purchases.reconcileProviderConfirmed).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledOnce();
    transition.mockRestore();
  });
  it("B008-R1 updates the durable projection when Shopify changes plans", async () => {
    const test = harness();
    test.partner.getActiveSubscription
      .mockResolvedValueOnce({ ...providerSubscription, planHandle: "plan-a" })
      .mockResolvedValueOnce({ ...providerSubscription, planHandle: "plan-b" });
    test.database.billingPlan.findUnique.mockResolvedValue({
      id: "plan-1", active: true, kind: "PAID_METERED", shopifyUsageEventHandle: "recovery-meter",
    });

    const result = await test.service.reconcileOnce();
    expect(result.subscriptionErrors).toBe(0);
    await test.service.reconcileOnce();

    expect(test.database.subscription.upsert).toHaveBeenLastCalledWith(expect.objectContaining({
      update: expect.objectContaining({ observedShopifyPlanHandle: "plan-b" }),
    }));
  });

  it("B008-R2 maps an unknown plan after Admin registration without a restart", async () => {
    const test = harness({
      plan: null,
      partnerResult: {
        ...providerSubscription,
        planHandle: "future-plan",
        pendingPlanHandle: null,
        pendingEffectiveAt: null,
      },
    });
    test.database.billingPlan.findUnique.mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "plan-new", active: true, kind: "PAID_METERED", shopifyUsageEventHandle: "recovery-meter" });

    await test.service.reconcileOnce();
    await test.service.reconcileOnce();

    expect(test.database.subscription.upsert).toHaveBeenLastCalledWith(expect.objectContaining({
      update: expect.objectContaining({ status: "ACTIVE", planId: "plan-new" }),
    }));
  });

  it("B008-R3 projects a genuine no-contract response without downgrading to Free", async () => {
    const test = harness({ partnerResult: null });

    const result = await test.service.reconcileOnce();
    expect(result.subscriptionErrors).toBe(0);

    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ nextReconcileAt: expect.any(Date) }),
    }));
    expect(test.database.subscription.upsert).not.toHaveBeenCalled();
  });

  it("B008-R4 persists pending plan and effective boundary without changing current entitlement", async () => {
    const test = harness();

    await test.service.reconcileOnce();

    expect(test.database.subscription.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        planId: "plan-1",
        pendingShopifyPlanHandle: "pro-2027",
        pendingPlanId: "plan-2",
        pendingEffectiveAt: providerSubscription.pendingEffectiveAt,
      }),
    }));
  });

  it.each([false, true])("does not consume an unresolved initial activation when rotation sees it current with onboardingCompleted=%s", async (onboardingCompleted) => {
    const test = harness({
      partnerResult: { ...providerSubscription, planHandle: "free-2026", pendingPlanHandle: null, pendingEffectiveAt: null },
      plan: { id: "plan-free", active: true, kind: "FREE", shopifyUsageEventHandle: null, shopifyRecoveryCreditPackEventHandle: null },
    });
    test.database.shopSettings.findUnique.mockResolvedValue({ onboardingCompleted });
    test.database.subscription.findUnique.mockResolvedValue({
      status: "NO_CONTRACT",
      planId: null,
      pendingPlanId: "plan-free",
      pendingShopifyPlanHandle: "free-2026",
    });

    await test.service.reconcileOnce();

    expect(test.database.subscription.upsert).not.toHaveBeenCalled();
    expect(test.database.billingPeriod.upsert).not.toHaveBeenCalled();
    expect(test.database.shopSettings.findUnique).not.toHaveBeenCalled();
  });

  it.each([false, true])("uses canonical paid activation for a pending initial target during rotation with onboardingCompleted=%s", async (onboardingCompleted) => {
    const test = harness({
      partnerResult: { ...providerSubscription, planHandle: "paid-2026", pendingPlanHandle: null, pendingEffectiveAt: null },
      plan: {
        id: "plan-paid",
        active: true,
        name: "Paid",
        kind: "PAID_METERED",
        shopifyPlanHandle: "paid-2026",
        shopifyUsageEventHandle: "recovery-meter",
        shopifyRecoveryCreditPackEventHandle: null,
        recoveryCreditPackEnabled: false,
        includedRecoveryConversationAllowance: 100,
      },
      queue: { add: vi.fn().mockResolvedValue({}) },
    });
    test.database.subscription.findUnique.mockResolvedValue({
      id: "subscription-1",
      status: "NO_CONTRACT",
      planId: null,
      pendingPlanId: "plan-paid",
      pendingShopifyPlanHandle: "paid-2026",
      pendingEffectiveAt: new Date("2026-09-12T11:00:00.000Z"),
      nextReconcileAt: new Date("2026-09-12T12:00:00.000Z"),
      billingPeriodId: null,
    });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      shopSettings: { findUnique: vi.fn().mockResolvedValue({ onboardingCompleted }), update: vi.fn() },
      subscription: { findUnique: vi.fn().mockResolvedValue({ status: "NO_CONTRACT", planId: null, pendingPlanId: "plan-paid", pendingShopifyPlanHandle: "paid-2026", pendingEffectiveAt: new Date("2026-09-12T11:00:00.000Z"), nextReconcileAt: new Date("2026-09-12T12:00:00.000Z") }), update: vi.fn() },
      billingPlan: { findUnique: vi.fn().mockResolvedValue({ id: "plan-paid", active: true, name: "Paid", kind: "PAID_METERED", shopifyPlanHandle: "paid-2026", shopifyUsageEventHandle: "recovery-meter", includedRecoveryConversationAllowance: 100 }) },
      billingPeriod: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "period-paid" }) },
      billingPeriodEntitlementCounter: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
      shopEntitlementCounter: { findUnique: vi.fn().mockResolvedValue({ id: "lifetime-1" }), create: vi.fn() },
      platformBillingPolicy: { findUnique: vi.fn() },
    };
    test.database.$transaction.mockImplementation(async (callback: (value: typeof transaction) => unknown) => callback(transaction));

    await test.service.reconcileOnce();

    expect(test.database.billingPeriod.upsert).not.toHaveBeenCalled();
    expect(transaction.billingPeriod.create).toHaveBeenCalledOnce();
    expect(transaction.billingPeriodEntitlementCounter.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ grantedQuantity: 100 }),
    }));
    expect(transaction.shopSettings.update).toHaveBeenCalledWith({ where: { shopId: "shop-1" }, data: { onboardingCompleted: true } });
    expect(test.database.shopSettings.findUnique).not.toHaveBeenCalled();
  });

  it.each([false, true])("leaves a same-local-plan handle drift pending during rotation with onboardingCompleted=%s", async (onboardingCompleted) => {
    const test = harness({
      partnerResult: { ...providerSubscription, planHandle: "paid-new", pendingPlanHandle: null, pendingEffectiveAt: null },
      plan: {
        id: "plan-paid",
        active: true,
        name: "Paid",
        kind: "PAID_METERED",
        shopifyPlanHandle: "paid-new",
        shopifyUsageEventHandle: "recovery-meter",
        shopifyRecoveryCreditPackEventHandle: null,
        recoveryCreditPackEnabled: false,
        includedRecoveryConversationAllowance: 100,
      },
    });
    test.database.shopSettings.findUnique.mockResolvedValue({ onboardingCompleted });
    test.database.subscription.findUnique.mockResolvedValue({
      id: "subscription-1",
      status: "NO_CONTRACT",
      planId: null,
      pendingPlanId: "plan-paid",
      pendingShopifyPlanHandle: "paid-old",
      pendingEffectiveAt: new Date("2026-09-12T11:00:00.000Z"),
      nextReconcileAt: null,
      billingPeriodId: null,
    });

    await expect(test.service.reconcileOnce()).resolves.toMatchObject({ subscriptionErrors: 0 });

    expect(test.database.billingPeriod.upsert).not.toHaveBeenCalled();
    expect(test.database.subscription.upsert).not.toHaveBeenCalled();
    expect(test.database.subscription.updateMany).not.toHaveBeenCalled();
    expect(test.database.shopSettings.findUnique).not.toHaveBeenCalled();
  });

  it("re-observes an unsupported paid trial with a null schedule and later activates its exact cycle", async () => {
    const queue = { add: vi.fn().mockResolvedValue({}) };
    const test = harness({
      queue,
      partnerResult: { ...providerSubscription, planHandle: "paid-2026", pendingPlanHandle: null, pendingEffectiveAt: null, status: "TRIALING", trialEndsAt: new Date("2026-09-20T00:00:00.000Z"), currentPeriodStart: null, currentPeriodEnd: null },
      plan: { id: "plan-paid", active: true, name: "Paid", kind: "PAID_METERED", shopifyPlanHandle: "paid-2026", shopifyUsageEventHandle: "recovery-meter", shopifyRecoveryCreditPackEventHandle: null, recoveryCreditPackEnabled: false, includedRecoveryConversationAllowance: 100 },
    });
    test.database.shopSettings.findUnique.mockResolvedValue({ onboardingCompleted: false });
    test.database.subscription.findUnique.mockResolvedValue({ id: "subscription-1", status: "NO_CONTRACT", planId: null, pendingPlanId: "plan-paid", pendingShopifyPlanHandle: "paid-2026", pendingEffectiveAt: new Date("2026-09-12T11:00:00.000Z"), nextReconcileAt: new Date("2026-09-12T12:00:00.000Z"), billingPeriodId: null });
    test.database.billingPlan.findUnique.mockReset().mockResolvedValue({ id: "plan-paid", active: true, name: "Paid", kind: "PAID_METERED", shopifyPlanHandle: "paid-2026", shopifyUsageEventHandle: "recovery-meter", shopifyRecoveryCreditPackEventHandle: null, recoveryCreditPackEnabled: false, includedRecoveryConversationAllowance: 100 });
    const current = { status: "NO_CONTRACT", planId: null, pendingPlanId: "plan-paid", pendingShopifyPlanHandle: "paid-2026", pendingEffectiveAt: new Date("2026-09-12T11:00:00.000Z"), nextReconcileAt: null };
    test.database.subscription.updateMany.mockResolvedValue({ count: 1 });
    await test.service.reconcileOnce();
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastSyncErrorCode: "UNSUPPORTED_PAID_TRIAL", nextReconcileAt: null }) }));

    test.partner.getActiveSubscription.mockResolvedValue({ ...providerSubscription, planHandle: "paid-2026", pendingPlanHandle: null, pendingEffectiveAt: null });
    test.database.subscription.findUnique.mockResolvedValue({ ...current, nextReconcileAt: null });
    test.database.$transaction.mockImplementation(async (callback: (value: typeof activationTransaction) => unknown) => callback(activationTransaction));
    const activationTransaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      shopSettings: { findUnique: vi.fn().mockResolvedValue({ onboardingCompleted: false }), update: vi.fn() },
      subscription: { findUnique: vi.fn().mockResolvedValue({ ...current, nextReconcileAt: null }), update: vi.fn() },
      billingPlan: { findUnique: vi.fn().mockResolvedValue({ id: "plan-paid", active: true, name: "Paid", kind: "PAID_METERED", shopifyPlanHandle: "paid-2026", shopifyUsageEventHandle: "recovery-meter", includedRecoveryConversationAllowance: 100 }) },
      billingPeriod: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "period-paid" }) },
      billingPeriodEntitlementCounter: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
      shopEntitlementCounter: { findUnique: vi.fn().mockResolvedValue({ id: "lifetime-1" }), create: vi.fn() },
      platformBillingPolicy: { findUnique: vi.fn() },
    };

    await expect(test.service.reconcileOnce()).resolves.toMatchObject({ subscriptionErrors: 0 });
    expect(activationTransaction.billingPeriod.create).toHaveBeenCalledOnce();
    expect(activationTransaction.shopSettings.update).toHaveBeenCalledWith({ where: { shopId: "shop-1" }, data: { onboardingCompleted: true } });
  });

  it("B008-R5 links the latest open billing cycle as current", async () => {
    const test = harness();
    test.partner.getActiveSubscription
      .mockResolvedValueOnce(providerSubscription)
      .mockResolvedValueOnce({
        ...providerSubscription,
        currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z"),
      });
    test.database.billingPeriod.upsert
      .mockResolvedValueOnce({ id: "period-old" })
      .mockResolvedValueOnce({ id: "period-new" });

    await test.service.reconcileOnce();
    await test.service.reconcileOnce();

    expect(test.database.subscription.upsert).toHaveBeenLastCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        billingPeriodId: "period-new",
        currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z"),
      }),
    }));
  });

  it("rejects an out-of-range active-shop batch before scanning", async () => {
    const test = harness({
      plan: null,
      partnerResult: { ...providerSubscription, planHandle: "unknown-plan" },
    });

    await expect(test.service.reconcileOnce(999)).rejects.toThrow(
      "Billing reconciliation shop batch size is outside the database range.",
    );
    expect(test.database.shop.findMany).not.toHaveBeenCalled();
  });

  it("preserves the mapped plan when the Partner API fails", async () => {
    const test = harness({ partnerError: new Error("Partner unavailable") });

    const result = await test.service.reconcileOnce();

    expect(result).toMatchObject({ subscriptionsScanned: 1, subscriptionsSynced: 0, subscriptionErrors: 1 });
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        lastSyncErrorCode: "PARTNER_API_ERROR",
      }),
    }));
    expect(test.database.subscription.updateMany.mock.calls[0]?.[0].data).not.toHaveProperty("planId");
  });

  it("B008-R7 reports a current-cycle usage discrepancy without creating a correction", async () => {
    const test = harness();

    const result = await test.service.reconcileOnce();

    expect(result.discrepancies).toEqual([{
      shopId: "shop-1",
      billingPeriodId: "period-1",
      meterHandle: "recovery-meter",
      modaQuantity: 5,
      shopifyQuantity: 7,
    }]);
    expect(test.logger.warn).toHaveBeenCalledWith(
      "billing.usage_reconciliation.discrepancy",
      expect.objectContaining({ modaQuantity: 5, shopifyQuantity: 7 }),
    );
    expect(test.database.usageEvent).not.toHaveProperty("create");
  });

  it("B008-R6 activates packs only through provider-confirmed current-cycle reconciliation", async () => {
    const test = harness();

    const result = await test.service.reconcileOnce();

    expect(test.purchases.reconcileProviderConfirmed).toHaveBeenCalledWith({
      shopId: "shop-1",
      billingPeriodId: "period-1",
      providerPlanHandle: "pro-2026",
      packMeterHandle: "pack-meter",
      providerContextIdentity: "sub-1",
      providerUnits: Number.NaN,
      providerCostAmount: null,
      providerCostCurrency: null,
      providerUsageSnapshot: providerSubscription.providerUsageSnapshot,
      currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
    });
    expect(result.purchasesActivated).toBe(1);
  });

  it("surfaces an invalid scope when a present subscription has no current cycle", async () => {
    const test = harness({
      partnerResult: {
        ...providerSubscription,
        currentPeriodStart: null,
        currentPeriodEnd: null,
      },
    });

    const result = await test.service.reconcileOnce();

    expect(test.purchases.reconcileProviderConfirmed).not.toHaveBeenCalled();
    expect(result.purchasesActivated).toBe(0);
    expect(result.discrepancies).toContainEqual(expect.objectContaining({
      shopId: "shop-1",
      kind: "invalid-scope",
      detail: "Present Partner subscription has no exact current billing cycle",
    }));
  });

  it("reconciles durable purchases without the retired singular pack configuration", async () => {
    const test = harness({
      plan: {
        id: "plan-1",
        active: true,
        kind: "PAID_METERED",
        shopifyUsageEventHandle: "recovery-meter",
        shopifyRecoveryCreditPackEventHandle: null,
        recoveryCreditPackEnabled: false,
      },
      partnerResult: {
        ...providerSubscription,
        providerUsageSnapshot: [{
          handle: "pack-meter",
          quantity: "3",
          costAmount: "20.00",
          costCurrency: "USD",
        }],
      },
    });

    await expect(test.service.reconcileOnce()).resolves.toMatchObject({
      subscriptionErrors: 0,
      purchasesActivated: 1,
    });

    expect(test.purchases.reconcileProviderConfirmed).toHaveBeenCalledWith(expect.objectContaining({
      packMeterHandle: "",
      providerUnits: Number.NaN,
      providerCostAmount: null,
      providerCostCurrency: null,
      providerUsageSnapshot: [{
        handle: "pack-meter",
        quantity: "3",
        costAmount: "20.00",
        costCurrency: "USD",
      }],
    }));
  });

  it("persists rotating provider-cycle lag and enqueues the existing +60 second job", async () => {
    const boundary = new Date("2026-10-01T00:00:00.000Z");
    const retryNow = new Date("2026-10-01T00:00:01.000Z");
    const queue = { add: vi.fn().mockResolvedValue({}) };
    const test = harness({
      nowValue: () => retryNow,
      queue,
      plan: {
        id: "plan-1",
        active: true,
        name: "Pro",
        kind: "PAID_METERED",
        shopifyPlanHandle: "pro-2026",
        recoveryCreditPackEnabled: true,
        shopifyUsageEventHandle: "recovery-meter",
        shopifyRecoveryCreditPackEventHandle: "pack-meter",
        includedRecoveryConversationAllowance: 100,
      },
      partnerResult: {
        ...providerSubscription,
        currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
        currentPeriodEnd: boundary,
      },
    });
    test.database.subscription.findUnique.mockResolvedValue({
      id: "subscription-1",
      status: "ACTIVE",
      planId: "plan-1",
      billingPeriodId: "period-old",
      currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
      currentPeriodEnd: boundary,
      nextReconcileAt: boundary,
      pendingShopifyPlanHandle: null,
      pendingPlanId: null,
      pendingEffectiveAt: null,
    });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      subscription: {
        findUnique: vi.fn().mockResolvedValue({
          id: "subscription-1",
          shopId: "shop-1",
          planId: "plan-1",
          status: "ACTIVE",
          billingPeriodId: "period-old",
          currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
          currentPeriodEnd: boundary,
          nextReconcileAt: boundary,
          billingPeriod: { id: "period-old", periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: boundary, status: "OPEN" },
        }),
      },
      billingPeriod: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn(), updateMany: vi.fn() },
      usageEvent: { updateMany: vi.fn() },
      usageReservation: { aggregate: vi.fn() },
      billingPeriodEntitlementCounter: { findUnique: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() },
    };
    test.database.$transaction.mockImplementation(async (callback: (value: typeof transaction) => unknown) => callback(transaction));

    await test.service.reconcileOnce();

    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "subscription-1",
        planId: "plan-1",
        billingPeriodId: "period-old",
        currentPeriodEnd: boundary,
        nextReconcileAt: boundary,
      }),
      data: expect.objectContaining({
        nextReconcileAt: new Date("2026-10-01T00:01:01.000Z"),
        lastSyncErrorCode: "PROVIDER_CYCLE_LAG",
      }),
    }));
    expect(queue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ expectedNextReconcileAt: "2026-10-01T00:01:01.000Z" }),
      expect.objectContaining({ jobId: expect.any(String), delay: 60_000 }),
    );
  });

  it("repairs a missing Paid cycle schedule during rotating provider-cycle lag", async () => {
    const boundary = new Date("2026-10-01T00:00:00.000Z");
    const retryNow = new Date("2026-10-01T00:00:01.000Z");
    const queue = { add: vi.fn().mockResolvedValue({}) };
    const test = harness({
      nowValue: () => retryNow,
      queue,
      plan: {
        id: "plan-1",
        active: true,
        name: "Pro",
        kind: "PAID_METERED",
        shopifyPlanHandle: "pro-2026",
        recoveryCreditPackEnabled: true,
        shopifyUsageEventHandle: "recovery-meter",
        shopifyRecoveryCreditPackEventHandle: "pack-meter",
        includedRecoveryConversationAllowance: 100,
      },
      partnerResult: {
        ...providerSubscription,
        currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
        currentPeriodEnd: boundary,
      },
    });
    test.database.subscription.findUnique.mockResolvedValue({
      id: "subscription-1",
      status: "ACTIVE",
      planId: "plan-1",
      billingPeriodId: "period-old",
      currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
      currentPeriodEnd: boundary,
      nextReconcileAt: null,
      pendingShopifyPlanHandle: null,
      pendingPlanId: null,
      pendingEffectiveAt: null,
    });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      subscription: {
        findUnique: vi.fn().mockResolvedValue({
          id: "subscription-1",
          shopId: "shop-1",
          planId: "plan-1",
          status: "ACTIVE",
          billingPeriodId: "period-old",
          currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
          currentPeriodEnd: boundary,
          nextReconcileAt: boundary,
          billingPeriod: { id: "period-old", periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: boundary, status: "OPEN" },
        }),
      },
      billingPeriod: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn(), updateMany: vi.fn() },
      usageEvent: { updateMany: vi.fn() },
      usageReservation: { aggregate: vi.fn() },
      billingPeriodEntitlementCounter: { findUnique: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() },
    };
    test.database.$transaction.mockImplementation(async (callback: (value: typeof transaction) => unknown) => callback(transaction));

    await test.service.reconcileOnce();

    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "subscription-1",
        billingPeriodId: "period-old",
        nextReconcileAt: null,
      }),
      data: expect.objectContaining({
        nextReconcileAt: new Date("2026-10-01T00:01:01.000Z"),
        lastSyncErrorCode: "PROVIDER_CYCLE_LAG",
      }),
    }));
    expect(queue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ expectedNextReconcileAt: "2026-10-01T00:01:01.000Z" }),
      expect.objectContaining({ jobId: expect.any(String), delay: 60_000 }),
    );
  });

  it("repairs a missing pack-enabled Free cycle schedule during rotating provider-cycle lag", async () => {
    const boundary = new Date("2026-10-01T00:00:00.000Z");
    const retryNow = new Date("2026-10-01T00:00:01.000Z");
    const queue = { add: vi.fn().mockResolvedValue({}) };
    const test = harness({
      nowValue: () => retryNow,
      queue,
      plan: {
        id: "plan-1",
        active: true,
        name: "Free",
        kind: "FREE",
        shopifyPlanHandle: "pro-2026",
        recoveryCreditPackEnabled: true,
        shopifyUsageEventHandle: null,
        shopifyRecoveryCreditPackEventHandle: "pack-meter",
        includedRecoveryConversationAllowance: null,
      },
      partnerResult: {
        ...providerSubscription,
        usageEventHandles: ["recovery-meter", "pack-meter"],
        currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
        currentPeriodEnd: boundary,
      },
    });
    test.database.subscription.findUnique.mockResolvedValue({
      id: "subscription-1",
      status: "ACTIVE",
      planId: "plan-1",
      billingPeriodId: "period-old",
      currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
      currentPeriodEnd: boundary,
      nextReconcileAt: null,
      pendingShopifyPlanHandle: null,
      pendingPlanId: null,
      pendingEffectiveAt: null,
    });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      subscription: {
        findUnique: vi.fn().mockResolvedValue({
          id: "subscription-1",
          shopId: "shop-1",
          planId: "plan-1",
          status: "ACTIVE",
          billingPeriodId: "period-old",
          currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
          currentPeriodEnd: boundary,
          nextReconcileAt: boundary,
          billingPeriod: { id: "period-old", periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: boundary, status: "OPEN" },
        }),
      },
      billingPeriod: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn(), updateMany: vi.fn() },
      usageEvent: { updateMany: vi.fn() },
      usageReservation: { aggregate: vi.fn() },
      billingPeriodEntitlementCounter: { findUnique: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() },
    };
    test.database.$transaction.mockImplementation(async (callback: (value: typeof transaction) => unknown) => callback(transaction));

    await test.service.reconcileOnce();

    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "subscription-1",
        billingPeriodId: "period-old",
        nextReconcileAt: null,
      }),
      data: expect.objectContaining({
        nextReconcileAt: new Date("2026-10-01T00:01:01.000Z"),
        lastSyncErrorCode: "PROVIDER_CYCLE_LAG",
      }),
    }));
    expect(queue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ expectedNextReconcileAt: "2026-10-01T00:01:01.000Z" }),
      expect.objectContaining({ jobId: expect.any(String), delay: 60_000 }),
    );
  });

  it("lets the canonical rollover return its successor without using the legacy period upsert", async () => {
    const test = harness({ partnerResult: { ...providerSubscription, pendingPlanHandle: null, pendingEffectiveAt: null } });
    const existing = {
      id: "subscription-1", status: "ACTIVE", planId: "plan-1", billingPeriodId: "period-old",
      currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
      pendingPlanId: null, pendingShopifyPlanHandle: null, pendingEffectiveAt: null,
    };
    test.database.subscription.findUnique.mockResolvedValue(existing);
    const transition = vi.spyOn(SamePlanBillingPeriodRolloverService.prototype, "transition").mockResolvedValue({
      kind: "transitioned", billingPeriodId: "period-successor", nextReconcileAt: null, planKind: "PAID_METERED",
    });

    const result = await test.service.reconcileOnce();

    expect(transition).toHaveBeenCalledOnce();
    expect(test.database.billingPeriod.upsert).not.toHaveBeenCalled();
    expect(result.discrepancies).toEqual([]);
    transition.mockRestore();
  });

  it("keeps a canonical fail-closed rollover result from creating a later period", async () => {
    const test = harness({ partnerResult: { ...providerSubscription, pendingPlanHandle: null, pendingEffectiveAt: null } });
    test.database.subscription.findUnique.mockResolvedValue({
      id: "subscription-1", status: "ACTIVE", planId: "plan-1", billingPeriodId: "period-old",
      currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
      pendingPlanId: null, pendingShopifyPlanHandle: null, pendingEffectiveAt: null,
    });
    const transition = vi.spyOn(SamePlanBillingPeriodRolloverService.prototype, "transition").mockResolvedValue({ kind: "not-applicable" });

    await test.service.reconcileOnce();

    expect(transition).toHaveBeenCalledOnce();
    expect(test.database.billingPeriod.upsert).not.toHaveBeenCalled();
    transition.mockRestore();
  });

  it("does not queue a pack-disabled Free retry when the provider cycle lags", async () => {
    const queue = { add: vi.fn().mockResolvedValue({}) };
    const test = harness({
      queue,
      partnerResult: { ...providerSubscription, pendingPlanHandle: null, pendingEffectiveAt: null },
      plan: {
        id: "plan-free", active: true, name: "Free", kind: "FREE", shopifyPlanHandle: "pro-2026",
        recoveryCreditPackEnabled: false, shopifyUsageEventHandle: null, shopifyRecoveryCreditPackEventHandle: null,
        includedRecoveryConversationAllowance: null,
      },
    });
    test.database.subscription.findUnique.mockResolvedValue({
      id: "subscription-1", status: "ACTIVE", planId: "plan-free", billingPeriodId: "period-old",
      currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
      pendingPlanId: null, pendingShopifyPlanHandle: null, pendingEffectiveAt: null,
    });
    const transition = vi.spyOn(SamePlanBillingPeriodRolloverService.prototype, "transition").mockResolvedValue({
      kind: "provider-cycle-lag", billingPeriodId: "period-old", nextReconcileAt: new Date("2026-10-01T00:00:00.000Z"),
    });

    await test.service.reconcileOnce();

    expect(transition).toHaveBeenCalledOnce();
    expect(queue.add).not.toHaveBeenCalled();
    transition.mockRestore();
  });

  it("rotates active shops with a keyset cursor and continues after a Partner failure", async () => {
    const shops = ["A", "B", "C", "D"].map((id) => ({
      id,
      shopifyShopId: `gid://shopify/Shop/${id}`,
    }));
    const database = {
      shop: {
        findMany: vi.fn().mockImplementation(async ({ where, take }: { where: { id?: { gt: string } }; take: number }) =>
          shops.filter((shop) => !where.id?.gt || shop.id > where.id.gt).slice(0, take)),
      },
      billingPlan: { findUnique: vi.fn().mockResolvedValue(null) },
      billingPeriod: { upsert: vi.fn() },
      subscription: {
        upsert: vi.fn(),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      shopSettings: { findUnique: vi.fn().mockResolvedValue({ onboardingCompleted: true }) },
      usageEvent: { aggregate: vi.fn() },
    };
    const partner = {
      getActiveSubscription: vi.fn().mockImplementation(async (shopifyShopId: string) => {
        if (shopifyShopId.endsWith("/A")) throw new Error("temporary Partner failure");
        return null;
      }),
      getSubscriptionReconciliationSnapshot: vi.fn().mockImplementation(async (shopifyShopId: string) => ({
        activeSubscription: await partner.getActiveSubscription(shopifyShopId),
        latestLifecycleEvent: null,
      })),
    };
    const publisher = { publishDue: vi.fn().mockResolvedValue({}) };
    const purchases = { reconcileProviderConfirmed: vi.fn().mockResolvedValue({ activatedCount: 0, discrepancy: null }) };
    const logger = { warn: vi.fn(), error: vi.fn() };
    const service = new BillingReconciliationService(
      database as never,
      partner,
      publisher,
      purchases,
      logger as never,
    );

    await service.reconcileOnce(2);
    await service.reconcileOnce(2);
    await service.reconcileOnce(2);

    expect(partner.getSubscriptionReconciliationSnapshot.mock.calls.map(([shopifyShopId]) => shopifyShopId)).toEqual([
      "gid://shopify/Shop/A",
      "gid://shopify/Shop/B",
      "gid://shopify/Shop/C",
      "gid://shopify/Shop/D",
      "gid://shopify/Shop/A",
      "gid://shopify/Shop/B",
    ]);
  });
});