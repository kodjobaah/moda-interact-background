import { afterEach, describe, expect, it, vi } from "vitest";
import { BillingPeriodEntitlementCounterKind, BillingPeriodStatus, BillingPlanKind } from "@prisma/client";

import { ReinstallReconciliationService } from "../../../../src/services/billing-subscription-reconciliation/reinstall-reconciliation.service.js";
import type { ReinstallExpected } from "../../../../src/services/billing-subscription-reconciliation/classification.js";
import { DiscountSyncPublisherService } from "../../../../src/services/billing-subscription-reconciliation/discount-sync-publisher.service.js";
import { ReconciliationQueueService } from "../../../../src/services/billing-subscription-reconciliation/reconciliation-queue.service.js";
import { SamePlanBillingPeriodRolloverService } from "../../../../src/services/same-plan-billing-period-rollover.service.js";
import { shopifyDiscountCatalogueService } from "../../../../src/services/shopify-discount-catalogue.service.js";

afterEach(() => vi.restoreAllMocks());

const now = new Date("2026-09-12T12:00:00.000Z");
const reinstallPendingAt = new Date("2026-09-12T11:30:00.000Z");
const nextReconcileAt = now;
const expected: ReinstallExpected = {
  subscriptionId: "subscription-1",
  reinstallPendingAt,
  nextReconcileAt,
};

const freeProvider = {
  planHandle: "free-2026",
  usageEventHandles: ["pack-meter"],
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

const paidProvider = {
  ...freeProvider,
  planHandle: "paid-2026",
  usageEventHandles: ["recovery-meter"],
};

const freePlan = {
  id: "plan-free",
  active: true,
  name: "Free",
  kind: BillingPlanKind.FREE,
  shopifyPlanHandle: "free-2026",
  shopifyUsageEventHandle: null,
  shopifyRecoveryCreditPackEventHandle: "pack-meter",
  recoveryCreditPackEnabled: true,
  includedRecoveryConversationAllowance: null,
};

const paidPlan = {
  id: "plan-paid",
  active: true,
  name: "Paid",
  kind: BillingPlanKind.PAID_METERED,
  shopifyPlanHandle: "paid-2026",
  shopifyUsageEventHandle: "recovery-meter",
  shopifyRecoveryCreditPackEventHandle: null,
  recoveryCreditPackEnabled: false,
  includedRecoveryConversationAllowance: 100,
};

function harness({
  providerResult = null,
  providerError,
  plan = null,
  current = {
    id: "subscription-1",
    planId: "plan-paid",
    observedShopifyPlanHandle: "paid-2026",
    billingPeriodId: "period-paid",
    currentPeriodStart: paidProvider.currentPeriodStart,
    currentPeriodEnd: paidProvider.currentPeriodEnd,
  },
  authority = { id: "subscription-1", nextReconcileAt },
  period = null,
  counter = null,
} = {}) {
  const events: string[] = [];
  const transaction = {
    $queryRaw: vi.fn((query: { strings?: string[] }) => {
      events.push(query.strings?.join("?") ?? "lock");
      return Promise.resolve([]);
    }),
    shop: {
      findUnique: vi.fn().mockResolvedValue({ id: "shop-1", status: "UNINSTALLED", reinstallPendingAt }),
      update: vi.fn().mockImplementation(async () => events.push("shop.update")),
    },
    shopSettings: {
      update: vi.fn().mockImplementation(async () => events.push("settings.update")),
    },
    subscription: {
      findUnique: vi.fn(({ select }: { select?: Record<string, unknown> }) => Promise.resolve(select?.planId ? current : authority)),
      update: vi.fn().mockImplementation(async () => events.push("subscription.update")),
    },
    billingPlan: { findUnique: vi.fn().mockResolvedValue(null) },
    billingPeriod: {
      findUnique: vi.fn().mockResolvedValue(period),
      create: vi.fn().mockResolvedValue({ id: "period-new" }),
      update: vi.fn(),
    },
    billingPeriodEntitlementCounter: {
      findUnique: vi.fn().mockResolvedValue(counter),
      create: vi.fn(),
      upsert: vi.fn(),
    },
    shopifyDiscountCatalogue: {
      upsert: vi.fn().mockResolvedValue({ unavailableAt: now }),
      update: vi.fn(),
    },
    shopifyDiscount: { updateMany: vi.fn() },
  };
  const database = {
    shop: { findUnique: vi.fn().mockResolvedValue({ domain: "merchant.example" }) },
    billingPlan: { findUnique: vi.fn().mockResolvedValue(plan) },
    subscription: {
      findUnique: vi.fn().mockImplementation(async () => {
        events.push("alignment.read");
        return current;
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) => callback(transaction)),
  };
  const partner = {
    getActiveSubscription: vi.fn().mockImplementation(async () => {
      if (providerError) throw providerError;
      return providerResult;
    }),
    getSubscriptionReconciliationSnapshot: vi.fn(),
  };
  const reconciliationQueue = {
    publishNext: vi.fn().mockImplementation(async () => events.push("queue.publish")),
  };
  const discountPublisher = {
    publishDiscountSync: vi.fn().mockImplementation(async () => events.push("discount.publish")),
  };
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  const service = new ReinstallReconciliationService(
    database as never,
    partner as never,
    reconciliationQueue,
    discountPublisher,
    logger as never,
    () => now,
  );
  return { database, transaction, partner, reconciliationQueue, discountPublisher, logger, service, events };
}

describe("ReinstallReconciliationService", () => {
  it("uses one direct active-subscription lookup for a no-contract reinstall and retains lock and discount transaction order", async () => {
    const test = harness();

    await test.service.reconcileReinstall("shop-1", expected, "gid://shopify/Shop/1");

    expect(test.partner.getActiveSubscription).toHaveBeenCalledOnce();
    expect(test.partner.getActiveSubscription).toHaveBeenCalledWith("gid://shopify/Shop/1");
    expect(test.partner.getSubscriptionReconciliationSnapshot).not.toHaveBeenCalled();
    expect(test.database.$transaction).toHaveBeenCalledOnce();
    expect(test.transaction.$queryRaw).toHaveBeenCalledTimes(3);
    expect(test.transaction.$queryRaw.mock.calls.map(([query]) => query.strings?.join("?") ?? "")).toEqual([
      expect.stringContaining('FROM "shopify"."Shop"'),
      expect.stringContaining('FROM "shopify"."ShopSettings"'),
      expect.stringContaining('FROM "billing"."Subscription"'),
    ]);
    expect(test.transaction.shopifyDiscountCatalogue.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ status: "UNAVAILABLE" }),
      update: expect.objectContaining({ status: "UNAVAILABLE" }),
    }));
    expect(test.transaction.shopifyDiscount.updateMany).toHaveBeenCalledTimes(2);
    expect(test.discountPublisher.publishDiscountSync).not.toHaveBeenCalled();
    expect(test.reconciliationQueue.publishNext).not.toHaveBeenCalled();
  });

  it("commits a verified Free reinstall before discount and follow-up queue publication", async () => {
    const test = harness({ providerResult: freeProvider, plan: freePlan });

    await test.service.reconcileReinstall("shop-1", expected, "gid://shopify/Shop/1");

    expect(test.transaction.billingPeriod.create).toHaveBeenCalledOnce();
    expect(test.transaction.subscription.update).toHaveBeenCalledOnce();
    expect(test.transaction.shop.update).toHaveBeenCalledOnce();
    expect(test.events.indexOf("subscription.update")).toBeLessThan(test.events.indexOf("discount.publish"));
    expect(test.events.indexOf("shop.update")).toBeLessThan(test.events.indexOf("discount.publish"));
    expect(test.discountPublisher.publishDiscountSync).toHaveBeenCalledWith("shop-1", "REINSTALL_RECONCILED");
    expect(test.reconciliationQueue.publishNext).toHaveBeenCalledWith(
      "shop-1",
      expected.subscriptionId,
      new Date("2026-09-30T23:55:00.000Z"),
    );
    expect(test.events.indexOf("discount.publish")).toBeLessThan(test.events.indexOf("queue.publish"));
  });

  it("keeps a committed Free reinstall when canonical post-commit queue publishers fail", async () => {
    const test = harness({ providerResult: freeProvider, plan: freePlan });
    const billingQueue = { add: vi.fn().mockRejectedValue(new Error("billing queue unavailable")) };
    const discountQueue = { add: vi.fn().mockRejectedValue(new Error("discount queue unavailable")) };
    const publisherLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const reconciliationQueue = new ReconciliationQueueService(test.database as never, billingQueue, publisherLogger as never, () => now);
    const discountPublisher = new DiscountSyncPublisherService(test.database as never, discountQueue, publisherLogger as never, () => now);
    vi.spyOn(shopifyDiscountCatalogueService, "requestSync").mockResolvedValue("requested");
    const service = new ReinstallReconciliationService(
      test.database as never,
      test.partner as never,
      reconciliationQueue,
      discountPublisher,
      test.logger as never,
      () => now,
    );

    await expect(service.reconcileReinstall("shop-1", expected, "gid://shopify/Shop/1")).resolves.toBeUndefined();

    expect(test.transaction.subscription.update).toHaveBeenCalledOnce();
    expect(test.transaction.shop.update).toHaveBeenCalledOnce();
    expect(discountQueue.add).toHaveBeenCalledOnce();
    expect(billingQueue.add).toHaveBeenCalledOnce();
    expect(publisherLogger.warn).toHaveBeenCalledWith("shopify.discount_sync.enqueue_failed", expect.any(Object));
    expect(publisherLogger.error).toHaveBeenCalledWith("billing.subscription_reconciliation.enqueue_failed", expect.any(Object));
  });

  it("keeps exact-cycle Paid activation behind its period and counter integrity reads", async () => {
    const existingPeriod = {
      id: "period-paid",
      shopId: "shop-1",
      subscriptionId: expected.subscriptionId,
      planId: paidPlan.id,
      periodStart: paidProvider.currentPeriodStart,
      periodEnd: paidProvider.currentPeriodEnd,
      status: BillingPeriodStatus.OPEN,
      includedRecoveryCreditsGranted: 100,
    };
    const existingCounter = {
      shopId: "shop-1",
      billingPeriodId: "period-paid",
      grantedQuantity: 100,
      committedQuantity: 12,
      reservedQuantity: 3,
      forfeitedQuantity: 1,
    };
    const test = harness({ providerResult: paidProvider, plan: paidPlan, period: existingPeriod, counter: existingCounter });

    await test.service.reconcileReinstall("shop-1", expected, "gid://shopify/Shop/1");

    expect(test.database.subscription.findUnique).toHaveBeenCalledOnce();
    expect(test.events.indexOf("alignment.read")).toBeLessThan(test.events.findIndex((event) => event.includes('FROM "shopify"."Shop"')));
    expect(test.transaction.billingPeriod.findUnique).toHaveBeenCalledWith({ where: { id: "period-paid" } });
    expect(test.transaction.billingPeriodEntitlementCounter.findUnique).toHaveBeenCalledWith({
      where: { billingPeriodId_counter: { billingPeriodId: "period-paid", counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS } },
    });
    expect(test.discountPublisher.publishDiscountSync).toHaveBeenCalledOnce();
    expect(test.reconciliationQueue.publishNext).toHaveBeenCalledOnce();
  });

  it("uses the canonical in-transaction rollover for a later Paid cycle and publishes only after commit", async () => {
    const oldStart = new Date("2026-08-01T00:00:00.000Z");
    const oldEnd = new Date("2026-09-01T00:00:00.000Z");
    const test = harness({
      providerResult: { ...paidProvider, currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z") },
      plan: paidPlan,
      current: {
        id: "subscription-1",
        planId: "plan-paid",
        observedShopifyPlanHandle: "paid-2026",
        billingPeriodId: "period-old",
        currentPeriodStart: oldStart,
        currentPeriodEnd: oldEnd,
      },
    });
    const transition = vi.spyOn(SamePlanBillingPeriodRolloverService.prototype, "transitionInTransaction").mockResolvedValue({
      kind: "transitioned",
      billingPeriodId: "period-new",
      nextReconcileAt: new Date("2026-09-30T23:55:00.000Z"),
      planKind: BillingPlanKind.PAID_METERED,
    });

    await test.service.reconcileReinstall("shop-1", expected, "gid://shopify/Shop/1");

    expect(test.database.subscription.findUnique).toHaveBeenCalledOnce();
    expect(test.database.$transaction).toHaveBeenCalledOnce();
    expect(test.transaction.$queryRaw).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledOnce();
    expect(test.events.indexOf("alignment.read")).toBeLessThan(test.events.findIndex((event) => event.includes('FROM "shopify"."Shop"')));
    expect(test.events.indexOf("shop.update")).toBeLessThan(test.events.indexOf("discount.publish"));
    expect(test.events.indexOf("discount.publish")).toBeLessThan(test.events.indexOf("queue.publish"));
    transition.mockRestore();
  });

  it("records provider transport failure with the age-based retry and preserves the reinstall marker", async () => {
    const test = harness({ providerError: new Error("provider offline") });

    await test.service.reconcileReinstall("shop-1", expected, "gid://shopify/Shop/1");

    expect(test.database.$transaction).not.toHaveBeenCalled();
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith({
      where: { id: expected.subscriptionId, nextReconcileAt },
      data: expect.objectContaining({
        lastSyncErrorCode: "PARTNER_API_ERROR",
        lastSyncErrorAt: now,
        nextReconcileAt: new Date("2026-09-12T12:05:00.000Z"),
      }),
    });
    expect(test.logger.error).toHaveBeenCalledWith("billing.subscription_reconciliation.reinstall_provider_failed", expect.objectContaining({ shopId: "shop-1" }));
    expect(test.reconciliationQueue.publishNext).toHaveBeenCalledOnce();
  });

  it("terminally blocks an unmapped plan with a schedule-guarded update", async () => {
    const test = harness({ providerResult: paidProvider, plan: null });

    await test.service.reconcileReinstall("shop-1", expected, "gid://shopify/Shop/1");

    expect(test.database.subscription.updateMany).toHaveBeenCalledWith({
      where: { id: expected.subscriptionId, nextReconcileAt },
      data: { lastSyncErrorCode: "UNMAPPED_PLAN_HANDLE", lastSyncErrorAt: now, nextReconcileAt: null },
    });
    expect(test.logger.warn).toHaveBeenCalledWith("billing.subscription_reconciliation.reinstall_blocked", {
      shopId: "shop-1",
      subscriptionId: expected.subscriptionId,
      errorCode: "UNMAPPED_PLAN_HANDLE",
    });
    expect(test.database.$transaction).not.toHaveBeenCalled();
  });

  it("does not mutate or publish when the locked reinstall authority has changed", async () => {
    const test = harness({
      authority: { id: "subscription-1", nextReconcileAt: new Date("2026-09-12T12:01:00.000Z") },
    });

    await test.service.reconcileReinstall("shop-1", expected, "gid://shopify/Shop/1");

    expect(test.transaction.subscription.update).not.toHaveBeenCalled();
    expect(test.transaction.shop.update).not.toHaveBeenCalled();
    expect(test.reconciliationQueue.publishNext).not.toHaveBeenCalled();
    expect(test.discountPublisher.publishDiscountSync).not.toHaveBeenCalled();
  });
});