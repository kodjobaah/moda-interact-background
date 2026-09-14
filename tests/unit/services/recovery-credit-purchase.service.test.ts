import { describe, expect, it, vi } from "vitest";

import { RecoveryCreditPurchaseService } from "../../../src/services/recovery-credit-purchase.service.js";

function harness(candidates = [
  { id: "purchase-1", creditsGranted: 5, createdAt: new Date("2026-09-08T10:00:00.000Z") },
]) {
  const purchases = candidates.map((purchase, index) => ({ ...purchase, shopId: "shop-1", planId: "plan-1", billingPeriodId: "period-1", shopifyPlanHandleSnapshot: "pro-2026", shopifyEventHandleSnapshot: "pack-meter", providerSubscriptionIdSnapshot: "subscription-1", providerUsageQuantityBeforeSnapshot: 2, providerUsageCostBeforeSnapshot: "10.00", providerUsageCostCurrencyBeforeSnapshot: "USD", status: "REQUESTED", currentAmount: 0, reservedAmount: 0, version: 0, providerUsageQuantityAfterSnapshot: null, providerPurchaseAmount: null, providerValuationConfirmedAt: null, usageEvent: { shopId: "shop-1", shopifyEventHandle: "pack-meter", metric: "RECOVERY_CREDIT_PACK_PURCHASE", quantity: 1, shopifyReportState: "REPORTED", billingPeriodId: "period-1" }, index }));
  const counter = { grantedQuantity: 0 };
  const transaction = {
    recoveryCreditPurchase: {
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => purchases.filter((purchase) => matches(purchase, where)).length),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => purchases.filter((purchase) => matches(purchase, where))),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const purchase = purchases.find((candidate) => candidate.id === where.id && candidate.status === where.status && candidate.version === where.version && candidate.currentAmount === where.currentAmount && candidate.reservedAmount === where.reservedAmount);
        if (!purchase) return { count: 0 };
        Object.assign(purchase, data, {
          providerUsageCostAfterSnapshot: data.providerUsageCostAfterSnapshot?.toString() ?? null,
          providerPurchaseAmount: data.providerPurchaseAmount?.toString() ?? null,
          version: (data.version as { increment: number }).increment + purchase.version,
        });
        return { count: 1 };
      }),
    },
    shopEntitlementCounter: {
      upsert: vi.fn(async ({ create, update }: { create: { grantedQuantity: number }; update: { grantedQuantity: { increment: number } } }) => {
        counter.grantedQuantity += update?.grantedQuantity?.increment ?? create.grantedQuantity;
        return counter;
      }),
    },
  };
  const database = { ...transaction, $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)) };
  return { service: new RecoveryCreditPurchaseService(database as never, 3, () => new Date("2026-09-08T12:00:00.000Z")), database, purchases, counter };
}

function matches(purchase: Record<string, any>, where: Record<string, any>) {
  const usageWhere = where.usageEvent?.is ?? where.usageEvent;
  return purchase.status === where.status
    && purchase.shopId === where.shopId
    && purchase.billingPeriodId === where.billingPeriodId
    && purchase.shopifyPlanHandleSnapshot === where.shopifyPlanHandleSnapshot
    && purchase.shopifyEventHandleSnapshot === where.shopifyEventHandleSnapshot
    && purchase.usageEvent.shopId === usageWhere.shopId
    && purchase.usageEvent.shopifyEventHandle === usageWhere.shopifyEventHandle
    && purchase.usageEvent.metric === usageWhere.metric
    && purchase.usageEvent.quantity === usageWhere.quantity
    && purchase.usageEvent.shopifyReportState === usageWhere.shopifyReportState
    && purchase.usageEvent.billingPeriodId === usageWhere.billingPeriodId;
}

const input = { shopId: "shop-1", billingPeriodId: "period-1", providerPlanHandle: "pro-2026", packMeterHandle: "pack-meter", providerSubscriptionId: "subscription-1", providerUnits: 3, providerCostAmount: "12.50", providerCostCurrency: "USD" };

describe("RecoveryCreditPurchaseService", () => {
  it("activates one equivalent provider-confirmed unit deterministically", async () => {
    const test = harness();
    await expect(test.service.reconcileProviderConfirmed(input)).resolves.toMatchObject({ activatedCount: 1, confirmedDelta: 1, discrepancy: null });
    expect(test.purchases[0]?.status).toBe("ACTIVE");
    expect(test.purchases[0]).toMatchObject({
      currentAmount: 5,
      reservedAmount: 0,
      providerUsageQuantityAfterSnapshot: 3,
      providerUsageCostAfterSnapshot: "12.5",
      providerUsageCostCurrencyAfterSnapshot: "USD",
      providerPurchaseAmount: "2.5",
      providerPurchaseCurrency: "USD",
      providerValuationConfirmedAt: new Date("2026-09-08T12:00:00.000Z"),
      activatedAt: new Date("2026-09-08T12:00:00.000Z"),
      version: 1,
    });
    expect(test.counter.grantedQuantity).toBe(5);
  });

  it("uses the purchase snapshot scope, not only the linked event scope", async () => {
    for (const change of [
      { billingPeriodId: "period-other" },
      { shopifyPlanHandleSnapshot: "pro-other" },
      { shopifyEventHandleSnapshot: "other-meter" },
    ]) {
      const test = harness();
      Object.assign(test.purchases[0]!, change);

      await expect(test.service.reconcileProviderConfirmed(input)).resolves.toMatchObject({
        activatedCount: 0,
        discrepancy: { kind: "over" },
      });
      expect(test.purchases[0]).toMatchObject({ status: "REQUESTED", currentAmount: 0 });
      expect(test.counter.grantedQuantity).toBe(0);
    }
  });

  it("runs activation at Serializable isolation with the aggregate grant in the same transaction", async () => {
    const test = harness();

    await test.service.reconcileProviderConfirmed(input);

    expect(test.database.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: "Serializable" },
    );
    expect(test.counter.grantedQuantity).toBe(5);
  });

  it("does not derive the stored purchase amount from a plan price", async () => {
    const test = harness();
    test.purchases[0]!.providerPriceSnapshot = { amount: "999.00", currency: "USD" };

    await expect(test.service.reconcileProviderConfirmed(input)).resolves.toMatchObject({ activatedCount: 1 });

    expect(test.purchases[0]).toMatchObject({ providerPurchaseAmount: "2.5" });
  });

  it("does not alter an activated purchase when a later plan handle is observed", async () => {
    const test = harness();
    await test.service.reconcileProviderConfirmed(input);
    const storedAmount = test.purchases[0]?.providerPurchaseAmount;
    const storedCurrency = test.purchases[0]?.providerPurchaseCurrency;

    await expect(test.service.reconcileProviderConfirmed({
      ...input,
      providerPlanHandle: "pro-2027",
      providerCostAmount: "30.00",
    })).resolves.toMatchObject({ activatedCount: 0 });

    expect(test.purchases[0]).toMatchObject({
      providerPurchaseAmount: storedAmount,
      providerPurchaseCurrency: storedCurrency,
      status: "ACTIVE",
    });
  });

  it("does not grant twice when the provider quantity is replayed", async () => {
    const test = harness();
    await test.service.reconcileProviderConfirmed(input);
    await expect(test.service.reconcileProviderConfirmed(input)).resolves.toMatchObject({ activatedCount: 0, alreadyMatchedUnits: 1, confirmedDelta: 0 });
    expect(test.counter.grantedQuantity).toBe(5);
  });

  it("does not attribute one provider delta across multiple unresolved purchases", async () => {
    const test = harness();
    test.purchases.push({ ...test.purchases[0]!, id: "purchase-2" });
    await expect(test.service.reconcileProviderConfirmed(input)).resolves.toMatchObject({ activatedCount: 0, discrepancy: { kind: "ambiguous" } });
    expect(test.counter.grantedQuantity).toBe(0);
  });

  it("fails closed when a partial confirmation crosses different pack values", async () => {
    const test = harness();
    await expect(test.service.reconcileProviderConfirmed({ ...input, providerCostAmount: "10.00" })).resolves.toMatchObject({ activatedCount: 0, discrepancy: { kind: "ambiguous" } });
    expect(test.counter.grantedQuantity).toBe(0);
  });

  it("reports provider under- and over-counts without revoking or fabricating", async () => {
    const test = harness();
    await expect(test.service.reconcileProviderConfirmed({ ...input, providerCostAmount: null })).resolves.toMatchObject({ activatedCount: 0, discrepancy: { kind: "ambiguous" } });
  });

  it("does not regrant a locally partially refunded active purchase", async () => {
    const test = harness();
    test.purchases[0]!.status = "ACTIVE";

    await expect(test.service.reconcileProviderConfirmed(input))
      .resolves.toMatchObject({ alreadyMatchedUnits: 1, eligibleCandidateCount: 0, activatedCount: 0 });
    expect(test.counter.grantedQuantity).toBe(0);
  });

  it("fails closed for invalid provider quantities", async () => {
    const test = harness();
    await expect(test.service.reconcileProviderConfirmed({ ...input, providerUnits: Number.NaN })).resolves.toMatchObject({ activatedCount: 0, discrepancy: { kind: "invalid-provider-units" } });
  });

  it.each([
    ["non-REPORTED", { shopifyReportState: "PENDING" }],
    ["wrong billing period", { billingPeriodId: "period-other" }],
    ["wrong meter", { shopifyEventHandle: "other-meter" }],
    ["null meter", { shopifyEventHandle: null }],
    ["wrong shop", { shopId: "shop-other" }],
  ])("does not consume a %s linked UsageEvent", (_label, usageEvent) => {
    const test = harness([
      { id: "purchase-1", creditsGranted: 5, createdAt: new Date("2026-09-08T10:00:00.000Z") },
    ]);
    Object.assign(test.purchases[0]!.usageEvent, usageEvent);
    return expect(test.service.reconcileProviderConfirmed(input))
      .resolves.toMatchObject({ activatedCount: 0, eligibleCandidateCount: 0, discrepancy: { kind: "over" } });
  });

  it("fails closed when provider currency or subscription does not match", async () => {
    for (const change of [{ providerSubscriptionId: "other" }, { providerCostCurrency: "EUR" }]) {
      const test = harness();
      await expect(test.service.reconcileProviderConfirmed({ ...input, ...change })).resolves.toMatchObject({ activatedCount: 0, discrepancy: { kind: "ambiguous" } });
    }
  });
});
