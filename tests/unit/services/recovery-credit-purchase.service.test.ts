import { describe, expect, it, vi } from "vitest";

import { RecoveryCreditPurchaseService } from "../../../src/services/recovery-credit-purchase.service.js";

function createActivationHarness(reportState = "REPORTED") {
  const purchase = {
    shopId: "shop-1",
    creditsGranted: 5,
    status: "PENDING_BILLING",
    usageEvent: { shopifyReportState: reportState },
  };
  const counter = {
    id: "counter-1",
    shopId: "shop-1",
    counter: "PURCHASED_RECOVERY_CREDITS",
    grantedQuantity: 0,
    committedQuantity: 0,
    reservedQuantity: 0,
    version: 0,
  };
  const transaction = {
    recoveryCreditPurchase: {
      findUnique: vi.fn(async ({ select }: { select?: unknown }) => {
        if (select && typeof select === "object" && "usageEvent" in select) return purchase;
        return purchase;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { status?: { in?: string[] } }; data: Record<string, unknown> }) => {
        if (where.status?.in && !where.status.in.includes(purchase.status)) return { count: 0 };
        Object.assign(purchase, data);
        return { count: 1 };
      }),
    },
    shopEntitlementCounter: {
      upsert: vi.fn(async ({ update, create }: { update: Record<string, unknown>; create: typeof counter }) => {
        if (update.grantedQuantity) {
          counter.grantedQuantity += (update.grantedQuantity as { increment: number }).increment;
          counter.version += (update.version as { increment: number }).increment;
        } else {
          Object.assign(counter, create);
        }
        return counter;
      }),
    },
  };
  const database = {
    ...transaction,
    recoveryCreditPurchase: {
      findMany: vi.fn(async () => [{ id: "purchase-1" }]),
    },
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)),
  };
  return {
    service: new RecoveryCreditPurchaseService(database as never, 3, () => new Date("2026-09-08T12:00:00.000Z")),
    database,
    transaction,
    purchase,
    counter,
  };
}

describe("RecoveryCreditPurchaseService", () => {
  it("activates a reported purchase once and grants credits exactly once on replay", async () => {
    const { service, transaction, counter } = createActivationHarness();

    await expect(service.activateFromUsageEvent("purchase-1")).resolves.toEqual({
      kind: "activated",
      creditsGranted: 5,
    });
    await expect(service.activateFromUsageEvent("purchase-1")).resolves.toEqual({
      kind: "already-active",
      creditsGranted: 5,
    });

    expect(counter.grantedQuantity).toBe(5);
    expect(transaction.shopEntitlementCounter.upsert).toHaveBeenCalledTimes(1);
  });

  it("does not grant pending or attention purchases", async () => {
    const pending = createActivationHarness("PENDING");
    await expect(pending.service.activateFromUsageEvent("purchase-1")).resolves.toEqual({ kind: "pending" });
    expect(pending.counter.grantedQuantity).toBe(0);

    const attention = createActivationHarness("NEEDS_ATTENTION");
    await expect(attention.service.activateFromUsageEvent("purchase-1")).resolves.toEqual({ kind: "needs-attention" });
    expect(attention.counter.grantedQuantity).toBe(0);

    const retryable = createActivationHarness("RETRYABLE");
    await expect(retryable.service.activateFromUsageEvent("purchase-1")).resolves.toEqual({ kind: "pending" });
    expect(retryable.counter.grantedQuantity).toBe(0);
  });

  it("activates after a previously attention-state event is later reported", async () => {
    const { service, purchase, counter } = createActivationHarness("NEEDS_ATTENTION");

    await service.activateFromUsageEvent("purchase-1");
    purchase.usageEvent.shopifyReportState = "REPORTED";
    await expect(service.activateFromUsageEvent("purchase-1")).resolves.toEqual({
      kind: "activated",
      creditsGranted: 5,
    });

    expect(counter.grantedQuantity).toBe(5);
  });

  it("grants exactly once when activation is replayed concurrently", async () => {
    const { service, counter } = createActivationHarness();

    const results = await Promise.all([
      service.activateFromUsageEvent("purchase-1"),
      service.activateFromUsageEvent("purchase-1"),
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual(["activated", "already-active"]);
    expect(counter.grantedQuantity).toBe(5);
  });

  it("prioritizes reported purchases over stable attention rows within the limit", async () => {
    const { service, database } = createActivationHarness();
    const olderAttention = Array.from({ length: 100 }, (_, index) => ({ id: `attention-${index}` }));
    const findMany = vi.fn()
      .mockResolvedValueOnce([{ id: "reported-1" }])
      .mockResolvedValueOnce(olderAttention.slice(0, 49));
    database.recoveryCreditPurchase.findMany = findMany;

    const results = await service.reconcilePending(50);

    expect(results).toHaveLength(50);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      take: 50,
      where: expect.objectContaining({
        usageEvent: { shopifyReportState: "REPORTED" },
      }),
    }));
    expect(findMany.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ take: 49 }));
    expect(results[0]).toMatchObject({ id: "reported-1", result: { kind: "activated" } });
  });
});
