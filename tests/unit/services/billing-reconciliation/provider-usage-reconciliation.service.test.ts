import { describe, expect, it, vi } from "vitest";

import { ProviderUsageReconciliationService } from "../../../../src/services/billing-reconciliation/provider-usage-reconciliation.service.js";

const providerSubscription = {
  planHandle: "pro-2026",
  usageEventHandles: ["recovery-meter"],
  pendingPlanHandle: null,
  pendingEffectiveAt: null,
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

function harness({ modaQuantity = 5 } = {}) {
  const database = {
    subscription: {
      findUnique: vi.fn().mockResolvedValue({
        billingPeriodId: "period-1",
        plan: { kind: "PAID_METERED", shopifyUsageEventHandle: "recovery-meter" },
      }),
    },
    usageEvent: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: modaQuantity } }),
    },
  };
  const purchases = {
    reconcileProviderConfirmed: vi.fn().mockResolvedValue({
      activatedCount: 1,
      alreadyMatchedUnits: 0,
      eligibleCandidateCount: 1,
      confirmedDelta: 1,
      discrepancy: null,
    }),
  };
  const logger = { warn: vi.fn() };
  const service = new ProviderUsageReconciliationService(
    database as never,
    purchases as never,
    logger as never,
  );
  return { database, purchases, logger, service };
}

describe("ProviderUsageReconciliationService", () => {
  it("activates provider-confirmed packs and reports current-cycle usage discrepancies", async () => {
    const test = harness();

    const result = await test.service.reconcile("shop-1", providerSubscription, {
      billingPeriodId: "period-1",
      packMeterHandle: "pack-meter",
    });

    expect(test.purchases.reconcileProviderConfirmed).toHaveBeenCalledWith({
      shopId: "shop-1",
      billingPeriodId: "period-1",
      providerPlanHandle: "pro-2026",
      packMeterHandle: "pack-meter",
      providerContextIdentity: "sub-1",
      providerUnits: Number.NaN,
      providerCostAmount: null,
      providerCostCurrency: null,
      providerUsageSnapshot: providerSubscription.providerUsageSnapshot,
      currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
    });
    expect(result).toEqual({
      purchasesActivated: 1,
      discrepancies: [{
        shopId: "shop-1",
        billingPeriodId: "period-1",
        meterHandle: "recovery-meter",
        modaQuantity: 5,
        shopifyQuantity: 7,
      }],
    });
    expect(test.logger.warn).toHaveBeenCalledWith(
      "billing.usage_reconciliation.discrepancy",
      expect.objectContaining({ modaQuantity: 5, shopifyQuantity: 7 }),
    );
  });

  it("surfaces an invalid scope without invoking purchase reconciliation when the provider cycle is missing", async () => {
    const test = harness();

    const result = await test.service.reconcile(
      "shop-1",
      { ...providerSubscription, currentPeriodStart: null, currentPeriodEnd: null },
      { billingPeriodId: "period-1", packMeterHandle: "pack-meter" },
    );

    expect(test.purchases.reconcileProviderConfirmed).not.toHaveBeenCalled();
    expect(test.database.subscription.findUnique).not.toHaveBeenCalled();
    expect(result).toEqual({
      purchasesActivated: 0,
      discrepancies: [{
        shopId: "shop-1",
        billingPeriodId: "period-1",
        meterHandle: "pack-meter",
        modaQuantity: 0,
        shopifyQuantity: 0,
        kind: "invalid-scope",
        detail: "Present Partner subscription has no exact current billing cycle",
      }],
    });
  });

  it("keeps purchase reconciliation independent from the retired singular pack configuration", async () => {
    const test = harness({ modaQuantity: 7 });
    const provider = {
      ...providerSubscription,
      providerUsageSnapshot: [{
        handle: "pack-meter",
        quantity: "3",
        costAmount: "20.00",
        costCurrency: "USD",
      }],
    };

    const result = await test.service.reconcile("shop-1", provider, {
      billingPeriodId: "period-1",
      packMeterHandle: null,
    });

    expect(test.purchases.reconcileProviderConfirmed).toHaveBeenCalledWith(expect.objectContaining({
      packMeterHandle: "",
      providerUnits: Number.NaN,
      providerCostAmount: null,
      providerCostCurrency: null,
      providerUsageSnapshot: provider.providerUsageSnapshot,
    }));
    expect(result.purchasesActivated).toBe(1);
  });

  it("does nothing when there is no active provider subscription", async () => {
    const test = harness();

    await expect(test.service.reconcile("shop-1", null, {
      billingPeriodId: null,
      packMeterHandle: null,
    })).resolves.toEqual({ purchasesActivated: 0, discrepancies: [] });

    expect(test.purchases.reconcileProviderConfirmed).not.toHaveBeenCalled();
    expect(test.database.subscription.findUnique).not.toHaveBeenCalled();
  });
});
