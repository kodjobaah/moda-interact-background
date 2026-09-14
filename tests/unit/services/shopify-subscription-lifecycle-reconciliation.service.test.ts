import { describe, expect, it, vi } from "vitest";

import { ShopifySubscriptionLifecycleReconciliationService } from "../../../src/services/shopify-subscription-lifecycle-reconciliation.service.js";

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
    billingPeriod: { update: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    usageEvent: { updateMany: vi.fn() },
    billingPeriodEntitlementCounter: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn(), updateMany: vi.fn() },
    usageReservation: { aggregate: vi.fn(), updateMany: vi.fn() },
  };
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

  it("does not let older lifecycle evidence overwrite newer persisted evidence", async () => {
    const tx = transaction({ lastProviderLifecycleEventAt: new Date("2026-09-14T12:00:00.000Z"), lastProviderLifecycleEventId: "event-newer" });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    await new ShopifySubscriptionLifecycleReconciliationService(database).reconcile("shop-1", "sub-1", { activeSubscription: null, latestLifecycleEvent: frozen }, now);
    expect(tx.subscription.update).not.toHaveBeenCalled();
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
});