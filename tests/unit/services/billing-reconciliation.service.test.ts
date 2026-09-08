import { describe, expect, it, vi } from "vitest";

import { BillingReconciliationService } from "../../../src/services/billing-reconciliation.service.js";

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
  }],
};

function harness({
  partnerResult = providerSubscription,
  partnerError,
  plan = { id: "plan-1", active: true, kind: "PAID_METERED", shopifyUsageEventHandle: "recovery-meter" },
  modaQuantity = 5,
} = {}) {
  const subscriptionUpsert = vi.fn();
  const database = {
    shop: {
      findMany: vi.fn().mockResolvedValue([{ id: "shop-1", shopifyShopId: "gid://shopify/Shop/1" }]),
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
      findUnique: vi.fn().mockResolvedValue({
        billingPeriodId: "period-1",
        plan: { kind: "PAID_METERED", shopifyUsageEventHandle: "recovery-meter" },
      }),
    },
    usageEvent: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: modaQuantity } }),
    },
  };
  const partner = {
    getActiveSubscription: vi.fn().mockImplementation(async () => {
      if (partnerError) throw partnerError;
      return partnerResult;
    }),
  };
  const publisher = { publishDue: vi.fn().mockResolvedValue({ selected: 0, claimed: 0, reported: 0, retryable: 0, needsAttention: 0 }) };
  const purchases = { reconcilePending: vi.fn().mockResolvedValue([{ id: "purchase-1", result: { kind: "activated" } }]) };
  const logger = { warn: vi.fn(), error: vi.fn() };
  const service = new BillingReconciliationService(
    database as never,
    partner,
    publisher,
    purchases,
    logger as never,
  );
  return { database, partner, publisher, purchases, logger, service };
}

describe("BillingReconciliationService", () => {
  it("bounds the active-shop scan and keeps an unknown plan unmapped", async () => {
    const test = harness({
      plan: null,
      partnerResult: { ...providerSubscription, planHandle: "unknown-plan" },
    });

    const result = await test.service.reconcileOnce(999);

    expect(test.database.shop.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 200 }));
    expect(result).toMatchObject({ subscriptionsScanned: 1, subscriptionsSynced: 1 });
    expect(test.database.subscription.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        status: "UNMAPPED",
        observedShopifyPlanHandle: "unknown-plan",
        planId: null,
        lastSyncErrorCode: "UNMAPPED_PLAN_HANDLE",
      }),
    }));
  });

  it("preserves the mapped plan when the Partner API fails", async () => {
    const test = harness({ partnerError: new Error("Partner unavailable") });

    const result = await test.service.reconcileOnce();

    expect(result).toMatchObject({ subscriptionsScanned: 1, subscriptionsSynced: 0, subscriptionErrors: 1 });
    expect(test.database.subscription.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        status: "SYNC_ERROR",
        lastSyncErrorCode: "PARTNER_API_ERROR",
      }),
    }));
    expect(test.database.subscription.upsert.mock.calls[0]?.[0].update).not.toHaveProperty("planId");
  });

  it("reports a current-cycle usage discrepancy without creating a correction", async () => {
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
      usageEvent: { aggregate: vi.fn() },
    };
    const partner = {
      getActiveSubscription: vi.fn().mockImplementation(async (shopifyShopId: string) => {
        if (shopifyShopId.endsWith("/A")) throw new Error("temporary Partner failure");
        return null;
      }),
    };
    const publisher = { publishDue: vi.fn().mockResolvedValue({}) };
    const purchases = { reconcilePending: vi.fn().mockResolvedValue([]) };
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

    expect(partner.getActiveSubscription.mock.calls.map(([shopifyShopId]) => shopifyShopId)).toEqual([
      "gid://shopify/Shop/A",
      "gid://shopify/Shop/B",
      "gid://shopify/Shop/C",
      "gid://shopify/Shop/D",
      "gid://shopify/Shop/A",
      "gid://shopify/Shop/B",
    ]);
  });
});