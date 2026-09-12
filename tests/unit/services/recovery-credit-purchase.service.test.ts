import { describe, expect, it, vi } from "vitest";

import { RecoveryCreditPurchaseService } from "../../../src/services/recovery-credit-purchase.service.js";

function harness(candidates = [
  { id: "purchase-1", creditsGranted: 5, createdAt: new Date("2026-09-08T10:00:00.000Z") },
  { id: "purchase-2", creditsGranted: 5, createdAt: new Date("2026-09-08T11:00:00.000Z") },
]) {
  const purchases = candidates.map((purchase) => ({ ...purchase, shopId: "shop-1", planId: "plan-1", shopifyPlanHandleSnapshot: "pro-2026", shopifyEventHandleSnapshot: "pack-meter", status: "PENDING_BILLING", refund: null, usageEvent: { shopId: "shop-1", shopifyEventHandle: "pack-meter", metric: "RECOVERY_CREDIT_PACK_PURCHASE", quantity: 1, shopifyReportState: "REPORTED", billingPeriodId: "period-1" } }));
  const counter = { grantedQuantity: 0 };
  const transaction = {
    recoveryCreditPurchase: {
      count: vi.fn(async ({ where }: { where: { status: string; shopId: string; shopifyPlanHandleSnapshot: string; shopifyEventHandleSnapshot: string; usageEvent: Record<string, unknown> } }) => purchases.filter((purchase) => matches(purchase, where)).length),
      findMany: vi.fn(async ({ where }: { where: { status: { in: string[] }; shopId: string; shopifyPlanHandleSnapshot: string; shopifyEventHandleSnapshot: string; usageEvent: Record<string, unknown> } }) => purchases.filter((purchase) => matches(purchase, where))),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; status: { in: string[] } }; data: Record<string, unknown> }) => {
        const purchase = purchases.find((candidate) => candidate.id === where.id && where.status.in.includes(candidate.status));
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

function matches(purchase: (typeof candidates)[number] & Record<string, unknown>, where: { status: string | { in: string[] }; shopId: string; shopifyPlanHandleSnapshot: string; shopifyEventHandleSnapshot: string; usageEvent: Record<string, unknown> }) {
  const statusMatches = typeof where.status === "string"
    ? purchase.status === where.status
    : where.status.in.includes(purchase.status);
  const usageWhere = (where.usageEvent as { is?: Record<string, unknown> }).is ?? where.usageEvent;
  return statusMatches
    && purchase.shopId === where.shopId
    && purchase.shopifyPlanHandleSnapshot === where.shopifyPlanHandleSnapshot
    && purchase.shopifyEventHandleSnapshot === where.shopifyEventHandleSnapshot
    && purchase.usageEvent.shopId === usageWhere.shopId
    && purchase.usageEvent.shopifyEventHandle === usageWhere.shopifyEventHandle
    && purchase.usageEvent.metric === usageWhere.metric
    && purchase.usageEvent.quantity === usageWhere.quantity
    && purchase.usageEvent.shopifyReportState === usageWhere.shopifyReportState
    && purchase.usageEvent.billingPeriodId === usageWhere.billingPeriodId
    && (!where.refund || (purchase.refund?.status === "COMPLETED" && purchase.refund?.settlementMode === "PARTNER_DASHBOARD_REFUND"));
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

  it("does not regrant a locally partially refunded active purchase", async () => {
    const test = harness();
    test.purchases[0]!.status = "ACTIVE";

    await expect(test.service.reconcileProviderConfirmed({ ...input, providerUnits: 1 }))
      .resolves.toMatchObject({ alreadyMatchedUnits: 1, eligibleCandidateCount: 1, activatedCount: 0 });
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
    return expect(test.service.reconcileProviderConfirmed({ ...input, providerUnits: 1 }))
      .resolves.toMatchObject({ activatedCount: 0, eligibleCandidateCount: 0, discrepancy: { kind: "over" } });
  });

  it("re-enters a repaired attention purchase only after its event is REPORTED", async () => {
    const test = harness();
    test.purchases[0]!.status = "NEEDS_ATTENTION";

    await expect(test.service.reconcileProviderConfirmed({ ...input, providerUnits: 1 }))
      .resolves.toMatchObject({ activatedCount: 1 });
    await expect(test.service.reconcileProviderConfirmed({ ...input, providerUnits: 1 }))
      .resolves.toMatchObject({ activatedCount: 0, alreadyMatchedUnits: 1 });
    expect(test.counter.grantedQuantity).toBe(5);
  });

  it("retries a serializable overlap without double-granting", async () => {
    const test = harness();
    await expect(Promise.all([
      test.service.reconcileProviderConfirmed({ ...input, providerUnits: 1 }),
      test.service.reconcileProviderConfirmed({ ...input, providerUnits: 1 }),
    ])).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ activatedCount: 1 }),
      expect.objectContaining({ activatedCount: 0 }),
    ]));
    expect(test.counter.grantedQuantity).toBe(5);
  });
});
