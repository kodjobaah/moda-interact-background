vi.mock("../../../src/services/recovery-capacity-resume.service.js", () => ({
  recoveryCapacityResumeService: { schedule: vi.fn(async () => undefined) },
}));

import { describe, expect, it, vi } from "vitest";
import { ShopifySubscriptionLifecycleReconciliationService } from "../../../src/services/shopify-subscription-lifecycle-reconciliation.service.js";
import { ShopifyPlanChangeTransitionService } from "../../../src/services/shopify-plan-change-transition.service.js";
import { BillingReconciliationService } from "../../../src/services/billing-reconciliation.service.js";
import { BillingPlanMaterializationService } from "../../../src/services/billing-plan-materialization.service.js";
import { ProviderUsageReconciliationService } from "../../../src/services/billing-reconciliation/provider-usage-reconciliation.service.js";
import { billingOperationalIncidentSink } from "../../../src/services/billing-operational-incident.service.js";
import { classifySubscriptionReconciliation } from "../../../src/services/billing-subscription-reconciliation/classification.js";

const now = new Date("2026-09-14T12:00:00.000Z");
const validPlan = {
  id: "plan-1", active: true, name: "Growth", kind: "PAID_METERED",
  shopifyPlanHandle: "growth", includedRecoveryConversationAllowance: 100,
  recoveryCreditPackEnabled: false, shopifyUsageEventHandle: null,
  shopifyRecoveryCreditPackEventHandle: null,
};
const frozen = {
  id: "event-frozen", eventType: "SUBSCRIPTION_FROZEN" as const, state: "FROZEN" as const,
  occurredAt: new Date("2026-09-14T11:00:00.000Z"), cancelEffectiveOn: null,
  planHandle: "growth", billingPeriod: "2026-09-01/2026-10-01",
};

function transaction(subscription: Record<string, unknown>) {
  const validSameCycle = subscription.status === "FROZEN" && subscription.planId === "plan-1"
    && subscription.currentPeriodStart instanceof Date && subscription.currentPeriodEnd instanceof Date
    && (subscription.billingPeriodId === undefined || subscription.billingPeriodId === "period-1")
    && subscription.billingPeriod !== null;
  subscription = validSameCycle ? {
    ...subscription, billingPeriodId: "period-1",
    billingPeriod: {
      id: "period-1", shopId: "shop-1", subscriptionId: "sub-1", planId: "plan-1",
      shopifyPlanHandleSnapshot: "growth", planKindSnapshot: "PAID_METERED",
      includedRecoveryCreditsGranted: 100, status: "OPEN",
      periodStart: subscription.currentPeriodStart, periodEnd: subscription.currentPeriodEnd,
      ...((subscription.billingPeriod ?? {}) as Record<string, unknown>),
    },
  } : subscription;
  return {
    $queryRaw: vi.fn(),
    subscription: { findUnique: vi.fn().mockResolvedValue(subscription), update: vi.fn() },
    merchantPricingPlan: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn() },
    billingPlan: { findUnique: vi.fn(), create: vi.fn() },
    billingPeriod: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    usageEvent: { updateMany: vi.fn() },
    usageReservation: { aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: 0 } }), updateMany: vi.fn() },
    billingPeriodEntitlementCounter: {
      findUnique: vi.fn().mockResolvedValue(validSameCycle ? {
        id: "counter-1", shopId: "shop-1", billingPeriodId: "period-1", grantedQuantity: 100,
        committedQuantity: 3, reservedQuantity: 0, forfeitedQuantity: 0,
      } : null), updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

describe("Shopify unfreeze billing-mapping and integrity regressions", () => {
  it("materialises a ready exact catalogue plan before restoring a frozen Shopify subscription", async () => {
    const tx = transaction({
      status: "FROZEN", planId: "plan-previous", billingPeriodId: null,
      currentPeriodStart: new Date("2026-08-01"), currentPeriodEnd: new Date("2026-09-01"),
      lastProviderLifecycleEventAt: null, lastProviderLifecycleEventId: null,
    });
    const materialised = {
      id: "plan-materialised", active: true, name: "Growth New", kind: "PAID_METERED",
      shopifyPlanHandle: "growth-new", includedRecoveryConversationAllowance: 10,
      recoveryCreditPackEnabled: false, shopifyUsageEventHandle: null,
      shopifyRecoveryCreditPackEventHandle: null,
    };
    let operationalPlan: typeof materialised | null = null;
    tx.billingPlan.findUnique.mockImplementation(async () => operationalPlan);
    tx.billingPlan.create.mockImplementation(async () => {
      operationalPlan = materialised;
      return operationalPlan;
    });
    tx.merchantPricingPlan.findUnique.mockImplementation(async (args: { select: Record<string, unknown> }) => {
      if ("usageEvents" in args.select) return { usageEvents: [{ eventHandle: "provider-charge" }] };
      return {
        id: "catalogue-1", isActive: true, publicationStatus: "READY",
        displayName: "Growth New", planKind: "PAID_METERED", includedRecoveryCredits: 10,
        shopifyRecoveryUsageEventHandle: null, features: [],
      };
    });
    const database = {
      billingPlan: tx.billingPlan, merchantPricingPlan: tx.merchantPricingPlan,
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    };
    const transition = vi.spyOn(ShopifyPlanChangeTransitionService.prototype, "transitionInTransaction")
      .mockResolvedValue({ kind: "transitioned", billingPeriodId: "period-new", nextReconcileAt: null, planKind: "PAID_METERED" });
    try {
      const result = await new ShopifySubscriptionLifecycleReconciliationService(database as never).reconcile(
        "shop-1", "sub-1", {
          activeSubscription: {
            planHandle: "growth-new", usageEventHandles: ["provider-charge"],
            pendingPlanHandle: null, pendingEffectiveAt: null, status: "ACTIVE",
            currentPeriodStart: new Date("2026-09-01"), currentPeriodEnd: new Date("2026-10-01"),
            trialEndsAt: null, cancelAtEndOfCycle: false, providerSubscriptionId: "provider-1", providerUsageSnapshot: [],
          },
          latestLifecycleEvent: { ...frozen, id: "event-unfrozen", eventType: "SUBSCRIPTION_UNFROZEN", state: "UNFROZEN" },
        }, now,
      );
      expect(result).toBe("restored");
      expect(tx.billingPlan.create).toHaveBeenCalledOnce();
      expect(tx.merchantPricingPlan.update).toHaveBeenCalledOnce();
      expect(transition).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        plan: expect.objectContaining({ id: "plan-materialised" }),
      }));
      expect(tx.subscription.update.mock.calls.at(-1)?.[0].data).toMatchObject({
        lastSyncErrorCode: null, lastSyncErrorAt: null,
      });
    } finally {
      transition.mockRestore();
    }
  });

  it("closes the outgoing Paid cycle and releases reservations before detaching an unknown unfreeze plan", async () => {
    const period = {
      id: "period-old", status: "OPEN", planKindSnapshot: "PAID_METERED",
      periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-10-01"),
    };
    const tx = transaction({
      id: "sub-1", status: "FROZEN", planId: "plan-previous",
      billingPeriodId: "period-old", billingPeriod: period, plan: { kind: "PAID_METERED" },
      currentPeriodStart: period.periodStart, currentPeriodEnd: period.periodEnd,
      lastProviderLifecycleEventAt: null, lastProviderLifecycleEventId: null,
    });
    tx.billingPlan.findUnique.mockResolvedValue(null);
    tx.merchantPricingPlan.findUnique.mockResolvedValue(null);
    tx.billingPeriodEntitlementCounter.findUnique
      .mockResolvedValueOnce({ id: "counter-1", grantedQuantity: 10, committedQuantity: 3, reservedQuantity: 2, forfeitedQuantity: 0, version: 1 })
      .mockResolvedValueOnce({ id: "counter-1", grantedQuantity: 10, committedQuantity: 3, reservedQuantity: 0, forfeitedQuantity: 7, version: 2 });
    tx.usageReservation.aggregate.mockResolvedValue({ _sum: { quantity: 2 } });
    tx.billingPeriodEntitlementCounter.updateMany.mockResolvedValue({ count: 1 });
    const database = {
      billingPlan: tx.billingPlan, merchantPricingPlan: tx.merchantPricingPlan,
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    };
    const result = await new ShopifySubscriptionLifecycleReconciliationService(database as never).reconcile(
      "shop-1", "sub-1", {
        activeSubscription: {
          planHandle: "missing-growth", usageEventHandles: [], pendingPlanHandle: null, pendingEffectiveAt: null,
          status: "ACTIVE", currentPeriodStart: period.periodStart, currentPeriodEnd: period.periodEnd,
          trialEndsAt: null, cancelAtEndOfCycle: false, providerSubscriptionId: "provider-1", providerUsageSnapshot: [],
        },
        latestLifecycleEvent: { ...frozen, id: "event-unfrozen", eventType: "SUBSCRIPTION_UNFROZEN", state: "UNFROZEN" },
      }, now,
    );
    expect(result).toBe("handled");
    expect(tx.usageReservation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ["RESERVED", "AMBIGUOUS"] } }),
      data: expect.objectContaining({ status: "RELEASED", releaseReason: "PERIOD_CLOSED" }),
    }));
    expect(tx.billingPeriodEntitlementCounter.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ version: 1, reservedQuantity: 2 }),
    }));
    expect(tx.billingPeriod.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "period-old", status: "OPEN" },
      data: expect.objectContaining({ closeReason: "PLAN_CHANGED", status: "CLOSED" }),
    }));
    expect(tx.subscription.update.mock.calls.at(-1)?.[0].data).toMatchObject({
      status: "UNMAPPED", planId: null, billingPeriodId: null,
      currentPeriodStart: null, currentPeriodEnd: null, lastSyncErrorCode: null,
    });
  });

  it("clears resolved sync errors on successful same-cycle unfreeze", async () => {
    const tx = transaction({
      status: "FROZEN", planId: "plan-1", billingPeriodId: "period-1",
      currentPeriodStart: new Date("2026-09-01"), currentPeriodEnd: new Date("2026-10-01"),
      lastSyncErrorCode: "INVALID_INCLUDED_ALLOWANCE", lastSyncErrorAt: new Date("2026-09-13"),
      lastProviderLifecycleEventAt: null, lastProviderLifecycleEventId: null,
    });
    tx.billingPlan.findUnique.mockResolvedValue(validPlan);
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    const result = await new ShopifySubscriptionLifecycleReconciliationService(database as never).reconcile(
      "shop-1", "sub-1", {
        activeSubscription: {
          planHandle: "growth", usageEventHandles: ["recovery-meter"], pendingPlanHandle: null,
          pendingEffectiveAt: null, status: "ACTIVE", currentPeriodStart: new Date("2026-09-01"),
          currentPeriodEnd: new Date("2026-10-01"), trialEndsAt: null,
          cancelAtEndOfCycle: false, providerSubscriptionId: "provider-1", providerUsageSnapshot: [],
        },
        latestLifecycleEvent: { ...frozen, id: "event-unfrozen", eventType: "SUBSCRIPTION_UNFROZEN", state: "UNFROZEN" },
      }, now,
    );
    expect(result).toBe("restored");
    expect(tx.subscription.update.mock.calls.at(-1)?.[0].data).toMatchObject({
      status: "ACTIVE", lastSyncErrorCode: null, lastSyncErrorAt: null,
    });
  });

  it("does not silently clear an unresolved billing-period integrity error", async () => {
    const tx = transaction({
      status: "FROZEN", planId: "plan-1", currentPeriodStart: new Date("2026-09-01"),
      currentPeriodEnd: new Date("2026-10-01"), lastSyncErrorCode: "BILLING_PERIOD_PLAN_CONFLICT",
      lastSyncErrorAt: new Date("2026-09-13"),
      lastProviderLifecycleEventAt: null, lastProviderLifecycleEventId: null,
    });
    // This counter is genuinely missing: Shopify's active contract cannot
    // repair the accounting invariant or grant credits during unfreeze.
    tx.billingPeriodEntitlementCounter.findUnique.mockResolvedValue(null);
    tx.billingPlan.findUnique.mockResolvedValue(validPlan);
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    const result = await new ShopifySubscriptionLifecycleReconciliationService(database as never).reconcile(
      "shop-1", "sub-1", {
        activeSubscription: {
          planHandle: "growth", usageEventHandles: ["recovery-meter"], pendingPlanHandle: null,
          pendingEffectiveAt: null, status: "ACTIVE", currentPeriodStart: new Date("2026-09-01"),
          currentPeriodEnd: new Date("2026-10-01"), trialEndsAt: null,
          cancelAtEndOfCycle: false, providerSubscriptionId: "provider-1", providerUsageSnapshot: [],
        },
        latestLifecycleEvent: { ...frozen, id: "event-unfrozen", eventType: "SUBSCRIPTION_UNFROZEN", state: "UNFROZEN" },
      }, now,
    );
    expect(result).toBe("handled");
    expect(tx.subscription.update.mock.calls.at(-1)?.[0].data).toMatchObject({
      status: "SYNC_ERROR", nextReconcileAt: expect.any(Date),
    });
    expect(tx.subscription.update.mock.calls.at(-1)?.[0].data.lastSyncErrorCode).toBe("UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT");
    expect(tx.billingPeriodEntitlementCounter.findUnique).toHaveBeenCalledOnce();
    expect(tx.billingPeriodEntitlementCounter.updateMany).not.toHaveBeenCalled();
    expect(tx.usageReservation.updateMany).not.toHaveBeenCalled();
  });

  it("keeps failed unfreeze blocked through repeated provider evidence and the general scanner", async () => {
    const cycleStart = new Date("2026-09-01T00:00:00.000Z");
    const cycleEnd = new Date("2026-10-01T00:00:00.000Z");
    const tx = transaction({
      id: "sub-1", status: "FROZEN", planId: "plan-1", billingPeriodId: "period-1",
      observedShopifyPlanHandle: "growth",
      billingPeriod: {}, currentPeriodStart: cycleStart, currentPeriodEnd: cycleEnd,
      lastProviderLifecycleState: "FROZEN", lastProviderLifecycleEventAt: null,
      lastProviderLifecycleEventId: null, lastSyncErrorCode: null,
      nextReconcileAt: now,
    });
    const current = await tx.subscription.findUnique();
    tx.subscription.findUnique.mockImplementation(async () => current);
    tx.subscription.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(current, data);
      return current;
    });
    tx.billingPlan.findUnique.mockResolvedValue(validPlan);
    tx.billingPeriodEntitlementCounter.findUnique.mockResolvedValue(null);
    const database = {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
      subscription: {
        findUnique: vi.fn(async () => current),
        updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          if (where.status !== current.status || where.lastSyncErrorCode !== current.lastSyncErrorCode
            || where.nextReconcileAt !== current.nextReconcileAt) return { count: 0 };
          Object.assign(current, data);
          return { count: 1 };
        }),
      },
      billingPlan: tx.billingPlan,
      merchantPricingPlan: tx.merchantPricingPlan,
      shop: { findMany: vi.fn().mockResolvedValue([{ id: "shop-1", shopifyShopId: "gid://shopify/Shop/1" }]) },
    };
    const provider = {
      planHandle: "growth", usageEventHandles: [], pendingPlanHandle: null,
      pendingEffectiveAt: null, status: "ACTIVE" as const,
      currentPeriodStart: cycleStart, currentPeriodEnd: cycleEnd,
      trialEndsAt: null, cancelAtPeriodEnd: false,
      providerSubscriptionId: "provider-1", providerUsageSnapshot: [], providerUsagePricingSnapshot: [],
    };
    const event = { ...frozen, id: "unfrozen-integrity", eventType: "SUBSCRIPTION_UNFROZEN" as const, state: "UNFROZEN" as const };
    const lifecycle = new ShopifySubscriptionLifecycleReconciliationService(database as never);
    const first = await lifecycle.reconcile("shop-1", "sub-1", {
      activeSubscription: provider, latestLifecycleEvent: event,
    }, now);
    expect(first).toBe("handled");
    expect(current).toMatchObject({
      status: "SYNC_ERROR", lastSyncErrorCode: "UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT",
      lastProviderLifecycleState: "UNFROZEN", nextReconcileAt: expect.any(Date),
    });
    const oldErrorAt = current.lastSyncErrorAt;

    const materialize = vi.spyOn(BillingPlanMaterializationService.prototype, "resolve");
    const usage = vi.spyOn(ProviderUsageReconciliationService.prototype, "reconcile")
      .mockResolvedValue({ purchasesActivated: 0, discrepancies: [] });
    // Unit tests must not call the real PostgreSQL operational-incident store.
    const incidentReport = vi.spyOn(billingOperationalIncidentSink, "report").mockResolvedValue(undefined);
    const partner = { getSubscriptionReconciliationSnapshot: vi.fn().mockResolvedValue({
      activeSubscription: provider, latestLifecycleEvent: null,
    }) };
    const scanner = new BillingReconciliationService(
      database as never, partner as never,
      { publishDue: vi.fn().mockResolvedValue({}) } as never,
      { reconcileProviderConfirmed: vi.fn() } as never,
      { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
      () => new Date(now.getTime() + 60_000),
    );
    try {
      const scanned = await scanner.reconcileOnce();
      expect(scanned.subscriptionErrors).toBe(0);
      expect(incidentReport).toHaveBeenCalledWith("shop-1", expect.objectContaining({
        id: "sub-1", observedShopifyPlanHandle: "growth",
        lastSyncErrorCode: "UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT",
      }));
      expect(materialize).not.toHaveBeenCalled();
      expect(current.status).toBe("SYNC_ERROR");
      expect(current.lastSyncErrorCode).toBe("UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT");
      expect(current.lastSyncErrorAt).toEqual(oldErrorAt);
      expect(usage).toHaveBeenCalledWith("shop-1", provider, { billingPeriodId: null, packMeterHandle: null });

      const replay = await lifecycle.reconcile("shop-1", "sub-1", {
        activeSubscription: provider, latestLifecycleEvent: event,
      }, new Date(now.getTime() + 120_000));
      expect(replay).toBe("handled");
      expect(current.status).toBe("SYNC_ERROR");
      expect(current.lastSyncErrorCode).toBe("UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT");

      // A later provider UPDATED/CREATED/cancellation-scheduled observation
      // may update lifecycle evidence but cannot erase the accounting block.
      for (const [index, state, eventType] of [
        [0, "UPDATED", "SUBSCRIPTION_UPDATED"],
        [1, "CREATED", "SUBSCRIPTION_CREATED"],
        [2, "CANCELLATION_SCHEDULED", "SUBSCRIPTION_CANCELLATION_SCHEDULED"],
      ] as const) {
        const next = { ...frozen, id: `event-later-${index}`, state, eventType,
          occurredAt: new Date(now.getTime() + (index + 3) * 60_000) };
        expect(await lifecycle.reconcile("shop-1", "sub-1", {
          activeSubscription: provider, latestLifecycleEvent: next,
        }, new Date(now.getTime() + (index + 4) * 60_000))).toBe("handled");
        expect(current.lastProviderLifecycleState).toBe(state);
        expect(current.lastSyncErrorCode).toBe("UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT");
      }

      // A real provider outage in the GENERAL scanner retains original
      // accounting provenance, error timestamp and retry eligibility.
      const providerFailure = Object.assign(new Error("Shopify 503"), { code: "UPSTREAM_503" });
      partner.getSubscriptionReconciliationSnapshot.mockRejectedValueOnce(providerFailure);
      const failed = await scanner.reconcileOnce();
      expect(failed.subscriptionErrors).toBe(1);
      expect(current.lastSyncErrorCode).toBe("UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT");
      expect(current.lastSyncErrorAt).toEqual(oldErrorAt);

      // Third pass: the same active contract cannot become ACTIVE merely
      // because Shopify is reachable again after the outage and UPDATED event.
      const again = await scanner.reconcileOnce();
      expect(again.subscriptionErrors).toBe(0);
      expect(current.status).toBe("SYNC_ERROR");
      expect(current.lastSyncErrorCode).toBe("UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT");
      expect(materialize).not.toHaveBeenCalled();
      const classified = classifySubscriptionReconciliation({
        id: "shop-1", status: "ACTIVE", reinstallPendingAt: null,
        shopifyShopId: "gid://shopify/Shop/1", onboardingCompleted: true,
        subscription: {
          id: "sub-1", status: "SYNC_ERROR", planId: "plan-1",
          pendingPlanId: null, pendingShopifyPlanHandle: null, pendingEffectiveAt: null,
          nextReconcileAt: current.nextReconcileAt as Date, billingPeriodId: "period-1",
          currentPeriodStart: cycleStart, currentPeriodEnd: cycleEnd,
          cancelAtPeriodEnd: false, lastSyncErrorCode: current.lastSyncErrorCode as string,
          lastProviderLifecycleState: current.lastProviderLifecycleState as string,
        },
      }, { subscriptionId: "sub-1", expectedNextReconcileAt: (current.nextReconcileAt as Date).toISOString() });
      expect(classified).toMatchObject({ type: "accepted", kind: "frozen-reconciliation" });
    } finally {
      incidentReport.mockRestore();
      materialize.mockRestore();
      usage.mockRestore();
    }
  });

  it("keeps a locally frozen subscription frozen when Shopify has a contract but no UNFROZEN event", async () => {
    const tx = transaction({
      id: "sub-1", status: "FROZEN", planId: "plan-1",
      currentPeriodStart: new Date("2026-09-01"), currentPeriodEnd: new Date("2026-10-01"),
    });
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    const resume = { schedule: vi.fn() };
    const result = await new ShopifySubscriptionLifecycleReconciliationService(database as never, resume).reconcile(
      "shop-1", "sub-1", {
        activeSubscription: {
          planHandle: "growth", usageEventHandles: ["unknown-charge"], pendingPlanHandle: null,
          pendingEffectiveAt: null, status: "ACTIVE", currentPeriodStart: new Date("2026-09-01"),
          currentPeriodEnd: new Date("2026-10-01"), trialEndsAt: null,
          cancelAtPeriodEnd: false, providerSubscriptionId: "provider-1", providerUsageSnapshot: [],
        },
        latestLifecycleEvent: null,
      }, now,
    );
    expect(result).toBe("handled");
    expect(tx.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ nextReconcileAt: new Date("2026-09-14T13:00:00.000Z") }),
    }));
    expect(tx.subscription.update.mock.calls.at(-1)?.[0].data).not.toHaveProperty("status");
    expect(resume.schedule).not.toHaveBeenCalled();
  });

  it.each(["missing counter", "closed period", "wrong period plan"]) (
    "rejects same-cycle unfreeze with %s instead of granting or activating",
    async (caseName) => {
      const tx = transaction({
        id: "sub-1", status: "FROZEN", planId: "plan-1", billingPeriodId: "period-1",
        currentPeriodStart: new Date("2026-09-01"), currentPeriodEnd: new Date("2026-10-01"),
        lastProviderLifecycleEventAt: null, lastProviderLifecycleEventId: null,
        ...(caseName === "closed period" ? { billingPeriod: { status: "CLOSED" } } : {}),
        ...(caseName === "wrong period plan" ? { billingPeriod: { planId: "wrong-plan" } } : {}),
      });
      if (caseName === "missing counter") tx.billingPeriodEntitlementCounter.findUnique.mockResolvedValue(null);
      tx.billingPlan.findUnique.mockResolvedValue(validPlan);
      const resume = { schedule: vi.fn() };
      const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
      const result = await new ShopifySubscriptionLifecycleReconciliationService(database as never, resume).reconcile(
        "shop-1", "sub-1", {
          activeSubscription: {
            planHandle: "growth", usageEventHandles: [], pendingPlanHandle: null,
            pendingEffectiveAt: null, status: "ACTIVE", currentPeriodStart: new Date("2026-09-01"),
            currentPeriodEnd: new Date("2026-10-01"), trialEndsAt: null,
            cancelAtPeriodEnd: false, providerSubscriptionId: "provider-1", providerUsageSnapshot: [],
          },
          latestLifecycleEvent: { ...frozen, id: "unfrozen-2", eventType: "SUBSCRIPTION_UNFROZEN", state: "UNFROZEN" },
        }, now,
      );
      expect(result).toBe("handled");
      expect(tx.subscription.update.mock.calls.at(-1)?.[0].data).toMatchObject({
        status: "SYNC_ERROR", lastSyncErrorCode: "UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT",
      });
      expect(resume.schedule).not.toHaveBeenCalled();
      expect(tx.billingPeriodEntitlementCounter.updateMany).not.toHaveBeenCalled();
    },
  );

  it("does not clear an unresolved accounting error on different-cycle unfreeze", async () => {
    const tx = transaction({
      id: "sub-1", status: "FROZEN", planId: "plan-1",
      currentPeriodStart: new Date("2026-08-01"), currentPeriodEnd: new Date("2026-09-01"),
      lastSyncErrorCode: "PRE_CLOSE_USAGE_FLUSH_FAILED",
      lastProviderLifecycleEventAt: null, lastProviderLifecycleEventId: null,
    });
    tx.billingPlan.findUnique.mockResolvedValue(validPlan);
    const resume = { schedule: vi.fn() };
    const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    const transition = vi.spyOn(ShopifyPlanChangeTransitionService.prototype, "transitionInTransaction");
    try {
      const result = await new ShopifySubscriptionLifecycleReconciliationService(database as never, resume).reconcile(
        "shop-1", "sub-1", {
          activeSubscription: {
            planHandle: "growth", usageEventHandles: [], pendingPlanHandle: null,
            pendingEffectiveAt: null, status: "ACTIVE", currentPeriodStart: new Date("2026-09-01"),
            currentPeriodEnd: new Date("2026-10-01"), trialEndsAt: null,
            cancelAtPeriodEnd: false, providerSubscriptionId: "provider-1", providerUsageSnapshot: [],
          },
          latestLifecycleEvent: { ...frozen, id: "unfrozen-3", eventType: "SUBSCRIPTION_UNFROZEN", state: "UNFROZEN" },
        }, now,
      );
      expect(result).toBe("handled");
      expect(tx.subscription.update.mock.calls.at(-1)?.[0].data).toMatchObject({ status: "SYNC_ERROR" });
      expect(tx.subscription.update.mock.calls.at(-1)?.[0].data.lastSyncErrorCode).toBe("UNFREEZE_PRE_CLOSE_USAGE_FLUSH_FAILED");
      expect(transition).not.toHaveBeenCalled();
      expect(resume.schedule).not.toHaveBeenCalled();
    } finally {
      transition.mockRestore();
    }
  });

});

describe("frozen admission and verified unfreeze repair", () => {
  const cycleStart = new Date("2026-09-01T00:00:00.000Z");
  const cycleEnd = new Date("2026-10-01T00:00:00.000Z");
  const provider = {
    planHandle: "growth", usageEventHandles: [], pendingPlanHandle: null, pendingEffectiveAt: null,
    status: "ACTIVE" as const, currentPeriodStart: cycleStart, currentPeriodEnd: cycleEnd,
    trialEndsAt: null, cancelAtPeriodEnd: false, providerSubscriptionId: "provider-1", providerUsageSnapshot: [],
  };
  const updated = {
    ...frozen, id: "event-updated", occurredAt: new Date("2026-09-14T11:30:00.000Z"),
    eventType: "SUBSCRIPTION_UPDATED" as const, state: "UPDATED" as const,
  };
  const unfrozen = {
    ...frozen, id: "event-unfrozen-repaired", occurredAt: new Date("2026-09-14T11:45:00.000Z"),
    eventType: "SUBSCRIPTION_UNFROZEN" as const, state: "UNFROZEN" as const,
  };

  it.each(["UPDATED", "CREATED", "CANCELLATION_SCHEDULED"])(
    "does not activate a locally frozen subscription from a %s provider event",
    async (state) => {
      const tx = transaction({
        status: "FROZEN", planId: "plan-1", billingPeriodId: "period-1",
        lastProviderLifecycleEventAt: frozen.occurredAt, lastProviderLifecycleEventId: frozen.id,
      });
      const database = { $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) };
      const outcome = await new ShopifySubscriptionLifecycleReconciliationService(database as never).reconcile(
        "shop-1", "sub-1", { activeSubscription: provider,
          latestLifecycleEvent: {
            ...updated,
            state: state as "UPDATED" | "CREATED" | "CANCELLATION_SCHEDULED",
            eventType: (state === "UPDATED" ? "SUBSCRIPTION_UPDATED"
              : state === "CREATED" ? "SUBSCRIPTION_CREATED" : "SUBSCRIPTION_CANCELLATION_SCHEDULED") as typeof updated.eventType,
          } }, now,
      );
      expect(outcome).toBe("handled");
      expect(tx.subscription.update.mock.calls.at(-1)?.[0].data).toMatchObject({
        nextReconcileAt: new Date("2026-09-14T13:00:00.000Z"),
      });
      expect(tx.subscription.update.mock.calls.at(-1)?.[0].data.status).toBeUndefined();
      expect(tx.billingPlan.findUnique).not.toHaveBeenCalled();
      expect(tx.billingPeriod.updateMany).not.toHaveBeenCalled();
    },
  );

  it("preserves the blocked accounting error through a new FROZEN event, UPDATED and live-contract rechecks", async () => {
    const tx = transaction({
      id: "sub-1", status: "SYNC_ERROR", lastSyncErrorCode: "UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT",
      planId: "plan-1", lastProviderLifecycleEventAt: new Date("2026-09-14T10:00:00.000Z"),
      lastProviderLifecycleEventId: "old-unfreeze", nextReconcileAt: now,
    });
    const current = await tx.subscription.findUnique();
    tx.subscription.findUnique.mockImplementation(async () => current);
    tx.subscription.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(current, data);
      return current;
    });
    const database = { $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) };
    const lifecycle = new ShopifySubscriptionLifecycleReconciliationService(database as never);
    const freshFreeze = { ...frozen, id: "new-frozen" };
    expect(await lifecycle.reconcile("shop-1", "sub-1", {
      activeSubscription: provider, latestLifecycleEvent: freshFreeze,
    }, now)).toBe("handled");
    expect(current).toMatchObject({ status: "FROZEN", lastSyncErrorCode: "UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT" });

    expect(await lifecycle.reconcile("shop-1", "sub-1", {
      activeSubscription: provider, latestLifecycleEvent: updated,
    }, new Date(now.getTime() + 10_000))).toBe("handled");
    expect(current).toMatchObject({ status: "FROZEN", lastSyncErrorCode: "UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT" });

    expect(await lifecycle.reconcile("shop-1", "sub-1", {
      activeSubscription: provider, latestLifecycleEvent: null,
    }, new Date(now.getTime() + 20_000))).toBe("handled");
    expect(current).toMatchObject({ status: "FROZEN", lastSyncErrorCode: "UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT" });
    expect(tx.billingPlan.findUnique).not.toHaveBeenCalled();
  });

  function repairedTransaction(errorCode: string) {
    const tx = transaction({
      id: "sub-1", status: "SYNC_ERROR", lastSyncErrorCode: errorCode,
      planId: "plan-1", billingPeriodId: "period-1", observedShopifyPlanHandle: "growth",
      currentPeriodStart: cycleStart, currentPeriodEnd: cycleEnd,
      lastProviderLifecycleEventAt: frozen.occurredAt, lastProviderLifecycleEventId: frozen.id,
      billingPeriod: {
        id: "period-1", shopId: "shop-1", subscriptionId: "sub-1", planId: "plan-1",
        shopifyPlanHandleSnapshot: "growth", planKindSnapshot: "PAID_METERED",
        includedRecoveryCreditsGranted: 100, status: "OPEN",
        periodStart: cycleStart, periodEnd: cycleEnd,
      },
    });
    tx.billingPlan.findUnique.mockResolvedValue(validPlan);
    tx.billingPeriodEntitlementCounter.findUnique.mockResolvedValue({
      id: "counter-1", shopId: "shop-1", billingPeriodId: "period-1",
      grantedQuantity: 100, committedQuantity: 20, reservedQuantity: 3, forfeitedQuantity: 0,
    });
    tx.usageReservation.aggregate.mockResolvedValue({ _sum: { quantity: 3 } });
    return tx;
  }

  it("does not clear a repaired-period error when outstanding reservations disagree with the counter", async () => {
    const tx = repairedTransaction("UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT");
    tx.usageReservation.aggregate.mockResolvedValue({ _sum: { quantity: 2 } });
    const database = { $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) };
    const outcome = await new ShopifySubscriptionLifecycleReconciliationService(database as never).reconcile(
      "shop-1", "sub-1", { activeSubscription: provider, latestLifecycleEvent: unfrozen }, now,
    );
    expect(outcome).toBe("handled");
    expect(tx.usageReservation.aggregate).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        billingPeriodEntitlementCounterId: "counter-1",
        status: { in: ["RESERVED", "AMBIGUOUS"] },
      }),
    }));
    expect(tx.subscription.update.mock.calls.at(-1)?.[0].data).toMatchObject({
      status: "SYNC_ERROR", lastSyncErrorCode: "UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT",
    });
    expect(tx.billingPeriodEntitlementCounter.updateMany).not.toHaveBeenCalled();
  });

  it("restores a blocked subscription only after the original paid-period invariant is repaired and UNFROZEN evidence is supplied", async () => {
    const tx = repairedTransaction("UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT");
    const database = { $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) };
    const outcome = await new ShopifySubscriptionLifecycleReconciliationService(database as never).reconcile(
      "shop-1", "sub-1", { activeSubscription: provider, latestLifecycleEvent: unfrozen }, now,
    );
    expect(outcome).toBe("restored");
    expect(tx.subscription.update.mock.calls.at(-1)?.[0].data).toMatchObject({
      status: "ACTIVE", lastSyncErrorCode: null, lastSyncErrorAt: null,
    });
    expect(tx.billingPeriodEntitlementCounter.updateMany).not.toHaveBeenCalled();
    expect(tx.usageReservation.updateMany).not.toHaveBeenCalled();
  });

  it("revalidates an administratively repaired period after a later UPDATED event without demanding a duplicate UNFROZEN event", async () => {
    const tx = repairedTransaction("UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT");
    const database = { $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) };
    const outcome = await new ShopifySubscriptionLifecycleReconciliationService(database as never).reconcile(
      "shop-1", "sub-1", { activeSubscription: provider, latestLifecycleEvent: updated }, now,
    );
    expect(outcome).toBe("restored");
    expect(tx.billingPeriodEntitlementCounter.findUnique).toHaveBeenCalledOnce();
    expect(tx.subscription.update.mock.calls.at(-1)?.[0].data).toMatchObject({
      status: "ACTIVE", lastSyncErrorCode: null, lastSyncErrorAt: null,
    });
    expect(tx.billingPeriodEntitlementCounter.updateMany).not.toHaveBeenCalled();
    expect(tx.usageReservation.updateMany).not.toHaveBeenCalled();
  });

  it("preserves a pre-close usage-flush accounting block when Shopify returns an unknown plan", async () => {
    const tx = repairedTransaction("UNFREEZE_PRE_CLOSE_USAGE_FLUSH_FAILED");
    tx.billingPlan.findUnique.mockResolvedValue(null);
    const database = {
      billingPlan: tx.billingPlan, merchantPricingPlan: tx.merchantPricingPlan,
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const outcome = await new ShopifySubscriptionLifecycleReconciliationService(database as never).reconcile(
      "shop-1", "sub-1", { activeSubscription: { ...provider, planHandle: "unregistered" }, latestLifecycleEvent: unfrozen }, now,
    );
    expect(outcome).toBe("handled");
    expect(tx.subscription.update.mock.calls.at(-1)?.[0].data).toMatchObject({
      status: "SYNC_ERROR", lastSyncErrorCode: "UNFREEZE_PRE_CLOSE_USAGE_FLUSH_FAILED",
      observedShopifyPlanHandle: "unregistered",
    });
    expect(tx.billingPeriod.updateMany).not.toHaveBeenCalled();
    expect(tx.usageReservation.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    "UNFREEZE_LIFETIME_FREE_COUNTER_HISTORY_CONFLICT",
    "UNFREEZE_PRE_CLOSE_USAGE_FLUSH_FAILED",
  ])("does not clear %s from a healthy-looking period and Shopify's active status alone", async (errorCode) => {
    const tx = repairedTransaction(errorCode);
    const database = { $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) };
    const outcome = await new ShopifySubscriptionLifecycleReconciliationService(database as never).reconcile(
      "shop-1", "sub-1", { activeSubscription: provider, latestLifecycleEvent: unfrozen }, now,
    );
    expect(outcome).toBe("handled");
    expect(tx.subscription.update.mock.calls.at(-1)?.[0].data).toMatchObject({
      status: "SYNC_ERROR", lastSyncErrorCode: errorCode,
    });
  });
});
