import { describe, expect, it, vi } from "vitest";

import { ShopifySubscriptionLifecycleReconciliationService } from "../../../src/services/shopify-subscription-lifecycle-reconciliation.service.js";
import { SamePlanBillingPeriodRolloverService } from "../../../src/services/same-plan-billing-period-rollover.service.js";
import { ShopifyPlanChangeTransitionService } from "../../../src/services/shopify-plan-change-transition.service.js";

const now = new Date("2026-09-14T12:00:00.000Z");
const frozen = {
  id: "event-frozen",
  eventType: "SUBSCRIPTION_FROZEN" as const,
  state: "FROZEN" as const,
  occurredAt: new Date("2026-09-14T11:00:00.000Z"),
  cancelEffectiveOn: null,
  planHandle: "growth",
  billingPeriod: "2026-09-01/2026-10-01",
};

function transaction(subscription: Record<string, unknown>) {
  const mutators = () => ({
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  });
  return {
    $queryRaw: vi.fn(),
    subscription: {
      findUnique: vi.fn().mockResolvedValue(subscription),
      update: vi.fn().mockResolvedValue(subscription),
    },
    billingPlan: {
      findUnique: vi.fn().mockResolvedValue({
        id: "plan-1",
        active: true,
        name: "Growth",
        kind: "PAID_METERED",
        shopifyPlanHandle: "growth",
        includedRecoveryConversationAllowance: 100,
        recoveryCreditPackEnabled: false,
        shopifyUsageEventHandle: "recovery-meter",
        shopifyRecoveryCreditPackEventHandle: null,
      }),
    },
    billingPeriod: { ...mutators(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    usageEvent: { ...mutators(), updateMany: vi.fn() },
    billingPeriodEntitlementCounter: { ...mutators(), findUnique: vi.fn().mockResolvedValue(null) },
    shopEntitlementCounter: mutators(),
    recoveryCreditPurchase: mutators(),
    recoveryCreditRefund: mutators(),
    promotionalCreditGrant: mutators(),
    merchantPromotionSelection: mutators(),
    usageReservation: { ...mutators(), aggregate: vi.fn(), updateMany: vi.fn() },
  };
}

function expectNoModelMutations(model: Record<string, ReturnType<typeof vi.fn>>) {
  for (const method of ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]) {
    expect(model[method]).not.toHaveBeenCalled();
  }
}

describe("ShopifySubscriptionLifecycleReconciliationService", () => {
  it("projects FROZEN evidence and schedules one hourly retry", async () => {
    const tx = transaction({ lastProviderLifecycleEventAt: null, lastProviderLifecycleEventId: null });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    await new ShopifySubscriptionLifecycleReconciliationService(database).reconcile("shop-1", "sub-1", {
      activeSubscription: { planHandle: "growth", usageEventHandles: ["recovery-meter"], pendingPlanHandle: null, pendingEffectiveAt: null, status: "ACTIVE", currentPeriodStart: new Date("2026-09-01"), currentPeriodEnd: new Date("2026-10-01"), trialEndsAt: null, cancelAtEndOfCycle: false, providerSubscriptionId: "provider-1", providerUsageSnapshot: [] },
      latestLifecycleEvent: frozen,
    }, now);

    expect(tx.subscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FROZEN", nextReconcileAt: new Date("2026-09-14T13:00:00.000Z") }) }));
  });

  it("ignores strictly older lifecycle evidence without overwriting newer identity", async () => {
    const tx = transaction({ status: "ACTIVE", lastProviderLifecycleEventAt: new Date("2026-09-14T12:00:00.000Z"), lastProviderLifecycleEventId: "event-newer" });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    await new ShopifySubscriptionLifecycleReconciliationService(database).reconcile("shop-1", "sub-1", { activeSubscription: null, latestLifecycleEvent: frozen }, now);
    expect(tx.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        nextReconcileAt: new Date("2026-09-14T12:05:00.000Z"),
      }),
    }));
  });

  it("replays the same FROZEN event and advances one hourly retry", async () => {
    const tx = transaction({ status: "FROZEN", lastProviderLifecycleEventAt: frozen.occurredAt, lastProviderLifecycleEventId: frozen.id });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    await new ShopifySubscriptionLifecycleReconciliationService(database).reconcile("shop-1", "sub-1", { activeSubscription: null, latestLifecycleEvent: frozen }, now);
    expect(tx.subscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FROZEN", nextReconcileAt: new Date("2026-09-14T13:00:00.000Z") }) }));
  });

  it("keeps newer lifecycle identity when older unresolved evidence arrives", async () => {
    const tx = transaction({ status: "FROZEN", lastProviderLifecycleEventAt: new Date("2026-09-14T12:00:00.000Z"), lastProviderLifecycleEventId: "event-newer" });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    await new ShopifySubscriptionLifecycleReconciliationService(database).reconcile("shop-1", "sub-1", { activeSubscription: null, latestLifecycleEvent: { ...frozen, state: "UPDATED", eventType: "SUBSCRIPTION_UPDATED", id: "event-old" } }, now);
    expect(tx.subscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ nextReconcileAt: new Date("2026-09-14T13:00:00.000Z") }) }));
    expect(tx.subscription.update.mock.calls[0][0].data.lastProviderLifecycleEventId).toBeUndefined();
  });

  it("ignores stale FROZEN evidence and continues with live provider truth", async () => {
    const tx = transaction({ status: "ACTIVE", lastProviderLifecycleEventAt: new Date("2026-09-14T12:00:00.000Z"), lastProviderLifecycleEventId: "event-newer" });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    const result = await new ShopifySubscriptionLifecycleReconciliationService(database).reconcile("shop-1", "sub-1", {
      activeSubscription: { planHandle: "growth", usageEventHandles: ["recovery-meter"], pendingPlanHandle: null, pendingEffectiveAt: null, status: "ACTIVE", currentPeriodStart: new Date("2026-09-01"), currentPeriodEnd: new Date("2026-10-01"), trialEndsAt: null, cancelAtEndOfCycle: false, providerSubscriptionId: "provider-1", providerUsageSnapshot: [] },
      latestLifecycleEvent: frozen,
    }, now);
    expect(result).toBe("continue");
    expect(tx.subscription.update).not.toHaveBeenCalled();
  });

  it("keeps FROZEN and advances one hourly retry for stale UNFROZEN evidence", async () => {
    const tx = transaction({ status: "FROZEN", lastProviderLifecycleEventAt: new Date("2026-09-14T12:00:00.000Z"), lastProviderLifecycleEventId: "event-newer" });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    await new ShopifySubscriptionLifecycleReconciliationService(database).reconcile("shop-1", "sub-1", { activeSubscription: null, latestLifecycleEvent: { ...frozen, id: "event-old", state: "UNFROZEN", eventType: "SUBSCRIPTION_UNFROZEN" } }, now);
    expect(tx.subscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ nextReconcileAt: new Date("2026-09-14T13:00:00.000Z") }) }));
  });

  it("does not overwrite a newer unfreeze schedule after stale FROZEN classification", async () => {
    const tx = transaction({ status: "FROZEN", lastProviderLifecycleEventAt: new Date("2026-09-14T12:00:00.000Z"), lastProviderLifecycleEventId: "event-newer", nextReconcileAt: new Date("2026-09-14T12:30:00.000Z") });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    await new ShopifySubscriptionLifecycleReconciliationService(database).reconcile("shop-1", "sub-1", { activeSubscription: null, latestLifecycleEvent: frozen }, now);
    expect(tx.subscription.update).toHaveBeenCalledOnce();
    expect(tx.subscription.update.mock.calls[0][0].data.nextReconcileAt).toEqual(new Date("2026-09-14T13:00:00.000Z"));
  });

  it("preserves unrelated sync error while projecting FROZEN", async () => {
    const tx = transaction({ status: "ACTIVE", lastSyncErrorCode: "MISSING_USAGE_METER", lastProviderLifecycleEventAt: null, lastProviderLifecycleEventId: null });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    await new ShopifySubscriptionLifecycleReconciliationService(database).reconcile("shop-1", "sub-1", { activeSubscription: null, latestLifecycleEvent: frozen }, now);
    expect(tx.subscription.update.mock.calls[0][0].data.lastSyncErrorCode).toBeUndefined();
  });

  it("uses live cancelAtEndOfCycle while preserving FROZEN entitlement", async () => {
    const tx = transaction({ status: "FROZEN", planId: "plan-1", currentPeriodStart: new Date("2026-09-01"), currentPeriodEnd: new Date("2026-10-01"), lastProviderLifecycleEventAt: null, lastProviderLifecycleEventId: null });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    await new ShopifySubscriptionLifecycleReconciliationService(database).reconcile("shop-1", "sub-1", { activeSubscription: { planHandle: "growth", usageEventHandles: ["recovery-meter"], pendingPlanHandle: null, pendingEffectiveAt: null, status: "ACTIVE", currentPeriodStart: new Date("2026-09-01"), currentPeriodEnd: new Date("2026-10-01"), trialEndsAt: null, cancelAtPeriodEnd: true, providerSubscriptionId: "provider-1", providerUsageSnapshot: [] }, latestLifecycleEvent: frozen }, now);
    expect(tx.subscription.update.mock.calls[0][0].data).toMatchObject({ status: "FROZEN", cancelAtPeriodEnd: true });
  });

  it("keeps FROZEN for UNFROZEN with no live contract and retries in one hour", async () => {
    const tx = transaction({ status: "FROZEN", lastProviderLifecycleEventAt: null, lastProviderLifecycleEventId: null });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    await new ShopifySubscriptionLifecycleReconciliationService(database).reconcile("shop-1", "sub-1", { activeSubscription: null, latestLifecycleEvent: { ...frozen, id: "event-unfrozen", state: "UNFROZEN", eventType: "SUBSCRIPTION_UNFROZEN" } }, now);
    expect(tx.subscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FROZEN", lastSyncErrorCode: "UNFROZEN_LIVE_CONTRACT_PENDING", nextReconcileAt: new Date("2026-09-14T13:00:00.000Z") }) }));
  });

  it("closes the current period and writes NO_CONTRACT for effective cancellation", async () => {
    const tx = transaction({ id: "sub-1", status: "ACTIVE", planId: "plan-1", billingPeriod: { id: "period-1", status: "OPEN", planKindSnapshot: "FREE" }, lastProviderLifecycleEventAt: null, lastProviderLifecycleEventId: null });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    await new ShopifySubscriptionLifecycleReconciliationService(database).reconcile("shop-1", "sub-1", { activeSubscription: null, latestLifecycleEvent: { ...frozen, id: "event-canceled", eventType: "SUBSCRIPTION_CANCELED", state: "CANCELED" } }, now);

    expect(tx.billingPeriod.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "CLOSED", closeReason: "CONTRACT_ENDED" }) }));
    expect(tx.subscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "NO_CONTRACT", planId: null, billingPeriodId: null }) }));
  });

  it("restores an unfrozen subscription only from live same-cycle evidence", async () => {
    const tx = transaction({ status: "FROZEN", planId: "plan-1", currentPeriodStart: new Date("2026-09-01"), currentPeriodEnd: new Date("2026-10-01"), nextReconcileAt: now });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    await new ShopifySubscriptionLifecycleReconciliationService(database).reconcile("shop-1", "sub-1", {
      activeSubscription: { planHandle: "growth", usageEventHandles: ["recovery-meter"], pendingPlanHandle: null, pendingEffectiveAt: null, status: "ACTIVE", currentPeriodStart: new Date("2026-09-01"), currentPeriodEnd: new Date("2026-10-01"), trialEndsAt: null, cancelAtEndOfCycle: false, providerSubscriptionId: "provider-1", providerUsageSnapshot: [] },
      latestLifecycleEvent: { ...frozen, id: "event-unfrozen", eventType: "SUBSCRIPTION_UNFROZEN", state: "UNFROZEN" },
    }, now);

    expect(tx.subscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ACTIVE", observedShopifyPlanHandle: "growth" }) }));
  });

  it("projects FROZEN while preserving plan period and all capacity state", async () => {
    const tx = transaction({
      status: "ACTIVE",
      planId: "plan-1",
      providerSubscriptionId: "provider-1",
      billingPeriodId: "period-1",
      currentPeriodStart: new Date("2026-09-01"),
      currentPeriodEnd: new Date("2026-10-01"),
      pendingShopifyPlanHandle: "target",
      pendingPlanId: "plan-2",
      pendingEffectiveAt: new Date("2026-09-20"),
      lastProviderLifecycleEventAt: null,
      lastProviderLifecycleEventId: null,
    });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    await new ShopifySubscriptionLifecycleReconciliationService(database).reconcile("shop-1", "sub-1", { activeSubscription: null, latestLifecycleEvent: frozen }, now);

    expect(tx.subscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FROZEN", nextReconcileAt: new Date("2026-09-14T13:00:00.000Z") }) }));
    expect(tx.subscription.update.mock.calls[0][0].data).not.toHaveProperty("planId");
    for (const model of [tx.billingPeriod, tx.billingPeriodEntitlementCounter, tx.shopEntitlementCounter, tx.recoveryCreditPurchase, tx.recoveryCreditRefund, tx.promotionalCreditGrant, tx.merchantPromotionSelection, tx.usageReservation]) {
      expectNoModelMutations(model);
    }
    expect(tx.subscription.update.mock.calls[0][0].data.status).not.toBe("NO_CONTRACT");
  });

  it("restores same mapped plan and same cycle without granting or resetting capacity", async () => {
    const tx = transaction({ status: "FROZEN", planId: "plan-1", currentPeriodStart: new Date("2026-09-01"), currentPeriodEnd: new Date("2026-10-01"), lastProviderLifecycleEventAt: null, lastProviderLifecycleEventId: null });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    const resume = { schedule: vi.fn().mockResolvedValue(undefined) };
    const result = await new ShopifySubscriptionLifecycleReconciliationService(database, resume).reconcile("shop-1", "sub-1", {
      activeSubscription: { planHandle: "growth", usageEventHandles: ["recovery-meter"], pendingPlanHandle: "growth-next", pendingEffectiveAt: new Date("2026-10-01"), status: "ACTIVE", currentPeriodStart: new Date("2026-09-01"), currentPeriodEnd: new Date("2026-10-01"), trialEndsAt: null, cancelAtEndOfCycle: false, providerSubscriptionId: "provider-1", providerUsageSnapshot: [] },
      latestLifecycleEvent: { ...frozen, id: "event-unfrozen", eventType: "SUBSCRIPTION_UNFROZEN", state: "UNFROZEN" },
    }, now);

    expect(result).toBe("restored");
    expect(tx.subscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ACTIVE", pendingShopifyPlanHandle: "growth-next", pendingEffectiveAt: new Date("2026-10-01") }) }));
    expect(resume.schedule).toHaveBeenCalledWith({ shopId: "shop-1", trigger: "unfreeze" });
    for (const model of [tx.billingPeriod, tx.billingPeriodEntitlementCounter, tx.shopEntitlementCounter, tx.recoveryCreditPurchase, tx.recoveryCreditRefund, tx.promotionalCreditGrant, tx.merchantPromotionSelection]) expectNoModelMutations(model);
  });

  it("restores later same-plan Paid cycle through BACKGROUND-007 exactly once", async () => {
    const tx = transaction({ status: "FROZEN", planId: "plan-1", currentPeriodStart: new Date("2026-08-01"), currentPeriodEnd: new Date("2026-09-01"), lastProviderLifecycleEventAt: null, lastProviderLifecycleEventId: null });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    const rollover = vi.spyOn(SamePlanBillingPeriodRolloverService.prototype, "transitionInTransaction").mockResolvedValue({ kind: "transitioned", billingPeriodId: "period-2", nextReconcileAt: new Date("2026-10-01"), planKind: "PAID_METERED" });
    const planChange = vi.spyOn(ShopifyPlanChangeTransitionService.prototype, "transitionInTransaction");
    try {
      const result = await new ShopifySubscriptionLifecycleReconciliationService(database).reconcile("shop-1", "sub-1", { activeSubscription: { planHandle: "growth", usageEventHandles: ["recovery-meter"], pendingPlanHandle: null, pendingEffectiveAt: null, status: "ACTIVE", currentPeriodStart: new Date("2026-09-01"), currentPeriodEnd: new Date("2026-10-01"), trialEndsAt: null, cancelAtEndOfCycle: false, providerSubscriptionId: "provider-1", providerUsageSnapshot: [] }, latestLifecycleEvent: { ...frozen, id: "event-unfrozen", eventType: "SUBSCRIPTION_UNFROZEN", state: "UNFROZEN" } }, now);
      expect(result).toBe("restored");
      expect(rollover).toHaveBeenCalledOnce();
      expect(planChange).not.toHaveBeenCalled();
      expect(tx.billingPeriod.create).not.toHaveBeenCalled();
      expect(tx.billingPeriodEntitlementCounter.create).not.toHaveBeenCalled();
    } finally {
      rollover.mockRestore();
      planChange.mockRestore();
    }
  });

  it("does not add a second Paid grant after BACKGROUND-007 restoration", async () => {
    const tx = transaction({ status: "FROZEN", planId: "plan-1", currentPeriodStart: new Date("2026-08-01"), currentPeriodEnd: new Date("2026-09-01"), lastProviderLifecycleEventAt: null, lastProviderLifecycleEventId: null });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    const rollover = vi.spyOn(SamePlanBillingPeriodRolloverService.prototype, "transitionInTransaction").mockResolvedValue({ kind: "transitioned", billingPeriodId: "period-2", nextReconcileAt: null, planKind: "PAID_METERED" });
    try {
      await new ShopifySubscriptionLifecycleReconciliationService(database).reconcile("shop-1", "sub-1", { activeSubscription: { planHandle: "growth", usageEventHandles: ["recovery-meter"], pendingPlanHandle: null, pendingEffectiveAt: null, status: "ACTIVE", currentPeriodStart: new Date("2026-09-01"), currentPeriodEnd: new Date("2026-10-01"), trialEndsAt: null, cancelAtEndOfCycle: false, providerSubscriptionId: "provider-1", providerUsageSnapshot: [] }, latestLifecycleEvent: { ...frozen, id: "event-unfrozen", eventType: "SUBSCRIPTION_UNFROZEN", state: "UNFROZEN" } }, now);
      expect(tx.billingPeriod.create).not.toHaveBeenCalled();
      expect(tx.billingPeriodEntitlementCounter.create).not.toHaveBeenCalled();
      expect(tx.billingPeriodEntitlementCounter.upsert).not.toHaveBeenCalled();
    } finally {
      rollover.mockRestore();
    }
  });

  it("restores later same-plan Free cycle without resetting lifetime Free", async () => {
    const tx = transaction({ status: "FROZEN", planId: "plan-1", currentPeriodStart: new Date("2026-08-01"), currentPeriodEnd: new Date("2026-09-01"), lastProviderLifecycleEventAt: null, lastProviderLifecycleEventId: null });
    tx.billingPlan.findUnique.mockResolvedValue({ id: "plan-1", active: true, name: "Free", kind: "FREE", shopifyPlanHandle: "growth", includedRecoveryConversationAllowance: null, recoveryCreditPackEnabled: true, shopifyUsageEventHandle: null, shopifyRecoveryCreditPackEventHandle: "recovery-meter" });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    const rollover = vi.spyOn(SamePlanBillingPeriodRolloverService.prototype, "transitionInTransaction").mockResolvedValue({ kind: "transitioned", billingPeriodId: "period-2", nextReconcileAt: null, planKind: "FREE" });
    try {
      await new ShopifySubscriptionLifecycleReconciliationService(database).reconcile("shop-1", "sub-1", { activeSubscription: { planHandle: "growth", usageEventHandles: ["recovery-meter"], pendingPlanHandle: null, pendingEffectiveAt: null, status: "ACTIVE", currentPeriodStart: new Date("2026-09-01"), currentPeriodEnd: new Date("2026-10-01"), trialEndsAt: null, cancelAtEndOfCycle: false, providerSubscriptionId: "provider-1", providerUsageSnapshot: [] }, latestLifecycleEvent: { ...frozen, id: "event-unfrozen", eventType: "SUBSCRIPTION_UNFROZEN", state: "UNFROZEN" } }, now);
      expect(rollover).toHaveBeenCalledOnce();
      expectNoModelMutations(tx.shopEntitlementCounter);
    } finally {
      rollover.mockRestore();
    }
  });

  it("restores changed mapped plan through BACKGROUND-010 exactly once", async () => {
    const tx = transaction({ status: "FROZEN", planId: "plan-old", currentPeriodStart: new Date("2026-08-01"), currentPeriodEnd: new Date("2026-09-01"), lastProviderLifecycleEventAt: null, lastProviderLifecycleEventId: null });
    tx.billingPlan.findUnique.mockResolvedValue({ id: "plan-new", active: true, name: "New", kind: "PAID_METERED", shopifyPlanHandle: "new", includedRecoveryConversationAllowance: 100, recoveryCreditPackEnabled: false, shopifyUsageEventHandle: "recovery-meter", shopifyRecoveryCreditPackEventHandle: null });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    const rollover = vi.spyOn(SamePlanBillingPeriodRolloverService.prototype, "transitionInTransaction");
    const planChange = vi.spyOn(ShopifyPlanChangeTransitionService.prototype, "transitionInTransaction").mockResolvedValue({ kind: "transitioned", billingPeriodId: "period-2", nextReconcileAt: null, planKind: "PAID_METERED" });
    try {
      const result = await new ShopifySubscriptionLifecycleReconciliationService(database).reconcile("shop-1", "sub-1", { activeSubscription: { planHandle: "new", usageEventHandles: ["recovery-meter"], pendingPlanHandle: null, pendingEffectiveAt: null, status: "ACTIVE", currentPeriodStart: new Date("2026-09-01"), currentPeriodEnd: new Date("2026-10-01"), trialEndsAt: null, cancelAtEndOfCycle: false, providerSubscriptionId: "provider-1", providerUsageSnapshot: [] }, latestLifecycleEvent: { ...frozen, id: "event-unfrozen", eventType: "SUBSCRIPTION_UNFROZEN", state: "UNFROZEN" } }, now);
      expect(result).toBe("restored");
      expect(planChange).toHaveBeenCalledOnce();
      expect(rollover).not.toHaveBeenCalled();
    } finally {
      rollover.mockRestore();
      planChange.mockRestore();
    }
  });

  it.each([
    ["inactive mapping", "UNMAPPED_PLAN_HANDLE", { active: false }],
    ["Paid allowance null", "INVALID_INCLUDED_ALLOWANCE", { kind: "PAID_METERED", includedRecoveryConversationAllowance: null }],
    ["Paid allowance negative", "INVALID_INCLUDED_ALLOWANCE", { kind: "PAID_METERED", includedRecoveryConversationAllowance: -1 }],
    ["Paid allowance non-integer", "INVALID_INCLUDED_ALLOWANCE", { kind: "PAID_METERED", includedRecoveryConversationAllowance: 1.5 }],
    ["Paid allowance unsafe", "INVALID_INCLUDED_ALLOWANCE", { kind: "PAID_METERED", includedRecoveryConversationAllowance: Number.MAX_SAFE_INTEGER + 1 }],
    ["Paid meter missing", "MISSING_USAGE_METER", { kind: "PAID_METERED", shopifyUsageEventHandle: null }],
    ["provider omits Paid meter", "MISSING_USAGE_METER", { kind: "PAID_METERED" }],
    ["Paid pack missing", "MISSING_USAGE_METER", { kind: "PAID_METERED", recoveryCreditPackEnabled: true, shopifyRecoveryCreditPackEventHandle: null }],
    ["provider omits Free pack", "MISSING_USAGE_METER", { kind: "FREE", recoveryCreditPackEnabled: true, shopifyRecoveryCreditPackEventHandle: "pack" }],
    ["Paid cycle missing", "MISSING_BILLING_CYCLE", { kind: "PAID_METERED" }],
  ] as const)("keeps unfreeze fail closed for invalid mapped provider plan: %s", async (_label, code, overrides) => {
    const tx = transaction({ status: "FROZEN", planId: "plan-1", currentPeriodStart: new Date("2026-09-01"), currentPeriodEnd: new Date("2026-10-01"), lastProviderLifecycleEventAt: null, lastProviderLifecycleEventId: null });
    const plan = { id: "plan-1", active: true, name: "Plan", kind: "PAID_METERED", includedRecoveryConversationAllowance: 100, recoveryCreditPackEnabled: false, shopifyUsageEventHandle: "recovery-meter", shopifyRecoveryCreditPackEventHandle: null, shopifyPlanHandle: "growth", ...overrides };
    tx.billingPlan.findUnique.mockResolvedValue(plan);
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    const provider = { planHandle: "growth", usageEventHandles: code === "MISSING_USAGE_METER" ? [] : (overrides.kind === "FREE" ? [] : ["recovery-meter"]), pendingPlanHandle: "pending", pendingEffectiveAt: new Date("2026-10-01"), status: "ACTIVE" as const, currentPeriodStart: code === "MISSING_BILLING_CYCLE" ? null : new Date("2026-09-01"), currentPeriodEnd: code === "MISSING_BILLING_CYCLE" ? null : new Date("2026-10-01"), trialEndsAt: null, cancelAtEndOfCycle: true, providerSubscriptionId: "provider-1", providerUsageSnapshot: [] };
    await new ShopifySubscriptionLifecycleReconciliationService(database).reconcile("shop-1", "sub-1", { activeSubscription: provider, latestLifecycleEvent: { ...frozen, id: "event-unfrozen", eventType: "SUBSCRIPTION_UNFROZEN", state: "UNFROZEN" } }, now);
    expect(tx.subscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: code === "UNMAPPED_PLAN_HANDLE" ? "UNMAPPED" : "SYNC_ERROR", lastSyncErrorCode: code, pendingShopifyPlanHandle: "pending" }) }));
    expect(tx.subscription.update.mock.calls.at(-1)?.[0].data.status).not.toBe("ACTIVE");
    expectNoModelMutations(tx.billingPeriod);
    expectNoModelMutations(tx.billingPeriodEntitlementCounter);
  });

  it("publishes one best-effort unfreeze capacity-resume hint after commit", async () => {
    const tx = transaction({ status: "FROZEN", planId: "plan-1", currentPeriodStart: new Date("2026-09-01"), currentPeriodEnd: new Date("2026-10-01"), lastProviderLifecycleEventAt: null, lastProviderLifecycleEventId: null });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    const order: string[] = [];
    database.$transaction.mockImplementation(async (callback: (value: typeof tx) => unknown) => { const result = await callback(tx); order.push("commit"); return result; });
    const resume = { schedule: vi.fn(async () => { order.push("resume"); }) };
    await new ShopifySubscriptionLifecycleReconciliationService(database, resume).reconcile("shop-1", "sub-1", { activeSubscription: { planHandle: "growth", usageEventHandles: ["recovery-meter"], pendingPlanHandle: null, pendingEffectiveAt: null, status: "ACTIVE", currentPeriodStart: new Date("2026-09-01"), currentPeriodEnd: new Date("2026-10-01"), trialEndsAt: null, cancelAtEndOfCycle: false, providerSubscriptionId: "provider-1", providerUsageSnapshot: [] }, latestLifecycleEvent: { ...frozen, id: "event-unfrozen", eventType: "SUBSCRIPTION_UNFROZEN", state: "UNFROZEN" } }, now);
    expect(resume.schedule).toHaveBeenCalledOnce();
    expect(order).toEqual(expect.arrayContaining(["commit", "resume"]));
    expect(order.indexOf("commit")).toBeLessThan(order.indexOf("resume"));
  });

  it("swallows unfreeze capacity-resume failure after committed restoration", async () => {
    const tx = transaction({ status: "FROZEN", planId: "plan-1", currentPeriodStart: new Date("2026-09-01"), currentPeriodEnd: new Date("2026-10-01"), lastProviderLifecycleEventAt: null, lastProviderLifecycleEventId: null });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    const logger = { warn: vi.fn(), error: vi.fn() };
    const resume = { schedule: vi.fn().mockRejectedValue(new Error("redis unavailable")) };
    await expect(new ShopifySubscriptionLifecycleReconciliationService(database, resume, logger).reconcile("shop-1", "sub-1", { activeSubscription: { planHandle: "growth", usageEventHandles: ["recovery-meter"], pendingPlanHandle: null, pendingEffectiveAt: null, status: "ACTIVE", currentPeriodStart: new Date("2026-09-01"), currentPeriodEnd: new Date("2026-10-01"), trialEndsAt: null, cancelAtEndOfCycle: false, providerSubscriptionId: "provider-1", providerUsageSnapshot: [] }, latestLifecycleEvent: { ...frozen, id: "event-unfrozen", eventType: "SUBSCRIPTION_UNFROZEN", state: "UNFROZEN" } }, now)).resolves.toBe("restored");
    expect(logger.warn).toHaveBeenCalledWith("billing.recovery_capacity_resume.enqueue_failed", expect.anything());
  });

  it("does not publish unfreeze capacity-resume for unresolved or repeated FROZEN state", async () => {
    const resume = { schedule: vi.fn() };
    const unresolvedTx = transaction({ status: "FROZEN", lastProviderLifecycleEventAt: null, lastProviderLifecycleEventId: null });
    const unresolvedDb = { $transaction: vi.fn(async (callback: (value: typeof unresolvedTx) => unknown) => callback(unresolvedTx)) };
    await new ShopifySubscriptionLifecycleReconciliationService(unresolvedDb, resume).reconcile("shop-1", "sub-1", { activeSubscription: null, latestLifecycleEvent: { ...frozen, state: "UNFROZEN", eventType: "SUBSCRIPTION_UNFROZEN" } }, now);
    const repeatedTx = transaction({ status: "FROZEN", lastProviderLifecycleEventAt: frozen.occurredAt, lastProviderLifecycleEventId: frozen.id });
    const repeatedDb = { $transaction: vi.fn(async (callback: (value: typeof repeatedTx) => unknown) => callback(repeatedTx)) };
    await new ShopifySubscriptionLifecycleReconciliationService(repeatedDb, resume).reconcile("shop-1", "sub-1", { activeSubscription: null, latestLifecycleEvent: frozen }, now);
    expect(resume.schedule).not.toHaveBeenCalled();
  });

  it("closes Paid cancellation once with canonical reservation and counter CAS", async () => {
    const period = { id: "period-1", status: "OPEN", planKindSnapshot: "PAID_METERED" };
    const tx = transaction({ id: "sub-1", status: "ACTIVE", planId: "plan-1", providerSubscriptionId: "provider-1", billingPeriodId: "period-1", billingPeriod: period, lastProviderLifecycleEventAt: null, lastProviderLifecycleEventId: null });
    tx.billingPeriodEntitlementCounter.findUnique
      .mockResolvedValueOnce({ id: "counter-1", grantedQuantity: 10, committedQuantity: 4, reservedQuantity: 2, forfeitedQuantity: 0, version: 3 })
      .mockResolvedValueOnce({ id: "counter-1", grantedQuantity: 10, committedQuantity: 4, reservedQuantity: 0, forfeitedQuantity: 6, version: 4 });
    tx.usageReservation.aggregate.mockResolvedValue({ _sum: { quantity: 2 } });
    tx.billingPeriodEntitlementCounter.updateMany.mockResolvedValue({ count: 1 });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown, options?: unknown) => { const result = await callback(tx); return options ? { result, options } : result; }) };
    await new ShopifySubscriptionLifecycleReconciliationService(database).reconcile("shop-1", "sub-1", { activeSubscription: null, latestLifecycleEvent: { ...frozen, id: "event-canceled", eventType: "SUBSCRIPTION_CANCELED", state: "CANCELED" } }, now);
    expect(database.$transaction.mock.calls.at(-1)?.[1]).toEqual({ isolationLevel: "Serializable" });
    expect(tx.usageReservation.aggregate).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: { in: ["RESERVED", "AMBIGUOUS"] } }) }));
    expect(tx.billingPeriodEntitlementCounter.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "counter-1", version: 3, reservedQuantity: 2 }) }));
    expect(tx.billingPeriod.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "period-1", status: "OPEN" }, data: expect.objectContaining({ closeReason: "CONTRACT_ENDED" }) }));
    expect(tx.subscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "NO_CONTRACT", planId: null }) }));
  });

  it("replays effective cancellation without a second close or counter mutation", async () => {
    const tx = transaction({ id: "sub-1", status: "NO_CONTRACT", planId: null, billingPeriod: null, billingPeriodId: null, lastProviderLifecycleEventAt: frozen.occurredAt, lastProviderLifecycleEventId: "event-canceled" });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    await new ShopifySubscriptionLifecycleReconciliationService(database).reconcile("shop-1", "sub-1", { activeSubscription: null, latestLifecycleEvent: { ...frozen, id: "event-canceled", eventType: "SUBSCRIPTION_CANCELED", state: "CANCELED" } }, now);
    expect(tx.billingPeriod.updateMany).not.toHaveBeenCalled();
    expect(tx.billingPeriodEntitlementCounter.updateMany).not.toHaveBeenCalled();
    expect(tx.usageReservation.updateMany).not.toHaveBeenCalled();
  });

  it("preserves lifetime purchased refund promotion and selection history on cancellation", async () => {
    const tx = transaction({ id: "sub-1", status: "ACTIVE", planId: "plan-1", providerSubscriptionId: "provider-1", billingPeriod: null, billingPeriodId: null, lastProviderLifecycleEventAt: null, lastProviderLifecycleEventId: null });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    await new ShopifySubscriptionLifecycleReconciliationService(database).reconcile("shop-1", "sub-1", { activeSubscription: null, latestLifecycleEvent: { ...frozen, id: "event-canceled", eventType: "SUBSCRIPTION_CANCELED", state: "CANCELED" } }, now);
    for (const model of [tx.shopEntitlementCounter, tx.recoveryCreditPurchase, tx.recoveryCreditRefund, tx.promotionalCreditGrant, tx.merchantPromotionSelection]) expectNoModelMutations(model);
  });

  it("does not retimestamp old-cycle UsageEvents during effective cancellation", async () => {
    const tx = transaction({ id: "sub-1", status: "ACTIVE", planId: "plan-1", providerSubscriptionId: "provider-1", billingPeriod: { id: "period-1", status: "OPEN", planKindSnapshot: "FREE" }, billingPeriodId: "period-1", lastProviderLifecycleEventAt: null, lastProviderLifecycleEventId: null });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    await new ShopifySubscriptionLifecycleReconciliationService(database).reconcile("shop-1", "sub-1", { activeSubscription: null, latestLifecycleEvent: { ...frozen, id: "event-canceled", eventType: "SUBSCRIPTION_CANCELED", state: "CANCELED" } }, now);
    const data = tx.usageEvent.updateMany.mock.calls[0]?.[0]?.data ?? {};
    expect(data).not.toHaveProperty("occurredAt");
    expect(data).not.toHaveProperty("createdAt");
    expect(data).not.toHaveProperty("billingPeriodId");
    expect(data).not.toHaveProperty("providerIdempotencyKey");
  });

  it("ignores CANCELED lifecycle history for a genuinely fresh NO_CONTRACT row", async () => {
    const tx = transaction({ id: "sub-1", status: "NO_CONTRACT", planId: null, providerSubscriptionId: null, billingPeriodId: null, billingPeriod: null, lastProviderLifecycleEventAt: null, lastProviderLifecycleEventId: null });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    await new ShopifySubscriptionLifecycleReconciliationService(database).reconcile("shop-1", "sub-1", { activeSubscription: null, latestLifecycleEvent: { ...frozen, id: "event-canceled", eventType: "SUBSCRIPTION_CANCELED", state: "CANCELED" } }, now);
    expect(tx.subscription.update).not.toHaveBeenCalled();
    expect(tx.billingPeriod.updateMany).not.toHaveBeenCalled();
  });
});