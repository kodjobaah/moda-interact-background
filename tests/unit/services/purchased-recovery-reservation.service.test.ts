import { describe, expect, it, vi } from "vitest";

import { PurchasedRecoveryReservationService } from "../../../src/services/purchased-recovery-reservation.service.js";

function createHarness(grantedQuantity = 1) {
  const state = {
    counter: {
      id: "counter-1",
      shopId: "shop-1",
      counter: "PURCHASED_RECOVERY_CREDITS",
      grantedQuantity,
      committedQuantity: 0,
      reservedQuantity: 0,
      version: 0,
    },
    reservation: null as Record<string, unknown> | null,
    usageEvent: null as Record<string, unknown> | null,
  };

  const transaction = {
    shopEntitlementCounter: {
      findUnique: vi.fn(async ({ select }: { select?: { version: boolean } }) =>
        select ? { version: state.counter.version } : state.counter),
      create: vi.fn(async () => state.counter),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; version: number; reservedQuantity?: { gte: number } }; data: Record<string, unknown> }) => {
        if (where.id !== state.counter.id || where.version !== state.counter.version) return { count: 0 };
        if (where.reservedQuantity && state.counter.reservedQuantity < where.reservedQuantity.gte) return { count: 0 };
        state.counter.reservedQuantity += (data.reservedQuantity as { increment?: number; decrement?: number } | undefined)?.increment ?? 0;
        state.counter.reservedQuantity -= (data.reservedQuantity as { increment?: number; decrement?: number } | undefined)?.decrement ?? 0;
        state.counter.committedQuantity += (data.committedQuantity as { increment?: number } | undefined)?.increment ?? 0;
        state.counter.version += (data.version as { increment: number }).increment;
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
  });

  it("releases a definitive failure and preserves the credit", async () => {
    const { service, state } = createHarness();

    await service.reserve({ shopId: "shop-1", sourceKey: "purchased:recovery-1" });
    await expect(service.release({ shopId: "shop-1", sourceKey: "purchased:recovery-1" }))
      .resolves.toMatchObject({ kind: "released" });

    expect(state.counter).toMatchObject({ committedQuantity: 0, reservedQuantity: 0 });
  });

  it("keeps ambiguous provider outcomes consuming reserved capacity", async () => {
    const { service, state } = createHarness();

    await service.reserve({ shopId: "shop-1", sourceKey: "purchased:recovery-ambiguous" });
    await expect(service.markAmbiguous({ shopId: "shop-1", sourceKey: "purchased:recovery-ambiguous" }))
      .resolves.toMatchObject({ kind: "ambiguous" });

    expect(state.counter).toMatchObject({ committedQuantity: 0, reservedQuantity: 1 });
    await expect(service.reserve({ shopId: "shop-1", sourceKey: "purchased:recovery-next" }))
      .resolves.toMatchObject({ kind: "credits-exhausted", available: 0 });
  });

  it("uses counter CAS to prevent concurrent reservations beyond the balance", async () => {
    const { service, state } = createHarness();

    const results = await Promise.all([
      service.reserve({ shopId: "shop-1", sourceKey: "purchased:recovery-a" }),
      service.reserve({ shopId: "shop-1", sourceKey: "purchased:recovery-b" }),
    ]);

    expect(results.filter((result) => result.kind === "reserved")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "credits-exhausted")).toHaveLength(1);
    expect(state.counter.reservedQuantity).toBe(1);
  });
});
