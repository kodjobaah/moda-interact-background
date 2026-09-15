import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { deriveShopifyProviderContextIdentity } from "@modainteract/moda-interact-shared/billing";

import { RecoveryCreditPurchaseService } from "../../../src/services/recovery-credit-purchase.service.js";

function harness(candidates = [
  { id: "purchase-1", creditsGranted: 5, createdAt: new Date("2026-09-08T10:00:00.000Z") },
]) {
  const purchases = candidates.map((purchase, index) => ({ ...purchase, shopId: "shop-1", planId: "plan-1", billingPeriodId: "period-1", shopifyPlanHandleSnapshot: "pro-2026", shopifyEventHandleSnapshot: purchase.eventHandle ?? "pack-meter", providerSubscriptionIdSnapshot: "subscription-1", providerUsageQuantityBeforeSnapshot: purchase.beforeQuantity ?? 2, providerUsageCostBeforeSnapshot: purchase.beforeCost ?? "10.00", providerUsageCostCurrencyBeforeSnapshot: "USD", status: "REQUESTED", currentAmount: 0, reservedAmount: 0, version: 0, providerUsageQuantityAfterSnapshot: null, providerPurchaseAmount: null, providerValuationConfirmedAt: null, billingPeriod: { periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-10-01T00:00:00.000Z") }, usageEvent: { shopId: "shop-1", shopifyEventHandle: purchase.eventHandle ?? "pack-meter", metric: "RECOVERY_CREDIT_PACK_PURCHASE", quantity: 1, shopifyReportState: "REPORTED", billingPeriodId: "period-1" }, index }));
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
  return Object.entries(where).every(([key, value]) => key === "usageEvent"
    ? Object.entries(usageWhere).every(([usageKey, usageValue]) => purchase.usageEvent[usageKey] === usageValue)
    : value === undefined || purchase[key] === value);
}

const input = { shopId: "shop-1", billingPeriodId: "period-1", providerPlanHandle: "pro-2026", packMeterHandle: "pack-meter", providerContextIdentity: "subscription-1", providerUnits: 3, providerCostAmount: "12.50", providerCostCurrency: "USD" };

describe("RecoveryCreditPurchaseService", () => {
  it("activates one equivalent provider-confirmed unit deterministically", async () => {
    const test = harness();
    await expect(test.service.reconcileProviderConfirmed(input)).resolves.toMatchObject({ activatedCount: 1, confirmedDelta: 1, discrepancy: null });
    expect(test.purchases[0]?.status).toBe("ACTIVE");
    expect(test.purchases[0]).toMatchObject({
      currentAmount: 5,
      reservedAmount: 0,
      providerUsageQuantityAfterSnapshot: new Prisma.Decimal("3"),
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

  it("activates a zero-cost purchase when quantity proof is exact", async () => {
    const test = harness();
    await expect(test.service.reconcileProviderConfirmed({ ...input, providerCostAmount: "10.00" })).resolves.toMatchObject({ activatedCount: 1, discrepancy: null });
    expect(test.counter.grantedQuantity).toBe(5);
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
    for (const change of [{ providerContextIdentity: "other" }, { providerCostCurrency: "EUR" }]) {
      const test = harness();
      await expect(test.service.reconcileProviderConfirmed({ ...input, ...change })).resolves.toMatchObject({ activatedCount: 0, discrepancy: { kind: "ambiguous" } });
    }
  });

  it("activates a native App Pricing purchase only for its derived context identity", async () => {
    const test = harness();
    test.purchases[0]!.providerSubscriptionIdSnapshot = deriveShopifyProviderContextIdentity({
      providerSubscriptionId: null,
      planHandle: "pro-2026",
      currentPeriodStart: "2026-09-01T00:00:00.000Z",
      currentPeriodEnd: "2026-10-01T00:00:00.000Z",
    });

    await expect(test.service.reconcileProviderConfirmed({
      ...input,
      providerContextIdentity: test.purchases[0]!.providerSubscriptionIdSnapshot,
    })).resolves.toMatchObject({ activatedCount: 1, discrepancy: null });

    const mismatch = harness();
    mismatch.purchases[0]!.providerSubscriptionIdSnapshot = test.purchases[0]!.providerSubscriptionIdSnapshot;
    await expect(mismatch.service.reconcileProviderConfirmed({
      ...input,
      providerContextIdentity: deriveShopifyProviderContextIdentity({
        providerSubscriptionId: null,
        planHandle: "pro-2026",
        currentPeriodStart: "2026-10-01T00:00:00.000Z",
        currentPeriodEnd: "2026-11-01T00:00:00.000Z",
      }),
    })).resolves.toMatchObject({ activatedCount: 0, discrepancy: { kind: "ambiguous" } });
  });

  it("fails closed for a blank or malformed provider context identity", async () => {
    const test = harness();

    await expect(test.service.reconcileProviderConfirmed({
      ...input,
      providerContextIdentity: "   ",
    })).resolves.toMatchObject({ activatedCount: 0, discrepancy: { kind: "ambiguous" } });
  });

  it("proves a candidate from its exact snapshot handle and supports fractional baselines", async () => {
    const test = harness([{ id: "purchase-1", creditsGranted: 5, eventHandle: "recovery-meter", beforeQuantity: "1.75", beforeCost: "10.00", createdAt: new Date("2026-09-08T10:00:00.000Z") }]);

    await expect(test.service.reconcileProviderConfirmed({
      ...input,
      providerUnits: Number.NaN,
      providerUsageSnapshot: [{ handle: "recovery-meter", quantity: "2.75", costAmount: "12.50", costCurrency: "USD" }],
      currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
    })).resolves.toMatchObject({ activatedCount: 1, confirmedDelta: 1, discrepancy: null });
    expect(test.purchases[0]).toMatchObject({ providerUsageQuantityAfterSnapshot: new Prisma.Decimal("2.75"), providerPurchaseAmount: "2.5" });
  });

  it("does not fall back to another meter when the candidate handle is absent", async () => {
    const test = harness([{ id: "purchase-1", creditsGranted: 5, eventHandle: "recovery-meter", createdAt: new Date("2026-09-08T10:00:00.000Z") }]);

    await expect(test.service.reconcileProviderConfirmed({
      ...input,
      providerUsageSnapshot: [{ handle: "pack-meter", quantity: "3", costAmount: "12.50", costCurrency: "USD" }],
    })).resolves.toMatchObject({ activatedCount: 0, discrepancy: { kind: "ambiguous" } });
    expect(test.purchases[0]).toMatchObject({ status: "REQUESTED", currentAmount: 0 });
  });

  it("activates distinct event-handle candidates independently", async () => {
    const test = harness([
      { id: "purchase-1", creditsGranted: 5, eventHandle: "meter-one", createdAt: new Date("2026-09-08T10:00:00.000Z") },
      { id: "purchase-2", creditsGranted: 7, eventHandle: "meter-two", createdAt: new Date("2026-09-08T11:00:00.000Z") },
    ]);

    await expect(test.service.reconcileProviderConfirmed({
      ...input,
      providerUsageSnapshot: [
        { handle: "meter-one", quantity: "3", costAmount: "12.50", costCurrency: "USD" },
        { handle: "meter-two", quantity: "3", costAmount: "12.50", costCurrency: "USD" },
      ],
    })).resolves.toMatchObject({ activatedCount: 2, confirmedDelta: 2, discrepancy: null });
    expect(test.counter.grantedQuantity).toBe(12);
  });

  it("activates sequential purchases with the same event handle from successive baselines", async () => {
    const test = harness([{ id: "purchase-1", creditsGranted: 5, beforeQuantity: "0", createdAt: new Date("2026-09-08T10:00:00.000Z") }]);

    await expect(test.service.reconcileProviderConfirmed({
      ...input,
      providerUnits: Number.NaN,
      providerUsageSnapshot: [{ handle: "pack-meter", quantity: "1", costAmount: "10.00", costCurrency: "USD" }],
    })).resolves.toMatchObject({ activatedCount: 1, discrepancy: null });

    test.purchases.push({
      ...test.purchases[0]!,
      id: "purchase-2",
      providerUsageQuantityBeforeSnapshot: "1",
      status: "REQUESTED",
      currentAmount: 0,
      providerUsageQuantityAfterSnapshot: null,
      providerPurchaseAmount: null,
      providerValuationConfirmedAt: null,
      version: 0,
    });
    await expect(test.service.reconcileProviderConfirmed({
      ...input,
      providerUnits: Number.NaN,
      providerUsageSnapshot: [{ handle: "pack-meter", quantity: "2", costAmount: "10.00", costCurrency: "USD" }],
    })).resolves.toMatchObject({ activatedCount: 1, discrepancy: null });

    expect(test.purchases.map((purchase) => purchase.status)).toEqual(["ACTIVE", "ACTIVE"]);
    expect(test.counter.grantedQuantity).toBe(10);
  });
});
