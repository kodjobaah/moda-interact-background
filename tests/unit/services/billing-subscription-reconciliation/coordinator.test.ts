import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BillingSubscriptionReconciliationService,
  createSubscriptionReconcilePayload,
} from "../../../../src/services/billing-subscription-reconciliation.service.js";
import { BillingCycleReconciliationService } from "../../../../src/services/billing-subscription-reconciliation/billing-cycle-reconciliation.service.js";
import { EstablishedPlanChangeReconciliationService } from "../../../../src/services/billing-subscription-reconciliation/established-plan-change-reconciliation.service.js";
import { InitialActivationReconciliationService } from "../../../../src/services/billing-subscription-reconciliation/initial-activation-reconciliation.service.js";
import { ReinstallReconciliationService } from "../../../../src/services/billing-subscription-reconciliation/reinstall-reconciliation.service.js";
import { ShopifySubscriptionLifecycleReconciliationService } from "../../../../src/services/shopify-subscription-lifecycle-reconciliation.service.js";

const now = new Date("2026-09-12T12:00:00.000Z");
const runtimeConfig = {
  billingFrozenRecheckSeconds: 900,
  billingProviderRetrySeconds: 300,
  shopifyUsagePublishBatchSize: 50,
  shopifyUsageRetryBaseSeconds: 60,
  shopifyUsageRetryMaxSeconds: 3600,
};
const provider = {
  planHandle: "provider-plan",
  usageEventHandles: [],
  pendingPlanHandle: null,
  pendingEffectiveAt: null,
  status: "ACTIVE" as const,
  currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
  currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
  trialEndsAt: null,
  cancelAtPeriodEnd: false,
  providerSubscriptionId: "provider-subscription-1",
  providerUsageSnapshot: [],
};
const currentPlan = {
  id: "plan-current",
  active: true,
  name: "Current",
  kind: "PAID_METERED",
  shopifyPlanHandle: "current-plan",
  recoveryCreditPackEnabled: false,
  shopifyUsageEventHandle: "usage-current",
  shopifyRecoveryCreditPackEventHandle: null,
  includedRecoveryConversationAllowance: 25,
};

function initialRow() {
  return {
    id: "shop-1",
    status: "ACTIVE",
    reinstallPendingAt: null,
    shopifyShopId: "gid://shopify/Shop/1",
    settings: { onboardingCompleted: false },
    subscription: {
      id: "subscription-1",
      status: "NO_CONTRACT",
      planId: null,
      pendingPlanId: "plan-pending",
      pendingShopifyPlanHandle: "provider-plan",
      pendingEffectiveAt: now,
      nextReconcileAt: now,
      billingPeriodId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      lastSyncErrorCode: null,
    },
  };
}

function cycleRow() {
  return {
    ...initialRow(),
    settings: { onboardingCompleted: true },
    subscription: {
      ...initialRow().subscription,
      status: "ACTIVE",
      planId: "plan-current",
      pendingPlanId: null,
      pendingShopifyPlanHandle: null,
      pendingEffectiveAt: null,
      billingPeriodId: null,
    },
  };
}

function rolloverRow(status = "ACTIVE") {
  return {
    ...cycleRow(),
    subscription: {
      ...cycleRow().subscription,
      status,
      billingPeriodId: "period-current",
      currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
    },
  };
}

function establishedRow() {
  return {
    ...rolloverRow(),
    subscription: {
      ...rolloverRow().subscription,
      pendingPlanId: "plan-target",
      pendingShopifyPlanHandle: "provider-plan",
      pendingEffectiveAt: new Date("2026-09-10T00:00:00.000Z"),
    },
  };
}

function reinstallRow() {
  return {
    ...rolloverRow(),
    status: "UNINSTALLED",
    reinstallPendingAt: new Date("2026-09-10T00:00:00.000Z"),
  };
}

function projectSelected(value: any, select: any): any {
  if (!value || !select) return value;
  return Object.fromEntries(Object.entries(select).flatMap(([key, selection]) => {
    if (!selection) return [];
    if (selection === true) return [[key, value[key]]];
    return [[key, projectSelected(value[key], (selection as any).select)]];
  }));
}

function harness({
  row = initialRow(),
  snapshot = { activeSubscription: provider, latestLifecycleEvent: null },
  plansById = { "plan-current": currentPlan },
  plansByHandle = { "provider-plan": { ...currentPlan, id: "plan-pending", kind: "FREE" } },
  providerError,
  committedNextReconcileAt = new Date("2026-09-12T12:15:00.000Z"),
}: {
  row?: any;
  snapshot?: any;
  plansById?: Record<string, any>;
  plansByHandle?: Record<string, any>;
  providerError?: Error;
  committedNextReconcileAt?: Date | null;
} = {}) {
  const order: string[] = [];
  const shopFindUnique = vi.fn(async ({ select }: any) => {
    order.push("shop-context");
    return projectSelected(row, select);
  });
  const planFindUnique = vi.fn(async ({ where }: any) => {
    order.push("plan-context");
    return where.id ? plansById[where.id] ?? null : plansByHandle[where.shopifyPlanHandle] ?? null;
  });
  const subscriptionFindUnique = vi.fn().mockResolvedValue({ nextReconcileAt: committedNextReconcileAt });
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    subscription: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  };
  const database = {
    shop: { findUnique: shopFindUnique, findMany: vi.fn().mockResolvedValue([]) },
    billingPlan: { findUnique: planFindUnique },
    subscription: {
      findUnique: subscriptionFindUnique,
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn(async (callback: (transaction: any) => unknown) => callback(transaction)),
  };
  const partner = {
    getActiveSubscription: vi.fn().mockResolvedValue(snapshot.activeSubscription),
    getSubscriptionReconciliationSnapshot: vi.fn().mockImplementation(async () => {
      order.push("provider-snapshot");
      if (providerError) throw providerError;
      return snapshot;
    }),
  };
  const queue = { add: vi.fn().mockResolvedValue({}) };
  const logger = {
    error: vi.fn((eventName: string) => order.push(`log:${eventName}`)),
    warn: vi.fn((eventName: string) => order.push(`log:${eventName}`)),
    info: vi.fn((eventName: string) => order.push(`log:${eventName}`)),
  };
  const runtimeConfigReader = {
    current: vi.fn(() => {
      order.push("runtime-config");
      return runtimeConfig;
    }),
  };
  const service = new BillingSubscriptionReconciliationService(
    database as never,
    partner,
    queue,
    logger as never,
    () => now,
    runtimeConfigReader,
  );
  return { order, database, partner, queue, logger, runtimeConfigReader, service };
}

afterEach(() => vi.restoreAllMocks());

describe("billing reconciliation coordinator", () => {
  it("parses malformed input before runtime config, database, or provider access", async () => {
    const test = harness();

    await expect(test.service.reconcileJob({ shopId: "shop-1" })).rejects.toThrow();

    expect(test.runtimeConfigReader.current).not.toHaveBeenCalled();
    expect(test.database.shop.findUnique).not.toHaveBeenCalled();
    expect(test.partner.getSubscriptionReconciliationSnapshot).not.toHaveBeenCalled();
  });

  it("captures runtime config once after parse and reuses one normal provider snapshot", async () => {
    const test = harness();
    const completeFree = vi.spyOn(InitialActivationReconciliationService.prototype, "completeVerifiedFree")
      .mockResolvedValue(undefined);

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now));

    expect(test.order.indexOf("runtime-config")).toBeLessThan(test.order.indexOf("shop-context"));
    expect(test.order.indexOf("shop-context")).toBeLessThan(test.order.indexOf("provider-snapshot"));
    expect(test.order.slice(0, 7)).toEqual([
      "runtime-config",
      "log:billing.subscription_reconciliation.job_received",
      "shop-context",
      "log:billing.subscription_reconciliation.job_accepted",
      "log:billing.subscription_reconciliation.provider_snapshot_requested",
      "provider-snapshot",
      "log:billing.subscription_reconciliation.provider_snapshot_received",
    ]);
    expect(test.runtimeConfigReader.current).toHaveBeenCalledOnce();
    expect(test.partner.getSubscriptionReconciliationSnapshot).toHaveBeenCalledExactlyOnceWith("gid://shopify/Shop/1");
    expect(completeFree).toHaveBeenCalledOnce();
      expect(test.logger.info.mock.calls.map(([eventName]) => eventName)).toEqual([
        "billing.subscription_reconciliation.job_received",
        "billing.subscription_reconciliation.job_accepted",
        "billing.subscription_reconciliation.provider_snapshot_requested",
        "billing.subscription_reconciliation.provider_snapshot_received",
      ]);
      expect(test.logger.info).toHaveBeenNthCalledWith(1, "billing.subscription_reconciliation.job_received", {
        shopId: "shop-1",
        subscriptionId: "subscription-1",
        expectedNextReconcileAt: now.toISOString(),
      });
      expect(test.logger.info).toHaveBeenNthCalledWith(3, "billing.subscription_reconciliation.provider_snapshot_requested", {
        shopId: "shop-1",
        subscriptionId: "subscription-1",
        kind: "initial-activation",
      });
      expect(test.logger.info).toHaveBeenNthCalledWith(4, "billing.subscription_reconciliation.provider_snapshot_received", {
        shopId: "shop-1",
        subscriptionId: "subscription-1",
        kind: "initial-activation",
        hasActiveSubscription: true,
        providerPlanHandle: provider.planHandle,
        hasLifecycleEvent: false,
      });
  });

  it.each([
    ["cycle-discovery", cycleRow(), { ...currentPlan, kind: "FREE", active: false, recoveryCreditPackEnabled: true }, "cycle-discovery-plan-ineligible"],
    ["rollover", rolloverRow(), { ...currentPlan, kind: "FREE", active: true, recoveryCreditPackEnabled: false }, "rollover-plan-ineligible"],
  ])("keeps the %s plan eligibility gate provider-free", async (_kind, row, plan, reason) => {
    const test = harness({ row, plansById: { "plan-current": plan } });

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now));

    expect(test.partner.getSubscriptionReconciliationSnapshot).not.toHaveBeenCalled();
    expect(test.logger.info).toHaveBeenCalledWith("billing.subscription_reconciliation.job_skipped", expect.objectContaining({
      reason,
      currentPlanKind: plan.kind,
      currentPlanActive: plan.active,
    }));
  });

  it("does not add a plan eligibility gate to established plan changes", async () => {
    const test = harness({
      row: establishedRow(),
      plansById: { "plan-current": { ...currentPlan, active: false } },
      snapshot: { activeSubscription: null, latestLifecycleEvent: null },
    });
    const retry = vi.spyOn(EstablishedPlanChangeReconciliationService.prototype, "recordRetry")
      .mockResolvedValue(undefined);

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now));

    expect(test.partner.getSubscriptionReconciliationSnapshot).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledWith("shop-1", expect.objectContaining({ currentPlanId: "plan-current" }), "PROVIDER_STATE_UNRESOLVED");
  });

  it.each(["handled", "restored"] as const)("republishes the committed schedule after lifecycle %s", async (result) => {
    const test = harness({ row: rolloverRow("FROZEN"), snapshot: {
      activeSubscription: provider,
      latestLifecycleEvent: { id: "event-1", eventType: "SUBSCRIPTION_UNFROZEN", state: "UNFROZEN", occurredAt: now },
    } });
    const reconcile = vi.spyOn(ShopifySubscriptionLifecycleReconciliationService.prototype, "reconcile")
      .mockResolvedValue(result);

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now));

    expect(reconcile).toHaveBeenCalledWith("shop-1", "subscription-1", expect.anything(), now);
    expect(reconcile.mock.calls[0][0]).toBe("shop-1");
    expect(test.database.subscription.findUnique).toHaveBeenCalledWith({
      where: { id: "subscription-1" },
      select: { nextReconcileAt: true },
    });
    expect(test.queue.add).toHaveBeenCalledOnce();
    expect(test.queue.add.mock.calls[0][1].expectedNextReconcileAt).toBe("2026-09-12T12:15:00.000Z");
    expect(test.partner.getSubscriptionReconciliationSnapshot).toHaveBeenCalledOnce();
  });

  it("preserves provider-present FROZEN continue fallthrough to applyOtherCurrentPlan", async () => {
    const frozen = rolloverRow("FROZEN");
    const test = harness({
      row: frozen,
      plansById: { "plan-current": { ...currentPlan, active: false, kind: "FREE", recoveryCreditPackEnabled: false } },
    });
    vi.spyOn(ShopifySubscriptionLifecycleReconciliationService.prototype, "reconcile")
      .mockResolvedValue("continue");
    const applyOther = vi.spyOn(InitialActivationReconciliationService.prototype, "applyOtherCurrentPlan")
      .mockResolvedValue(undefined);

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now));

    expect(applyOther).toHaveBeenCalledOnce();
    const expected = applyOther.mock.calls[0][6];
    expect(expected).toEqual({
      subscriptionId: "subscription-1",
      currentPlanId: "plan-current",
      billingPeriodId: "period-current",
      currentPeriodStart: frozen.subscription.currentPeriodStart,
      currentPeriodEnd: frozen.subscription.currentPeriodEnd,
      nextReconcileAt: now,
    });
    expect(expected).not.toHaveProperty("pendingPlanId");
    expect(test.partner.getSubscriptionReconciliationSnapshot).toHaveBeenCalledOnce();
  });

  it("preserves provider-null FROZEN continue dispatch to recordMissingSubscription without a new job", async () => {
    const frozen = rolloverRow("FROZEN");
    const test = harness({
      row: frozen,
      plansById: { "plan-current": { ...currentPlan, active: false, kind: "FREE", recoveryCreditPackEnabled: false } },
      snapshot: { activeSubscription: null, latestLifecycleEvent: null },
    });
    vi.spyOn(ShopifySubscriptionLifecycleReconciliationService.prototype, "reconcile")
      .mockResolvedValue("continue");
    const recordMissing = vi.spyOn(InitialActivationReconciliationService.prototype, "recordMissingSubscription")
      .mockResolvedValue(undefined);

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now));

    expect(recordMissing).toHaveBeenCalledOnce();
    expect(recordMissing).toHaveBeenCalledWith("shop-1", {
      subscriptionId: "subscription-1",
      currentPlanId: "plan-current",
      billingPeriodId: "period-current",
      currentPeriodStart: frozen.subscription.currentPeriodStart,
      currentPeriodEnd: frozen.subscription.currentPeriodEnd,
      nextReconcileAt: now,
    });
    expect(test.queue.add).not.toHaveBeenCalled();
    expect(test.partner.getSubscriptionReconciliationSnapshot).toHaveBeenCalledOnce();
  });

  it("routes normal provider snapshot failures to the accepted lifecycle handler", async () => {
    const failure = new Error("partner unavailable");
    const test = harness({ providerError: failure });
    const recordFailure = vi.spyOn(InitialActivationReconciliationService.prototype, "recordProviderFailure")
      .mockResolvedValue(undefined);

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now));

    expect(recordFailure).toHaveBeenCalledWith("shop-1", expect.objectContaining({
      subscriptionId: "subscription-1",
      pendingPlanId: "plan-pending",
    }), failure);
    expect(test.database.billingPlan.findUnique).not.toHaveBeenCalled();
  });

  it("delegates reinstall jobs without using the normal reconciliation snapshot", async () => {
    const row = reinstallRow();
    const test = harness({ row });
    const reconcileReinstall = vi.spyOn(ReinstallReconciliationService.prototype, "reconcileReinstall")
      .mockResolvedValue(undefined);

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now));

    expect(reconcileReinstall).toHaveBeenCalledWith("shop-1", expect.objectContaining({ subscriptionId: "subscription-1" }), row.shopifyShopId);
    expect(test.partner.getSubscriptionReconciliationSnapshot).not.toHaveBeenCalled();
    expect(test.runtimeConfigReader.current).toHaveBeenCalledOnce();
  });
});
