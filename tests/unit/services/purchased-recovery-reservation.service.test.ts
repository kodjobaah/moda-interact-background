import { describe, expect, it, vi } from "vitest";

import { PurchasedRecoveryReservationService } from "../../../src/services/purchased-recovery-reservation.service.js";

function createHarness(grantedQuantity = 1, lotInputs = [{ id: "purchase-1", creditsGranted: grantedQuantity, activatedAt: new Date("2026-09-01T00:00:00.000Z"), createdAt: new Date("2026-09-01T00:00:00.000Z") }]) {
  const state = {
    counter: {
      id: "counter-1",
      shopId: "shop-1",
      counter: "PURCHASED_RECOVERY_CREDITS",
      grantedQuantity,
      committedQuantity: 0,
      reservedQuantity: 0,
      refundingQuantity: 0,
      version: 0,
    },
    reservation: null as Record<string, unknown> | null,
    usageEvent: null as Record<string, unknown> | null,
    lots: lotInputs.map((lot) => ({
      shopId: "shop-1",
      status: "ACTIVE",
      committedQuantity: 0,
      reservedQuantity: 0,
      refundingQuantity: 0,
      refundedQuantity: 0,
      version: 0,
      ...lot,
    })),
  };

  const transaction = {
    shopEntitlementCounter: {
      findUnique: vi.fn(async ({ select }: { select?: { version?: boolean; counter?: boolean } }) =>
        select?.counter
          ? { counter: state.counter.counter }
          : select?.version
            ? { version: state.counter.version }
            : { ...state.counter }),
      create: vi.fn(async () => state.counter),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; version: number; reservedQuantity?: { gte: number } }; data: Record<string, unknown> }) => {
        if (where.id !== state.counter.id || where.version !== state.counter.version) return { count: 0 };
        if (where.reservedQuantity && state.counter.reservedQuantity < where.reservedQuantity.gte) return { count: 0 };
        state.counter.reservedQuantity += (data.reservedQuantity as { increment?: number; decrement?: number } | undefined)?.increment ?? 0;
        state.counter.reservedQuantity -= (data.reservedQuantity as { increment?: number; decrement?: number } | undefined)?.decrement ?? 0;
        state.counter.committedQuantity += (data.committedQuantity as { increment?: number } | undefined)?.increment ?? 0;
        state.counter.refundingQuantity += (data.refundingQuantity as { increment?: number } | undefined)?.increment ?? 0;
        state.counter.version += (data.version as { increment: number }).increment;
        return { count: 1 };
      }),
    },
    recoveryCreditPurchase: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => state.lots.find((lot) => lot.id === where.id) ?? null),
      findMany: vi.fn(async () => [...state.lots].sort((left, right) => {
        const activation = (left.activatedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (right.activatedAt?.getTime() ?? Number.MAX_SAFE_INTEGER);
        return activation || left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id);
      }).filter((lot) => lot.status === "ACTIVE")),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; version: number; status?: string; reservedQuantity?: { gte?: number; lte?: number } }; data: Record<string, unknown> }) => {
        const lot = state.lots.find((candidate) => candidate.id === where.id);
        if (!lot || lot.version !== where.version || (where.status && lot.status !== where.status)) return { count: 0 };
        if (where.reservedQuantity?.gte !== undefined && lot.reservedQuantity < where.reservedQuantity.gte) return { count: 0 };
        if (where.reservedQuantity?.lte !== undefined && lot.reservedQuantity > where.reservedQuantity.lte) return { count: 0 };
        const reserved = data.reservedQuantity as { increment?: number; decrement?: number } | undefined;
        const committed = data.committedQuantity as { increment?: number } | undefined;
        const refunding = data.refundingQuantity as { increment?: number } | undefined;
        lot.reservedQuantity += reserved?.increment ?? 0;
        lot.reservedQuantity -= reserved?.decrement ?? 0;
        lot.committedQuantity += committed?.increment ?? 0;
        lot.refundingQuantity += refunding?.increment ?? 0;
        lot.version += (data.version as { increment: number }).increment;
        return { count: 1 };
      }),
    },
    usageReservation: {
      findUnique: vi.fn(async ({ where }: { where: { sourceKey: string } }) =>
        state.reservation?.sourceKey === where.sourceKey ? state.reservation : null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.reservation = {
          id: "reservation-1",
          ...data,
          status: "RESERVED",
          committedUsageEventId: null,
        };
        return state.reservation;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.reservation = { ...state.reservation, ...data };
        return state.reservation;
      }),
    },
    usageEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.usageEvent = { id: "usage-1", ...data };
        return state.usageEvent;
      }),
    },
  };

  const database = {
    ...transaction,
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)),
  };
  return {
    service: new PurchasedRecoveryReservationService(database as never),
    database,
    transaction,
    state,
  };
}

describe("PurchasedRecoveryReservationService", () => {
  it("reserves and commits one purchased credit exactly once", async () => {
    const { service, transaction, state } = createHarness();

    await expect(service.reserve({ shopId: "shop-1", sourceKey: "purchased:recovery-1" }))
      .resolves.toMatchObject({ kind: "reserved" });
    await expect(service.commit({ shopId: "shop-1", sourceKey: "purchased:recovery-1" }))
      .resolves.toMatchObject({ kind: "committed" });
    await expect(service.commit({ shopId: "shop-1", sourceKey: "purchased:recovery-1" }))
      .resolves.toMatchObject({ kind: "already-committed" });

    expect(state.counter).toMatchObject({ grantedQuantity: 1, committedQuantity: 1, reservedQuantity: 0 });
    expect(state.usageEvent).toMatchObject({
      metric: "RECOVERY_CONVERSATION",
      shopifyReportState: "NOT_APPLICABLE",
      sourceType: "PURCHASED_RECOVERY_CREDITS",
    });
    expect(transaction.usageEvent.create).toHaveBeenCalledTimes(1);
  });

  it("does not reserve beyond the purchased balance", async () => {
    const { service, state } = createHarness();

    await expect(service.reserve({ shopId: "shop-1", sourceKey: "purchased:recovery-1" }))
      .resolves.toMatchObject({ kind: "reserved" });
    await expect(service.reserve({ shopId: "shop-1", sourceKey: "purchased:recovery-2" }))
      .resolves.toMatchObject({ kind: "credits-exhausted", available: 0 });
    expect(state.counter.reservedQuantity).toBe(1);
    expect(state.lots[0]?.reservedQuantity).toBe(1);
  });

  it("selects the oldest active spendable lot in FIFO order", async () => {
    const { service, state } = createHarness(2, [
      { id: "purchase-new", creditsGranted: 1, activatedAt: new Date("2026-09-02T00:00:00.000Z"), createdAt: new Date("2026-09-02T00:00:00.000Z") },
      { id: "purchase-old", creditsGranted: 1, activatedAt: new Date("2026-09-01T00:00:00.000Z"), createdAt: new Date("2026-09-01T00:00:00.000Z") },
    ]);

    const result = await service.reserve({ shopId: "shop-1", sourceKey: "purchased:fifo" });

    expect(result).toMatchObject({ kind: "reserved", reservation: { purchasedCreditPurchaseId: "purchase-old" } });
    expect(state.lots).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "purchase-old", reservedQuantity: 1 }),
      expect.objectContaining({ id: "purchase-new", reservedQuantity: 0 }),
    ]));
  });

  it("skips exhausted, refund-held, and refunded lots", async () => {
    const { service } = createHarness(3, [
      { id: "exhausted", creditsGranted: 1, committedQuantity: 1, activatedAt: new Date("2026-09-01T00:00:00.000Z"), createdAt: new Date("2026-09-01T00:00:00.000Z") },
      { id: "held", creditsGranted: 1, refundingQuantity: 1, activatedAt: new Date("2026-09-02T00:00:00.000Z"), createdAt: new Date("2026-09-02T00:00:00.000Z") },
      { id: "refunded", creditsGranted: 1, refundedQuantity: 1, activatedAt: new Date("2026-09-03T00:00:00.000Z"), createdAt: new Date("2026-09-03T00:00:00.000Z") },
      { id: "available", creditsGranted: 1, activatedAt: new Date("2026-09-04T00:00:00.000Z"), createdAt: new Date("2026-09-04T00:00:00.000Z") },
    ]);

    await expect(service.reserve({ shopId: "shop-1", sourceKey: "purchased:skip" }))
      .resolves.toMatchObject({ kind: "reserved", reservation: { purchasedCreditPurchaseId: "available" } });
  });

  it("does not reserve credits held by an approved refund", async () => {
    const { service, state } = createHarness(1);
    state.counter.refundingQuantity = 1;

    await expect(service.reserve({ shopId: "shop-1", sourceKey: "purchased:refund-held" }))
      .resolves.toEqual({ kind: "credits-exhausted", available: 0 });
    expect(state.counter.reservedQuantity).toBe(0);
  });

  it("allows at most one of a full refund hold and recovery reservation to consume shared capacity", async () => {
    const { service, state, database } = createHarness(5);
    const hold = async () => database.$transaction(async (transaction) => {
      const counter = await transaction.shopEntitlementCounter.findUnique({ where: { shopId_counter: { shopId: "shop-1", counter: "PURCHASED_RECOVERY_CREDITS" } } });
      const updated = await transaction.shopEntitlementCounter.updateMany({
        where: { id: counter.id, version: counter.version },
        data: { refundingQuantity: { increment: 5 }, version: { increment: 1 } },
      });
      const lot = await transaction.recoveryCreditPurchase.findUnique({ where: { id: "purchase-1" } });
      const updatedLot = await transaction.recoveryCreditPurchase.updateMany({
        where: { id: lot.id, version: lot.version, reservedQuantity: { lte: lot.creditsGranted - lot.committedQuantity - lot.refundingQuantity - lot.refundedQuantity - 5 } },
        data: { refundingQuantity: { increment: 5 }, version: { increment: 1 } },
      });
      return updated.count === 1 && updatedLot.count === 1;
    });

    const [refundHeld, reservation] = await Promise.all([
      hold(),
      service.reserve({ shopId: "shop-1", sourceKey: "purchased:race" }),
    ]);

    expect([refundHeld, reservation.kind === "reserved"]).toEqual(expect.arrayContaining([true, false]));
    expect(state.counter.grantedQuantity - state.counter.committedQuantity - state.counter.reservedQuantity - state.counter.refundingQuantity).toBeGreaterThanOrEqual(0);
    expect(state.counter.refundingQuantity + state.counter.reservedQuantity).toBeLessThanOrEqual(5);
  });

  it("releases a definitive failure and preserves the credit", async () => {
    const { service, state } = createHarness();

    await service.reserve({ shopId: "shop-1", sourceKey: "purchased:recovery-1" });
    await expect(service.release({ shopId: "shop-1", sourceKey: "purchased:recovery-1" }))
      .resolves.toMatchObject({ kind: "released" });

    expect(state.counter).toMatchObject({ committedQuantity: 0, reservedQuantity: 0 });
    expect(state.lots[0]).toMatchObject({ committedQuantity: 0, reservedQuantity: 0 });
  });

  it("reactivates a released reservation on the same row and counter", async () => {
    const { service, state, transaction } = createHarness(2, [
      { id: "purchase-old", creditsGranted: 1, activatedAt: new Date("2026-09-01T00:00:00.000Z"), createdAt: new Date("2026-09-01T00:00:00.000Z") },
      { id: "purchase-new", creditsGranted: 1, activatedAt: new Date("2026-09-02T00:00:00.000Z"), createdAt: new Date("2026-09-02T00:00:00.000Z") },
    ]);
    await service.reserve({ shopId: "shop-1", sourceKey: "purchased:reactivate" });
    const reservationId = state.reservation!.id;
    const counterId = state.reservation!.counterId;
    const purchaseId = state.reservation!.purchasedCreditPurchaseId;
    await service.release({ shopId: "shop-1", sourceKey: "purchased:reactivate" });

    await expect(service.reserve({ shopId: "shop-1", sourceKey: "purchased:reactivate" }))
      .resolves.toMatchObject({ kind: "reserved", reservation: { id: reservationId, counterId, purchasedCreditPurchaseId: purchaseId, status: "RESERVED" } });
    expect(state.counter).toMatchObject({ reservedQuantity: 1, version: 3 });
    expect(transaction.usageReservation.create).toHaveBeenCalledTimes(1);
    expect(state.lots).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "purchase-old", reservedQuantity: 1 }),
      expect.objectContaining({ id: "purchase-new", reservedQuantity: 0 }),
    ]));
  });

  it("keeps ambiguous provider outcomes consuming reserved capacity", async () => {
    const { service, state } = createHarness();

    await service.reserve({ shopId: "shop-1", sourceKey: "purchased:recovery-ambiguous" });
    await expect(service.markAmbiguous({ shopId: "shop-1", sourceKey: "purchased:recovery-ambiguous" }))
      .resolves.toMatchObject({ kind: "ambiguous" });

    expect(state.counter).toMatchObject({ committedQuantity: 0, reservedQuantity: 1 });
    expect(state.lots[0]).toMatchObject({ committedQuantity: 0, reservedQuantity: 1 });
    await expect(service.reserve({ shopId: "shop-1", sourceKey: "purchased:recovery-next" }))
      .resolves.toMatchObject({ kind: "credits-exhausted", available: 0 });
  });

  it("retries after a counter CAS loss before observing exhausted capacity", async () => {
    const { service, state, transaction, database } = createHarness();
    let counterReads = 0;
    let casAttempts = 0;
    let casConflicts = 0;
    let bothCasReadyResolve!: () => void;
    const bothCasReady = new Promise<void>((resolve) => {
      bothCasReadyResolve = resolve;
    });
    const originalFindUnique = transaction.shopEntitlementCounter.findUnique;
    transaction.shopEntitlementCounter.findUnique = vi.fn(async (args) => {
      const result = await originalFindUnique(args);
      if (!args.select) {
        counterReads += 1;
        if (counterReads === 2) bothCasReadyResolve();
      }
      return result;
    });
    const originalUpdateMany = transaction.shopEntitlementCounter.updateMany;
    transaction.shopEntitlementCounter.updateMany = vi.fn(async (args) => {
      casAttempts += 1;
      if (casAttempts <= 2) {
        if (casAttempts === 2) bothCasReadyResolve();
        await bothCasReady;
      }
      const result = await originalUpdateMany(args);
      if (result.count === 0) casConflicts += 1;
      return result;
    });

    const results = await Promise.all([
      service.reserve({ shopId: "shop-1", sourceKey: "purchased:recovery-a" }),
      service.reserve({ shopId: "shop-1", sourceKey: "purchased:recovery-b" }),
    ]);

    expect(results.filter((result) => result.kind === "reserved")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "credits-exhausted")).toHaveLength(1);
    expect(state.counter.reservedQuantity).toBe(1);
    expect(counterReads).toBeGreaterThanOrEqual(2);
    expect(transaction.shopEntitlementCounter.updateMany).toHaveBeenCalledTimes(2);
    expect(database.$transaction).toHaveBeenCalledTimes(3);
    expect(casConflicts).toBe(1);
  });
});
