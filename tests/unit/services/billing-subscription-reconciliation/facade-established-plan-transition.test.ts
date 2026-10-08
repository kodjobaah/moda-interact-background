import { describe, expect, it, vi } from "vitest";
import { createSubscriptionReconcilePayload } from "../../../../src/services/billing-subscription-reconciliation.service.js";
import { ShopifyPlanChangeTransitionService } from "../../../../src/services/shopify-plan-change-transition.service.js";
import { recoveryCapacityResumeService } from "../../../../src/services/recovery-capacity-resume.service.js";
import { now, pendingEffectiveAt, harness, pendingRow, paidProvider, paidPlan, payload, establishedCurrentPlan, establishedTargetPlan, establishedProvider, establishedRow } from "./facade-test-fixtures.js";

describe("BillingSubscriptionReconciliationService", () => {
  it.each([
    "UNEXPECTED_IMMEDIATE_PLAN_CHANGE",
    "MISSING_BILLING_CYCLE",
    "MISSING_USAGE_METER",
    "INVALID_INCLUDED_ALLOWANCE",
  ] as const)("retries established plan changes from retryable SYNC_ERROR: %s", async (lastSyncErrorCode) => {
    const test = harness({ row: establishedRow({ subscription: { ...establishedRow().subscription, status: "SYNC_ERROR", lastSyncErrorCode } }), providerResult: establishedProvider, plan: establishedCurrentPlan });
    test.database.billingPlan.findUnique.mockResolvedValueOnce(establishedCurrentPlan).mockResolvedValueOnce(establishedTargetPlan);
    const transition = vi.spyOn(ShopifyPlanChangeTransitionService.prototype, "transition").mockResolvedValue({ kind: "transitioned", billingPeriodId: "period-new", nextReconcileAt: null, planKind: "PAID_METERED" });

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now));

    expect(transition).toHaveBeenCalledOnce();
    expect(test.partner.getActiveSubscription).toHaveBeenCalledOnce();
    transition.mockRestore();
  });

  it("does not execute an unrelated SYNC_ERROR as an established plan change", async () => {
    const test = harness({ row: establishedRow({ subscription: { ...establishedRow().subscription, status: "SYNC_ERROR", lastSyncErrorCode: "PARTNER_API_ERROR" } }), providerResult: establishedProvider, plan: establishedCurrentPlan });
    const transition = vi.spyOn(ShopifyPlanChangeTransitionService.prototype, "transition");

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now));

    expect(transition).not.toHaveBeenCalled();
    transition.mockRestore();
  });

  it.each([
    ["missing cycle", "MISSING_BILLING_CYCLE", { provider: { ...establishedProvider, currentPeriodStart: null, currentPeriodEnd: null }, plan: establishedTargetPlan }],
    ["invalid cycle", "MISSING_BILLING_CYCLE", { provider: { ...establishedProvider, currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z") }, plan: establishedTargetPlan }],
    ["null Paid allowance", "INVALID_INCLUDED_ALLOWANCE", { provider: establishedProvider, plan: { ...establishedTargetPlan, includedRecoveryConversationAllowance: null } }],
    ["negative Paid allowance", "INVALID_INCLUDED_ALLOWANCE", { provider: establishedProvider, plan: { ...establishedTargetPlan, includedRecoveryConversationAllowance: -1 } }],
    ["non-integer Paid allowance", "INVALID_INCLUDED_ALLOWANCE", { provider: establishedProvider, plan: { ...establishedTargetPlan, includedRecoveryConversationAllowance: 1.5 } }],
    ["unsafe Paid allowance", "INVALID_INCLUDED_ALLOWANCE", { provider: establishedProvider, plan: { ...establishedTargetPlan, includedRecoveryConversationAllowance: Number.MAX_SAFE_INTEGER + 1 } }],
    ["missing normal Paid meter config", "MISSING_USAGE_METER", { provider: establishedProvider, plan: { ...establishedTargetPlan, shopifyUsageEventHandle: null } }],
    ["provider omits normal Paid meter", "MISSING_USAGE_METER", { provider: { ...establishedProvider, usageEventHandles: [] }, plan: establishedTargetPlan }],
    ["enabled Paid pack meter null", "MISSING_USAGE_METER", { provider: establishedProvider, plan: { ...establishedTargetPlan, recoveryCreditPackEnabled: true, shopifyRecoveryCreditPackEventHandle: null } }],
    ["provider omits Paid pack meter", "MISSING_USAGE_METER", { provider: { ...establishedProvider, usageEventHandles: ["recovery-meter"] }, plan: { ...establishedTargetPlan, recoveryCreditPackEnabled: true, shopifyRecoveryCreditPackEventHandle: "pack-meter" } }],
    ["enabled Free pack meter null", "MISSING_USAGE_METER", { provider: { ...establishedProvider, planHandle: "paid-2026", usageEventHandles: ["pack-meter"] }, plan: { id: "plan-target", active: true, name: "Free target", kind: "FREE", shopifyPlanHandle: "paid-2026", shopifyUsageEventHandle: null, shopifyRecoveryCreditPackEventHandle: null, recoveryCreditPackEnabled: true, includedRecoveryConversationAllowance: null } }],
    ["provider omits Free pack meter", "MISSING_USAGE_METER", { provider: establishedProvider, plan: { id: "plan-target", active: true, name: "Free target", kind: "FREE", shopifyPlanHandle: "paid-2026", shopifyUsageEventHandle: null, shopifyRecoveryCreditPackEventHandle: "pack-meter", recoveryCreditPackEnabled: true, includedRecoveryConversationAllowance: null } }],
  ] as const)("fails established queued plan change closed for invalid target prerequisite: %s", async (_label, expectedCode, input) => {
    const test = harness({ row: establishedRow(), providerResult: input.provider, plan: establishedCurrentPlan });
    test.database.billingPlan.findUnique.mockResolvedValueOnce(establishedCurrentPlan).mockResolvedValueOnce(input.plan);
    const transition = vi.spyOn(ShopifyPlanChangeTransitionService.prototype, "transition");

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now));

    const call = test.database.subscription.updateMany.mock.calls.at(-1)?.[0];
    expect(call.data).toEqual(expect.objectContaining({ status: "SYNC_ERROR", lastSyncErrorCode: expectedCode, nextReconcileAt: new Date("2026-09-12T12:01:00.000Z") }));
    for (const field of ["planId", "billingPeriodId", "currentPeriodStart", "currentPeriodEnd", "pendingPlanId", "pendingShopifyPlanHandle", "pendingEffectiveAt"]) expect(call.data).not.toHaveProperty(field);
    expect(transition).not.toHaveBeenCalled();
    expect(test.queue.add).toHaveBeenCalledOnce();
    transition.mockRestore();
  });

  it("schedules plan-change capacity resume after a successful queued Paid transition", async () => {
    const test = harness({ row: establishedRow(), providerResult: establishedProvider, plan: establishedCurrentPlan });
    test.database.billingPlan.findUnique.mockResolvedValueOnce(establishedCurrentPlan).mockResolvedValueOnce(establishedTargetPlan);
    const transition = vi.spyOn(ShopifyPlanChangeTransitionService.prototype, "transition").mockResolvedValue({ kind: "transitioned", billingPeriodId: "period-new", nextReconcileAt: null, planKind: "PAID_METERED" });
    const resume = vi.spyOn(recoveryCapacityResumeService, "schedule").mockResolvedValue(undefined);

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now));

    expect(resume).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledWith({ shopId: "shop-1", trigger: "plan-change" });
    transition.mockRestore();
    resume.mockRestore();
  });

  it("swallows queued plan-change capacity-resume enqueue failure after transition", async () => {
    const test = harness({ row: establishedRow(), providerResult: establishedProvider, plan: establishedCurrentPlan });
    test.database.billingPlan.findUnique.mockResolvedValueOnce(establishedCurrentPlan).mockResolvedValueOnce(establishedTargetPlan);
    const transition = vi.spyOn(ShopifyPlanChangeTransitionService.prototype, "transition").mockResolvedValue({ kind: "transitioned", billingPeriodId: "period-new", nextReconcileAt: null, planKind: "PAID_METERED" });
    const resume = vi.spyOn(recoveryCapacityResumeService, "schedule").mockRejectedValue(new Error("Redis unavailable"));

    await expect(test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now))).resolves.toBeUndefined();

    expect(test.logger.warn).toHaveBeenCalledWith("billing.recovery_capacity_resume.enqueue_failed", expect.objectContaining({ shopId: "shop-1" }));
    expect(
      test.database.subscription.updateMany.mock.calls.some(([call]: any[]) =>
        call.data?.status === "SYNC_ERROR"
        || call.data?.lastSyncErrorCode != null
        || call.data?.nextReconcileAt?.getTime?.() === new Date("2026-09-12T12:01:00.000Z").getTime(),
      ),
    ).toBe(false);
    transition.mockRestore();
    resume.mockRestore();
  });

  it("fails closed before the pending boundary when the provider target uses the current cycle", async () => {
    const transition = vi.spyOn(ShopifyPlanChangeTransitionService.prototype, "transition");
    const currentStart = new Date("2026-09-01T00:00:00.000Z");
    const currentEnd = new Date("2026-10-01T00:00:00.000Z");
    const test = harness({
      row: pendingRow({
        onboardingCompleted: true,
        subscription: {
          id: "subscription-1",
          status: "ACTIVE",
          planId: "plan-old",
          pendingPlanId: "plan-paid",
          pendingShopifyPlanHandle: "paid-2026",
          pendingEffectiveAt: new Date("2026-09-20T00:00:00.000Z"),
          nextReconcileAt: now,
          billingPeriodId: "period-old",
          currentPeriodStart: currentStart,
          currentPeriodEnd: currentEnd,
        },
      }),
      providerResult: { ...paidProvider, planHandle: "paid-2026", currentPeriodStart: currentStart, currentPeriodEnd: currentEnd },
      plan: { ...paidPlan, id: "plan-old", shopifyPlanHandle: "old-2026" },
    });
    test.database.billingPlan.findUnique
      .mockResolvedValueOnce({ id: "plan-old", active: true, name: "Old", kind: "PAID_METERED", shopifyPlanHandle: "old-2026", shopifyUsageEventHandle: "old-meter", recoveryCreditPackEnabled: false, shopifyRecoveryCreditPackEventHandle: null, includedRecoveryConversationAllowance: 50 })
      .mockResolvedValueOnce(paidPlan);

    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: now.toISOString() });

    expect(transition).not.toHaveBeenCalled();
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "SYNC_ERROR", lastSyncErrorCode: "UNEXPECTED_IMMEDIATE_PLAN_CHANGE", nextReconcileAt: new Date("2026-09-12T12:01:00.000Z") }),
    }));
    expect(test.queue.add).toHaveBeenCalledOnce();
    transition.mockRestore();
  });
});
