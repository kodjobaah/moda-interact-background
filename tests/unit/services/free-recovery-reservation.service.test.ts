import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import type { EffectiveBillingPolicy } from "../../../src/services/effective-billing-policy.service.js";
import { FreeRecoveryReservationService } from "../../../src/services/free-recovery-reservation.service.js";

const policy = {
  shopId: "shop-1",
  subscriptionId: "subscription-1",
  subscriptionStatus: "ACTIVE",
  planId: "plan-free",
  planHandle: "free",
  planKind: "FREE",
  features: {},
  freeAllowance: {
    base: 1,
    adjustment: 0,
    effective: 1,
    committed: 0,
    reserved: 0,
    remaining: 1,
  },
  shopifyUsageEventHandle: null,
  billingPeriod: null,
  outboundSoftLimit: 10,
  outboundHardLimit: 20,
  terminalMessageReservedSlots: 1,
  newRecoveriesPaused: false,
  automatedWhatsappPaused: false,
  paused: false,
  pauseReasons: [],
  policyVersions: { platform: 1, shopOverride: null, plan: new Date() },
} as EffectiveBillingPolicy;

function createHarness(resolvedPolicy: EffectiveBillingPolicy = policy) {
  const state = {
    counter: {
      id: "counter-1",
      shopId: "shop-1",
      counter: "FREE_RECOVERY_LIFETIME",
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
        const increment = (data.reservedQuantity as { increment?: number } | undefined)?.increment ?? 0;
        const decrement = (data.reservedQuantity as { decrement?: number } | undefined)?.decrement ?? 0;
        state.counter.reservedQuantity += increment - decrement;
        state.counter.committedQuantity += (data.committedQuantity as { increment?: number } | undefined)?.increment ?? 0;
        state.counter.version += (data.version as { increment: number }).increment;
        return { count: 1 };
      }),
    },
    usageReservation: {
      findUnique: vi.fn(async () => state.reservation),
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
  const service = new FreeRecoveryReservationService(
    database as never,
    () => ({ resolve: async () => resolvedPolicy }) as never,
  );
  return { service, database, transaction, state };
}

describe("FreeRecoveryReservationService", () => {
  it("replays the same source key without reserving twice", async () => {
    const { service, transaction } = createHarness();

    await expect(service.reserve({ shopId: "shop-1", sourceKey: "recovery:1" })).resolves.toMatchObject({ kind: "reserved" });
    await expect(service.reserve({ shopId: "shop-1", sourceKey: "recovery:1" })).resolves.toMatchObject({ kind: "already-reserved" });
    expect(transaction.shopEntitlementCounter.updateMany).toHaveBeenCalledTimes(1);
  });

  it("commits one usage event and makes commit replay terminal", async () => {
    const { service, transaction, state } = createHarness();
    await service.reserve({ shopId: "shop-1", sourceKey: "recovery:2" });

    await expect(service.commit({ shopId: "shop-1", sourceKey: "recovery:2" })).resolves.toMatchObject({ kind: "committed" });
    await expect(service.commit({ shopId: "shop-1", sourceKey: "recovery:2" })).resolves.toMatchObject({ kind: "already-committed" });
    expect(state.counter).toMatchObject({ committedQuantity: 1, reservedQuantity: 0 });
    expect(state.usageEvent).toMatchObject({
      idempotencyKey: "recovery:shop-1:recovery:2",
      metric: "RECOVERY_CONVERSATION",
      shopifyReportState: "NOT_APPLICABLE",
    });
    expect(transaction.usageEvent.create).toHaveBeenCalledTimes(1);
  });

  it("releases once and preserves capacity without creating usage", async () => {
    const { service, state, transaction } = createHarness();
    await service.reserve({ shopId: "shop-1", sourceKey: "recovery:3" });

    await expect(service.release({ shopId: "shop-1", sourceKey: "recovery:3" })).resolves.toMatchObject({ kind: "released" });
    await expect(service.release({ shopId: "shop-1", sourceKey: "recovery:3" })).resolves.toMatchObject({ kind: "already-released" });
    expect(state.counter).toMatchObject({ committedQuantity: 0, reservedQuantity: 0 });
    expect(transaction.usageEvent.create).not.toHaveBeenCalled();
  });

  it("rejects release after commit and cross-shop source replay", async () => {
    const { service, state } = createHarness();
    await service.reserve({ shopId: "shop-1", sourceKey: "recovery:committed" });
    await service.commit({ shopId: "shop-1", sourceKey: "recovery:committed" });

    await expect(service.release({ shopId: "shop-1", sourceKey: "recovery:committed" })).rejects.toThrow("cannot be released");
    state.reservation!.shopId = "shop-2";
    await expect(service.reserve({ shopId: "shop-1", sourceKey: "recovery:committed" })).rejects.toThrow("another shop");
  });

  it("marks ambiguous without releasing capacity and rejects invalid transitions", async () => {
    const { service, state } = createHarness();
    await service.reserve({ shopId: "shop-1", sourceKey: "recovery:4" });

    await expect(service.markAmbiguous({ shopId: "shop-1", sourceKey: "recovery:4" })).resolves.toMatchObject({ kind: "ambiguous" });
    await expect(service.release({ shopId: "shop-1", sourceKey: "recovery:4" })).resolves.toMatchObject({ kind: "already-ambiguous" });
    expect(state.counter.reservedQuantity).toBe(1);
    await expect(service.reserve({ shopId: "shop-1", sourceKey: "recovery:5", quantity: 0 })).rejects.toThrow("positive safe integer");
  });

  it("retries a bounded serializable/CAS conflict", async () => {
    const { service, database } = createHarness();
    const conflict = new Prisma.PrismaClientKnownRequestError("serialization conflict", {
      code: "P2034",
      clientVersion: "test",
    });
    const transaction = database.$transaction;
    transaction.mockRejectedValueOnce(conflict);

    await expect(service.reserve({ shopId: "shop-1", sourceKey: "recovery:5" })).resolves.toMatchObject({ kind: "reserved" });
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("replays the winning same-source reservation after a P2002 loser conflict", async () => {
    const { service, database, transaction, state } = createHarness();
    const conflict = new Prisma.PrismaClientKnownRequestError("unique source conflict", {
      code: "P2002",
      clientVersion: "test",
    });
    state.counter.reservedQuantity = 1;
    state.reservation = {
      id: "winner-reservation",
      shopId: "shop-1",
      counterId: "counter-1",
      sourceKey: "recovery:p2002",
      quantity: 1,
      status: "RESERVED",
      committedUsageEventId: null,
    };
    database.$transaction.mockImplementationOnce(async () => {
      throw conflict;
    });

    await expect(service.reserve({ shopId: "shop-1", sourceKey: "recovery:p2002" }))
      .resolves.toMatchObject({ kind: "already-reserved", reservation: { id: "winner-reservation" } });
    expect(transaction.shopEntitlementCounter.updateMany).not.toHaveBeenCalled();
    expect(database.$transaction).toHaveBeenCalledTimes(2);
  });

  it("enforces the retry maximum when conflicts never resolve", async () => {
    const { service, database } = createHarness();
    const conflict = new Prisma.PrismaClientKnownRequestError("serialization conflict", {
      code: "P2034",
      clientVersion: "test",
    });
    database.$transaction.mockRejectedValue(conflict);

    await expect(service.reserve({ shopId: "shop-1", sourceKey: "recovery:exhausted" }))
      .rejects.toBe(conflict);
    expect(database.$transaction).toHaveBeenCalledTimes(3);
  });

  it("fails closed after allowance reduction below committed and reserved usage", async () => {
    const reducedPolicy = {
      ...policy,
      freeAllowance: {
        ...policy.freeAllowance!,
        effective: 1,
        committed: 2,
        reserved: 1,
        remaining: 0,
      },
    } as EffectiveBillingPolicy;
    const { service, state } = createHarness(reducedPolicy);
    state.counter.committedQuantity = 2;
    state.counter.reservedQuantity = 1;
    await expect(service.reserve({ shopId: "shop-1", sourceKey: "recovery:reduced" }))
      .resolves.toMatchObject({ kind: "allowance-exhausted", remaining: 0 });
    expect(state.counter).toMatchObject({ committedQuantity: 2, reservedQuantity: 1, version: 0 });
  });
});