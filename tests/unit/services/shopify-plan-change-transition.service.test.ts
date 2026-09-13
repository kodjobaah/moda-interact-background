import { describe, expect, it, vi } from "vitest";

import { ShopifyPlanChangeTransitionService } from "../../../src/services/shopify-plan-change-transition.service.js";

const oldStart = new Date("2026-09-01T00:00:00.000Z");
const oldEnd = new Date("2026-10-01T00:00:00.000Z");
const newStart = oldEnd;
const newEnd = new Date("2026-11-01T00:00:00.000Z");
const paidPlan = { id: "paid-new", active: true, name: "Paid New", kind: "PAID_METERED" as const, shopifyPlanHandle: "paid-new", shopifyUsageEventHandle: "recovery-new", shopifyRecoveryCreditPackEventHandle: null, recoveryCreditPackEnabled: false, includedRecoveryConversationAllowance: 100 };
const freePlan = { id: "free-new", active: true, name: "Free New", kind: "FREE" as const, shopifyPlanHandle: "free-new", shopifyUsageEventHandle: null, shopifyRecoveryCreditPackEventHandle: null, recoveryCreditPackEnabled: false, includedRecoveryConversationAllowance: null };
const provider = { planHandle: "paid-new", usageEventHandles: ["recovery-new"], pendingPlanHandle: null, pendingEffectiveAt: null, status: "ACTIVE" as const, currentPeriodStart: newStart, currentPeriodEnd: newEnd, trialEndsAt: null, cancelAtPeriodEnd: false, providerSubscriptionId: "provider-new", providerUsageSnapshot: [] };

function harness(planKind: "PAID_METERED" | "FREE" = "PAID_METERED", successor: unknown = null, outgoingPeriod: unknown = undefined) {
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    subscription: { findUnique: vi.fn().mockResolvedValue({ id: "subscription-1", shopId: "shop-1", planId: "paid-old", status: "ACTIVE", billingPeriodId: outgoingPeriod === null ? null : "period-old", currentPeriodStart: outgoingPeriod === null ? null : oldStart, currentPeriodEnd: outgoingPeriod === null ? null : oldEnd, plan: { kind: planKind }, billingPeriod: outgoingPeriod === undefined ? { id: "period-old", periodStart: oldStart, periodEnd: oldEnd, status: "OPEN", planKindSnapshot: planKind } : outgoingPeriod }), update: vi.fn() },
    billingPeriod: { findUnique: vi.fn().mockResolvedValue(successor), create: vi.fn().mockResolvedValue({ id: "period-new" }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    usageEvent: { updateMany: vi.fn() },
    usageReservation: { aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: 10 } }), updateMany: vi.fn() },
    billingPeriodEntitlementCounter: { findUnique: vi.fn().mockResolvedValue({ id: "counter-old", grantedQuantity: 100, committedQuantity: 20, reservedQuantity: 10, forfeitedQuantity: 0, version: 1 }), updateMany: vi.fn().mockResolvedValue({ count: 1 }), upsert: vi.fn() },
  };
  const database = { $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)) };
  return { transaction, service: new ShopifyPlanChangeTransitionService(database as never) };
}

describe("ShopifyPlanChangeTransitionService", () => {
  it("closes Paid -> Paid with PLAN_CHANGED and grants the new period once", async () => {
    const test = harness();
    const result = await test.service.transition({ shopId: "shop-1", subscriptionId: "subscription-1", provider, plan: paidPlan, expectedCurrentPlanId: "paid-old", now: new Date("2026-10-01T00:00:01.000Z") });
    expect(result).toMatchObject({ kind: "transitioned", billingPeriodId: "period-new", planKind: "PAID_METERED" });
    expect(test.transaction.usageReservation.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "RELEASED", releaseReason: "PERIOD_CLOSED" } }));
    expect(test.transaction.billingPeriodEntitlementCounter.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ forfeitedQuantity: { increment: 80 } }) }));
    expect(test.transaction.billingPeriod.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "CLOSED", closedAt: oldEnd, closeReason: "PLAN_CHANGED" } }));
    expect(test.transaction.billingPeriodEntitlementCounter.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ grantedQuantity: 100, committedQuantity: 0, reservedQuantity: 0, forfeitedQuantity: 0 }) }));
  });

  it("creates a Free successor without a monthly counter", async () => {
    const test = harness("PAID_METERED");
    const result = await test.service.transition({ shopId: "shop-1", subscriptionId: "subscription-1", provider: { ...provider, planHandle: "free-new", usageEventHandles: [] }, plan: freePlan, expectedCurrentPlanId: "paid-old", now: new Date("2026-10-01T00:00:01.000Z") });
    expect(result).toMatchObject({ kind: "transitioned", planKind: "FREE" });
    expect(test.transaction.billingPeriod.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ planKindSnapshot: "FREE", includedRecoveryCreditsGranted: null }) }));
    expect(test.transaction.billingPeriodEntitlementCounter.findUnique).toHaveBeenCalled();
    expect(test.transaction.billingPeriodEntitlementCounter.upsert).not.toHaveBeenCalled();
    expect(test.transaction.subscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ planId: "free-new", pendingPlanId: null }) }));
  });

  it("reuses a matching successor without resetting its included usage", async () => {
    const successor = { id: "period-new", subscriptionId: "subscription-1", planId: "paid-new", shopifyPlanHandleSnapshot: "paid-new", planNameSnapshot: "Paid New", planKindSnapshot: "PAID_METERED", includedRecoveryCreditsGranted: 100, status: "OPEN" };
    const test = harness("PAID_METERED", successor);
    test.transaction.billingPeriodEntitlementCounter.findUnique
      .mockResolvedValueOnce({ id: "counter-old", grantedQuantity: 100, committedQuantity: 20, reservedQuantity: 10, forfeitedQuantity: 0, version: 1 })
      .mockResolvedValueOnce({ id: "counter-new", grantedQuantity: 100, committedQuantity: 3, reservedQuantity: 1, forfeitedQuantity: 2, version: 4 });
    await test.service.transition({ shopId: "shop-1", subscriptionId: "subscription-1", provider, plan: paidPlan, expectedCurrentPlanId: "paid-old", now: new Date("2026-10-01T00:00:01.000Z") });
    expect(test.transaction.billingPeriod.create).not.toHaveBeenCalled();
    expect(test.transaction.billingPeriodEntitlementCounter.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
  });

  it("supports Free -> Paid without an outgoing Free billing period", async () => {
    const test = harness("FREE", null, null);
    const result = await test.service.transition({
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      provider,
      plan: paidPlan,
      expectedCurrentPlanId: "paid-old",
      now: new Date("2026-10-01T00:00:01.000Z"),
    });

    expect(result).toMatchObject({ kind: "transitioned", billingPeriodId: "period-new", planKind: "PAID_METERED" });
    expect(test.transaction.billingPeriod.updateMany).not.toHaveBeenCalled();
    expect(test.transaction.billingPeriod.create).toHaveBeenCalledOnce();
    expect(test.transaction.billingPeriodEntitlementCounter.upsert).toHaveBeenCalledOnce();
  });
});