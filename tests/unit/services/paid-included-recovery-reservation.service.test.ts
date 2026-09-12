import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  PaidIncludedRecoveryReservationError,
  PaidIncludedRecoveryReservationService,
} from "../../../src/services/paid-included-recovery-reservation.service.js";

const shopId = "shop-1";
const subscriptionId = "subscription-1";
const periodStart = new Date("2026-09-01T00:00:00.000Z");
const periodEnd = new Date("2026-10-01T00:00:00.000Z");
const now = new Date("2026-09-15T00:00:00.000Z");

type Harness = ReturnType<typeof createHarness>;

function createHarness(grantedQuantity = 1) {
  const state = {
    period: {
      id: "period-1",
      shopId,
      subscriptionId,
      periodStart,
      periodEnd,
      status: "OPEN" as const,
    },
    subscription: {
      id: subscriptionId,
      billingPeriodId: "period-1" as string | null,
      currentPeriodStart: periodStart as Date | null,
      currentPeriodEnd: periodEnd as Date | null,
    },
    counter: {
      id: "period-counter-1",
      shopId,
      billingPeriodId: "period-1",
      counter: "INCLUDED_RECOVERY_CREDITS",
      grantedQuantity,
      committedQuantity: 0,
      reservedQuantity: 0,
      forfeitedQuantity: 0,
      version: 0,
    },
    reservations: new Map<string, Record<string, any>>(),
    usageEvents: [] as Record<string, any>[],
    nextReservationId: 1,
    nextUsageId: 1,
  };

  const transaction = {
    subscription: {
      findUnique: vi.fn(async (args: { select?: { plan?: unknown } }) => {
        if (args.select?.plan) {
          return { plan: { kind: "PAID_METERED", shopifyUsageEventHandle: "paid-meter" } };
        }
        return { ...state.subscription, billingPeriod: { ...state.period } };
      }),
    },
    billingPeriodEntitlementCounter: {
      findUnique: vi.fn(async (args: { where: { id?: string; billingPeriodId_counter?: { billingPeriodId: string } } }) => {
        if (args.where.id) return args.where.id === state.counter.id ? { ...state.counter, billingPeriod: { ...state.period } } : null;
        return args.where.billingPeriodId_counter?.billingPeriodId === state.period.id
          ? { ...state.counter }
          : null;
      }),
      updateMany: vi.fn(async (args: { where: { id: string; version: number; reservedQuantity?: { gte: number } }; data: Record<string, any> }) => {
        if (args.where.id !== state.counter.id || args.where.version !== state.counter.version) return { count: 0 };
        if (args.where.reservedQuantity && state.counter.reservedQuantity < args.where.reservedQuantity.gte) return { count: 0 };
        const reserved = args.data.reservedQuantity;
        const committed = args.data.committedQuantity;
        if (reserved?.increment) state.counter.reservedQuantity += reserved.increment;
        if (reserved?.decrement) state.counter.reservedQuantity -= reserved.decrement;
        if (committed?.increment) state.counter.committedQuantity += committed.increment;
        state.counter.version += args.data.version.increment;
        return { count: 1 };
      }),
    },
    usageReservation: {
      findUnique: vi.fn(async (args: { where: { sourceKey: string } }) => state.reservations.get(args.where.sourceKey) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
        const reservation = {
          id: `reservation-${state.nextReservationId++}`,
          ...data,
          status: "RESERVED",
          committedUsageEventId: null,
        };
        state.reservations.set(data.sourceKey, reservation);
        return reservation;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
        const reservation = [...state.reservations.values()].find((value) => value.id === where.id)!;
        Object.assign(reservation, data);
        return reservation;
      }),
    },
    usageEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
        const event = { id: `usage-${state.nextUsageId++}`, ...data };
        state.usageEvents.push(event);
        return event;
      }),
    },
  };

  const database = {
    ...transaction,
    $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction)),
  };
  const policy = {
    shopId,
    subscriptionId,
    planKind: "PAID_METERED" as const,
    billingPeriod: {
      id: state.period.id,
      shopId: state.period.shopId,
      subscriptionId: state.period.subscriptionId,
      start: state.period.periodStart,
      end: state.period.periodEnd,
      status: state.period.status,
      includedCounter: {
        id: state.counter.id,
        shopId: state.counter.shopId,
        billingPeriodId: state.counter.billingPeriodId,
        grantedQuantity: state.counter.grantedQuantity,
        committedQuantity: state.counter.committedQuantity,
        reservedQuantity: state.counter.reservedQuantity,
        forfeitedQuantity: state.counter.forfeitedQuantity,
      },
    },
  };
  const service = new PaidIncludedRecoveryReservationService(
    database as never,
    3,
    () => now,
    () => ({ resolve: vi.fn(async () => policy) }),
  );
  return { state, transaction, database, service, policy };
}

async function reserve(harness: Harness, recoveryId = "recovery-1") {
  return harness.service.reserve({ shopId, recoveryId });
}

describe("PaidIncludedRecoveryReservationService", () => {
  it("derives the period-scoped source key after current period validation", async () => {
    const harness = createHarness();
    await expect(reserve(harness)).resolves.toMatchObject({ sourceKey: "paid-included:period-1:recovery-1" });
  });

  it("does not double-increment a duplicate reserve", async () => {
    const harness = createHarness();
    await reserve(harness);
    await expect(reserve(harness)).resolves.toMatchObject({ kind: "already-reserved" });
    expect(harness.state.counter.reservedQuantity).toBe(1);
  });

  it("uses a different source key when the same recovery enters a different period", async () => {
    const harness = createHarness(2);
    await reserve(harness);
    await harness.service.release({ shopId, sourceKey: "paid-included:period-1:recovery-1" });
    harness.state.period = { ...harness.state.period, id: "period-2", periodStart: new Date("2026-10-01T00:00:00.000Z"), periodEnd: new Date("2026-11-01T00:00:00.000Z") };
    harness.state.subscription.billingPeriodId = "period-2";
    harness.state.subscription.currentPeriodStart = harness.state.period.periodStart;
    harness.state.subscription.currentPeriodEnd = harness.state.period.periodEnd;
    harness.state.counter = { ...harness.state.counter, id: "period-counter-2", billingPeriodId: "period-2", reservedQuantity: 0, version: 2 };
    harness.policy.billingPeriod = {
      ...harness.policy.billingPeriod,
      id: "period-2",
      start: harness.state.period.periodStart,
      end: harness.state.period.periodEnd,
      includedCounter: {
        ...harness.policy.billingPeriod.includedCounter,
        id: "period-counter-2",
        billingPeriodId: "period-2",
      },
    };
    await expect(reserve(harness)).resolves.toMatchObject({ sourceKey: "paid-included:period-2:recovery-1" });
  });

  it("returns allowance exhausted without creating overage", async () => {
    const harness = createHarness(0);
    await expect(reserve(harness)).resolves.toMatchObject({ kind: "allowance-exhausted", remaining: 0 });
    expect(harness.state.reservations.size).toBe(0);
  });

  it("fails closed when the included counter is missing", async () => {
    const harness = createHarness();
    harness.state.counter = null as never;
    await expect(reserve(harness)).rejects.toBeInstanceOf(PaidIncludedRecoveryReservationError);
  });

  it("fails closed for a closed period", async () => {
    const harness = createHarness();
    harness.state.period.status = "CLOSED" as never;
    await expect(reserve(harness)).rejects.toBeInstanceOf(PaidIncludedRecoveryReservationError);
  });

  it("fails closed for an expired open period", async () => {
    const harness = createHarness();
    harness.state.period.periodEnd = new Date("2026-09-10T00:00:00.000Z");
    await expect(reserve(harness)).rejects.toBeInstanceOf(PaidIncludedRecoveryReservationError);
  });

  it("fails closed for subscription and period boundary mismatch", async () => {
    const harness = createHarness();
    harness.state.subscription.currentPeriodEnd = new Date("2026-10-02T00:00:00.000Z");
    await expect(reserve(harness)).rejects.toBeInstanceOf(PaidIncludedRecoveryReservationError);
  });

  it("fails closed for shop, subscription, or counter identity mismatch", async () => {
    const harness = createHarness();
    harness.state.period.subscriptionId = "other-subscription";
    await expect(reserve(harness)).rejects.toBeInstanceOf(PaidIncludedRecoveryReservationError);

    const second = createHarness();
    second.state.counter.shopId = "other-shop";
    await expect(reserve(second)).rejects.toBeInstanceOf(PaidIncludedRecoveryReservationError);
  });

  it("moves a reserved row to committed exactly once", async () => {
    const harness = createHarness();
    await reserve(harness);
    await expect(harness.service.commit({ shopId, sourceKey: "paid-included:period-1:recovery-1" })).resolves.toMatchObject({ kind: "committed" });
    await expect(harness.service.commit({ shopId, sourceKey: "paid-included:period-1:recovery-1" })).resolves.toMatchObject({ kind: "already-committed" });
    expect(harness.state.counter).toMatchObject({ committedQuantity: 1, reservedQuantity: 0 });
  });

  it("creates one exact paid pending UsageEvent on commit", async () => {
    const harness = createHarness();
    await reserve(harness);
    await harness.service.commit({ shopId, sourceKey: "paid-included:period-1:recovery-1" });
    expect(harness.state.usageEvents).toHaveLength(1);
    expect(harness.state.usageEvents[0]).toMatchObject({
      billingPeriodId: "period-1",
      metric: "RECOVERY_CONVERSATION",
      shopifyReportState: "PENDING",
      shopifyEventHandle: "paid-meter",
      quantity: 1,
    });
  });

  it("does not create a second event or increment on duplicate commit", async () => {
    const harness = createHarness();
    await reserve(harness);
    await harness.service.commit({ shopId, sourceKey: "paid-included:period-1:recovery-1" });
    await harness.service.commit({ shopId, sourceKey: "paid-included:period-1:recovery-1" });
    expect(harness.state.usageEvents).toHaveLength(1);
    expect(harness.state.counter.committedQuantity).toBe(1);
  });

  it("releases definitive failure capacity once", async () => {
    const harness = createHarness();
    await reserve(harness);
    await expect(harness.service.release({ shopId, sourceKey: "paid-included:period-1:recovery-1" })).resolves.toMatchObject({ kind: "released" });
    await expect(harness.service.release({ shopId, sourceKey: "paid-included:period-1:recovery-1" })).resolves.toMatchObject({ kind: "already-released" });
    expect(harness.state.counter.reservedQuantity).toBe(0);
  });

  it("keeps ambiguous capacity protected", async () => {
    const harness = createHarness();
    await reserve(harness);
    await expect(harness.service.markAmbiguous({ shopId, sourceKey: "paid-included:period-1:recovery-1" })).resolves.toMatchObject({ kind: "ambiguous" });
    expect(harness.state.counter.reservedQuantity).toBe(1);
  });

  it("rejects release of a committed reservation", async () => {
    const harness = createHarness();
    await reserve(harness);
    await harness.service.commit({ shopId, sourceKey: "paid-included:period-1:recovery-1" });
    await expect(harness.service.release({ shopId, sourceKey: "paid-included:period-1:recovery-1" })).rejects.toBeInstanceOf(PaidIncludedRecoveryReservationError);
  });

  it("rejects commit after the owning period closes", async () => {
    const harness = createHarness();
    await reserve(harness);
    harness.state.period.status = "CLOSED" as never;
    await expect(harness.service.commit({ shopId, sourceKey: "paid-included:period-1:recovery-1" })).rejects.toBeInstanceOf(PaidIncludedRecoveryReservationError);
  });

  it("retries bounded CAS and unique conflicts", async () => {
    const harness = createHarness();
    let failures = 0;
    harness.database.$transaction = vi.fn(async (callback: (client: typeof harness.transaction) => Promise<unknown>) => {
      if (failures++ < 2) {
        throw new Prisma.PrismaClientKnownRequestError("serialization conflict", { code: "P2034", clientVersion: "test" });
      }
      return callback(harness.transaction);
    }) as never;
    await expect(reserve(harness)).resolves.toMatchObject({ kind: "reserved" });
    expect(harness.database.$transaction).toHaveBeenCalledTimes(3);
  });
});
