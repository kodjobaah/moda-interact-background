import { describe, expect, it, vi } from "vitest";

import { RecoveryCreditPurchaseService } from "../../../src/services/recovery-credit-purchase.service.js";

function harness(candidates = [
  { id: "purchase-1", creditsGranted: 5, createdAt: new Date("2026-09-08T10:00:00.000Z") },
  { id: "purchase-2", creditsGranted: 5, createdAt: new Date("2026-09-08T11:00:00.000Z") },
]) {
  const purchases = candidates.map((purchase) => ({ ...purchase, shopId: "shop-1", planId: "plan-1", shopifyPlanHandleSnapshot: "pro-2026", shopifyEventHandleSnapshot: "pack-meter", status: "PENDING_BILLING", usageEvent: { metric: "RECOVERY_CREDIT_PACK_PURCHASE", quantity: 1, shopifyReportState: "REPORTED", billingPeriodId: "period-1" } }));
  const counter = { grantedQuantity: 0 };
  const transaction = {
    recoveryCreditPurchase: {
      count: vi.fn(async ({ where }: { where: { status: string } }) => purchases.filter((purchase) => purchase.status === where.status).length),
      findMany: vi.fn(async () => purchases.filter((purchase) => purchase.status === "PENDING_BILLING")),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; status: string }; data: Record<string, unknown> }) => {
        const purchase = purchases.find((candidate) => candidate.id === where.id && candidate.status === where.status);
        if (!purchase) return { count: 0 };
        Object.assign(purchase, data);
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
  return { service: new RecoveryCreditPurchaseService(database as never, 3, () => new Date("2026-09-08T12:00:00.000Z")), purchases, counter };
}

const input = { shopId: "shop-1", billingPeriodId: "period-1", providerPlanHandle: "pro-2026", packMeterHandle: "pack-meter" };

describe("RecoveryCreditPurchaseService", () => {
  it("activates one equivalent provider-confirmed unit deterministically", async () => {
    const test = harness();
    await expect(test.service.reconcileProviderConfirmed({ ...input, providerUnits: 1 })).resolves.toMatchObject({ activatedCount: 1, confirmedDelta: 1, discrepancy: null });
    expect(test.purchases[0]?.status).toBe("ACTIVE");
    expect(test.purchases[1]?.status).toBe("PENDING_BILLING");
    expect(test.counter.grantedQuantity).toBe(5);
  });

  it("does not grant twice when the provider quantity is replayed", async () => {
    const test = harness();
    await test.service.reconcileProviderConfirmed({ ...input, providerUnits: 1 });
    await expect(test.service.reconcileProviderConfirmed({ ...input, providerUnits: 1 })).resolves.toMatchObject({ activatedCount: 0, alreadyMatchedUnits: 1, confirmedDelta: 0 });
    expect(test.counter.grantedQuantity).toBe(5);
  });

  it("activates two equivalent candidates when Shopify confirms two units", async () => {
    const test = harness();
    await expect(test.service.reconcileProviderConfirmed({ ...input, providerUnits: 2 })).resolves.toMatchObject({ activatedCount: 2 });
    expect(test.counter.grantedQuantity).toBe(10);
  });

  it("fails closed when a partial confirmation crosses different pack values", async () => {
    const test = harness([{ id: "purchase-1", creditsGranted: 5, createdAt: new Date("2026-09-08T10:00:00.000Z") }, { id: "purchase-2", creditsGranted: 10, createdAt: new Date("2026-09-08T11:00:00.000Z") }]);
    await expect(test.service.reconcileProviderConfirmed({ ...input, providerUnits: 1 })).resolves.toMatchObject({ activatedCount: 0, discrepancy: { kind: "ambiguous" } });
    expect(test.counter.grantedQuantity).toBe(0);
  });

  it("reports provider under- and over-counts without revoking or fabricating", async () => {
    const under = harness();
    under.purchases[0]!.status = "ACTIVE";
    await expect(under.service.reconcileProviderConfirmed({ ...input, providerUnits: 0 })).resolves.toMatchObject({ activatedCount: 0, discrepancy: { kind: "under" } });
    const over = harness();
    await expect(over.service.reconcileProviderConfirmed({ ...input, providerUnits: 3 })).resolves.toMatchObject({ activatedCount: 2, discrepancy: { kind: "over" } });
    expect(over.purchases).toHaveLength(2);
  });

  it("fails closed for invalid provider quantities", async () => {
    const test = harness();
    await expect(test.service.reconcileProviderConfirmed({ ...input, providerUnits: Number.NaN })).resolves.toMatchObject({ activatedCount: 0, discrepancy: { kind: "invalid-provider-units" } });
  });
});
