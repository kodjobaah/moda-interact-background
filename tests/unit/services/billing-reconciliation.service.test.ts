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
  );
  return { database, partner, publisher, purchases, logger, service };
}

describe("BillingReconciliationService", () => {
  it("B008-R1 updates the durable projection when Shopify changes plans", async () => {
    const test = harness();
    test.partner.getActiveSubscription
      .mockResolvedValueOnce({ ...providerSubscription, planHandle: "plan-a" })
      .mockResolvedValueOnce({ ...providerSubscription, planHandle: "plan-b" });
    test.database.billingPlan.findUnique.mockResolvedValue({
      id: "plan-1", active: true, kind: "PAID_METERED", shopifyUsageEventHandle: "recovery-meter",
    });

    await test.service.reconcileOnce();
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

    await test.service.reconcileOnce();

    expect(test.database.subscription.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ status: "NO_CONTRACT", planId: null }),
    }));
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

  it("does not consume an unresolved initial activation when rotation sees it current", async () => {
    const test = harness({
      partnerResult: { ...providerSubscription, planHandle: "free-2026", pendingPlanHandle: null, pendingEffectiveAt: null },
      plan: { id: "plan-free", active: true, kind: "FREE", shopifyUsageEventHandle: null, shopifyRecoveryCreditPackEventHandle: null },
    });
    test.database.shopSettings.findUnique.mockResolvedValue({ onboardingCompleted: false });
    test.database.subscription.findUnique.mockResolvedValue({
      status: "NO_CONTRACT",
      planId: null,
      pendingPlanId: "plan-free",
      pendingShopifyPlanHandle: "free-2026",
    });

    await test.service.reconcileOnce();

    expect(test.database.subscription.upsert).not.toHaveBeenCalled();
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
        lastSyncErrorCode: "PARTNER_API_ERROR",
      }),
    }));
    expect(test.database.subscription.upsert.mock.calls[0]?.[0].update).not.toHaveProperty("planId");
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
      providerUnits: 2,
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