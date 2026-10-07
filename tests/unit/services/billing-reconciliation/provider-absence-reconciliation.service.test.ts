import { describe, expect, it, vi } from "vitest";

import { ProviderAbsenceReconciliationService } from "../../../../src/services/billing-reconciliation/provider-absence-reconciliation.service.js";
import { ShopifySubscriptionLifecycleReconciliationService } from "../../../../src/services/shopify-subscription-lifecycle-reconciliation.service.js";

const now = new Date("2026-09-12T12:00:00.000Z");
const snapshot = {
  activeSubscription: null,
  latestLifecycleEvent: null,
};

function existingSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "subscription-1",
    status: "ACTIVE",
    billingPeriodId: "period-1",
    nextReconcileAt: new Date("2026-09-12T11:00:00.000Z"),
    pendingShopifyPlanHandle: null,
    pendingPlanId: null,
    pendingEffectiveAt: null,
    plan: { shopifyRecoveryCreditPackEventHandle: "pack-meter" },
    ...overrides,
  };
}

function harness(existing: ReturnType<typeof existingSubscription> | null = existingSubscription()) {
  const database = {
    subscription: {
      findUnique: vi.fn().mockResolvedValue(existing),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      upsert: vi.fn().mockResolvedValue({ id: "subscription-1" }),
    },
    $transaction: vi.fn(),
  };
  const scheduler = {
    publishCommittedLifecycleSchedule: vi.fn().mockResolvedValue(undefined),
  };
  const service = new ProviderAbsenceReconciliationService(database as never, scheduler as never);
  return { database, scheduler, service };
}

describe("ProviderAbsenceReconciliationService", () => {
  it("preserves an existing projection and schedules another provider observation", async () => {
    const test = harness();

    await expect(test.service.reconcile(
      "shop-1",
      snapshot,
      now,
      { billingFrozenRecheckSeconds: 900, billingProviderRetrySeconds: 30 },
    )).resolves.toEqual({ billingPeriodId: "period-1", packMeterHandle: "pack-meter" });

    expect(test.database.subscription.updateMany).toHaveBeenCalledWith({
      where: {
        id: "subscription-1",
        nextReconcileAt: new Date("2026-09-12T11:00:00.000Z"),
      },
      data: {
        nextReconcileAt: new Date("2026-09-12T12:00:30.000Z"),
        lastSyncedAt: now,
      },
    });
    expect(test.database.subscription.upsert).not.toHaveBeenCalled();
  });

  it("materialises NO_CONTRACT only when there is no existing local subscription", async () => {
    const test = harness(null);

    await expect(test.service.reconcile("shop-1", snapshot, now)).resolves.toEqual({
      billingPeriodId: null,
      packMeterHandle: null,
    });

    expect(test.database.subscription.updateMany).not.toHaveBeenCalled();
    expect(test.database.subscription.upsert).toHaveBeenCalledWith({
      where: { shopId: "shop-1" },
      update: {
        planId: null,
        observedShopifyPlanHandle: null,
        status: "NO_CONTRACT",
        billingPeriodId: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        trialEndsAt: null,
        cancelAtPeriodEnd: false,
        providerSubscriptionId: null,
        lastSyncedAt: now,
        lastSyncErrorCode: null,
        lastSyncErrorAt: null,
        pendingShopifyPlanHandle: null,
        pendingPlanId: null,
        pendingEffectiveAt: null,
      },
      create: { shopId: "shop-1", status: "NO_CONTRACT", lastSyncedAt: now },
    });
  });

  it("delegates lifecycle evidence and publishes the committed lifecycle schedule", async () => {
    const lifecycleSnapshot = {
      activeSubscription: null,
      latestLifecycleEvent: {
        id: "event-frozen",
        eventType: "SUBSCRIPTION_FROZEN" as const,
        state: "FROZEN" as const,
        occurredAt: new Date("2026-09-12T11:00:00.000Z"),
        cancelEffectiveOn: null,
        planHandle: "pro-2026",
        billingPeriod: "2026-09-01/2026-10-01",
      },
    };
    const test = harness();
    const lifecycle = vi.spyOn(
      ShopifySubscriptionLifecycleReconciliationService.prototype,
      "reconcile",
    ).mockResolvedValue("handled");

    await expect(test.service.reconcile("shop-1", lifecycleSnapshot, now)).resolves.toEqual({
      billingPeriodId: "period-1",
      packMeterHandle: null,
    });

    expect(lifecycle).toHaveBeenCalledWith("shop-1", "subscription-1", lifecycleSnapshot, now);
    expect(test.scheduler.publishCommittedLifecycleSchedule).toHaveBeenCalledWith(
      "shop-1",
      "subscription-1",
    );
    expect(test.database.subscription.updateMany).not.toHaveBeenCalled();
    expect(test.database.subscription.upsert).not.toHaveBeenCalled();
    lifecycle.mockRestore();
  });

  it("preserves pending initial intent while provider truth remains absent", async () => {
    const test = harness(existingSubscription({
      status: "NO_CONTRACT",
      billingPeriodId: null,
      pendingShopifyPlanHandle: "paid-2026",
      pendingPlanId: "plan-paid",
      pendingEffectiveAt: new Date("2026-09-12T11:00:00.000Z"),
      plan: null,
    }));

    await test.service.reconcile("shop-1", snapshot, now);

    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "subscription-1" }),
      data: {
        nextReconcileAt: new Date("2026-09-12T12:05:00.000Z"),
        lastSyncedAt: now,
      },
    }));
    expect(test.database.subscription.upsert).not.toHaveBeenCalled();
  });
});
