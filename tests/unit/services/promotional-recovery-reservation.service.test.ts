import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  PromotionalRecoveryReservationError,
  PromotionalRecoveryReservationService,
} from "../../../src/services/promotional-recovery-reservation.service.js";

const shopId = "shop-1";
const otherShopId = "shop-2";
const planId = "plan-1";
const now = new Date("2026-09-15T00:00:00.000Z");

type HarnessOptions = {
  scope?: "GLOBAL" | "SHOP" | "PLAN";
  targetShopId?: string | null;
  targetPlanId?: string | null;
  status?: "ACTIVE" | "CLOSED";
  startsAt?: Date;
  expiresAt?: Date;
  quantity?: number;
  committedQuantity?: number;
  reservedQuantity?: number;
  exhaustedAt?: Date | null;
  grantShopId?: string;
  selected?: boolean;
  paused?: boolean;
};

function createHarness(options: HarnessOptions = {}) {
  const state = {
    grant: {
      id: "grant-1",
      shopId: options.grantShopId ?? shopId,
      campaignId: "campaign-1",
      quantity: options.quantity ?? 2,
      reservedQuantity: options.reservedQuantity ?? 0,
      committedQuantity: options.committedQuantity ?? 0,
      firstSelectedAt: new Date("2026-09-01T00:00:00.000Z"),
      lastSelectedAt: new Date("2026-09-02T00:00:00.000Z"),
      selectionCount: 7,
      firstUsedAt: null as Date | null,
      lastUsedAt: null as Date | null,
      exhaustedAt: options.exhaustedAt ?? null,
      version: 0,
    },
    campaign: {
      id: "campaign-1",
      status: options.status ?? "ACTIVE",
      scope: options.scope ?? "GLOBAL",
      targetShopId: options.targetShopId ?? null,
      targetPlanId: options.targetPlanId ?? null,
      startsAt: options.startsAt ?? new Date("2026-09-01T00:00:00.000Z"),
      expiresAt: options.expiresAt ?? new Date("2026-10-01T00:00:00.000Z"),
    },
    reservations: new Map<string, any>(),
    usageEvents: [] as any[],
    nextReservationId: 1,
    nextUsageEventId: 1,
  };

  const transaction = {
    merchantPromotionSelection: {
      findUnique: vi.fn(async () => options.selected === false ? null : {
        shopId,
        promotionalCreditGrantId: state.grant.id,
        promotionalCreditGrant: { ...state.grant, campaign: state.campaign },
      }),
    },
    promotionalCreditGrant: {
      findUnique: vi.fn(async () => ({ ...state.grant, campaign: state.campaign })),
      updateMany: vi.fn(async (args: any) => {
        if (args.where.id !== state.grant.id || args.where.version !== state.grant.version) return { count: 0 };
        if (args.where.reservedQuantity?.gte > state.grant.reservedQuantity) return { count: 0 };
        if (args.where.reservedQuantity?.lte > state.grant.quantity - state.grant.committedQuantity - args.data.reservedQuantity.increment) return { count: 0 };
        const data = args.data;
        if (data.reservedQuantity?.increment) state.grant.reservedQuantity += data.reservedQuantity.increment;
        if (data.reservedQuantity?.decrement) state.grant.reservedQuantity -= data.reservedQuantity.decrement;
        if (data.committedQuantity?.increment) state.grant.committedQuantity += data.committedQuantity.increment;
        for (const field of ["firstUsedAt", "lastUsedAt", "exhaustedAt"]) {
          if (field in data && data[field] !== undefined) state.grant[field] = data[field];
        }
        state.grant.version += data.version.increment;
        return { count: 1 };
      }),
    },
    usageReservation: {
      findUnique: vi.fn(async (args: any) => state.reservations.get(args.where.sourceKey) ?? null),
      create: vi.fn(async ({ data }: any) => {
        const reservation = { id: `reservation-${state.nextReservationId++}`, ...data, status: "RESERVED", committedUsageEventId: null };
        state.reservations.set(data.sourceKey, reservation);
        return reservation;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const reservation = [...state.reservations.values()].find((value) => value.id === where.id);
        Object.assign(reservation, data);
        return reservation;
      }),
    },
    usageEvent: {
      create: vi.fn(async ({ data }: any) => {
        const event = { id: `usage-${state.nextUsageEventId++}`, ...data };
        state.usageEvents.push(event);
        return event;
      }),
    },
  };
  const database = {
    ...transaction,
    $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction)),
  };
  const service = new PromotionalRecoveryReservationService(
    database as never,
    3,
    () => now,
    () => ({ resolve: vi.fn(async () => ({ planId, newRecoveriesPaused: options.paused ?? false })) } as never),
  );
  return { state, transaction, database, service };
}

const input = (sourceKey = "recovery-1", overrides: Record<string, unknown> = {}) => ({
  shopId,
  planId,
  sourceKey,
  now,
  ...overrides,
});

function prismaConflict(code: "P2002" | "P2034") {
  return new Prisma.PrismaClientKnownRequestError("injected reservation conflict", {
    code,
    clientVersion: "6.19.3",
  });
}

describe("PromotionalRecoveryReservationService", () => {
  it.each([
    ["GLOBAL", {}],
    ["SHOP", { targetShopId: shopId }],
    ["PLAN", { targetPlanId: planId }],
  ])("reserves an eligible %s campaign selection", async (_scope, options) => {
    const harness = createHarness({ scope: _scope as HarnessOptions["scope"], ...options });
    await expect(harness.service.reserve(input())).resolves.toMatchObject({ kind: "reserved" });
    expect(harness.state.grant.reservedQuantity).toBe(1);
  });

  it.each([
    { scope: "SHOP" as const, targetShopId: otherShopId },
    { scope: "PLAN" as const, targetPlanId: "other-plan" },
    { scope: "GLOBAL" as const, targetShopId: otherShopId },
  ])("rejects an ineligible %s target", async (options) => {
    const harness = createHarness(options);
    await expect(harness.service.reserve(input())).resolves.toMatchObject({ kind: "unavailable" });
  });

  it.each([
    { status: "CLOSED" as const },
    { startsAt: new Date("2026-09-16T00:00:00.000Z") },
    { expiresAt: now },
    { selected: false },
    { paused: true },
    { quantity: 1, committedQuantity: 1 },
  ])("fails closed when the promotional grant is not usable", async (options) => {
    const harness = createHarness(options);
    await expect(harness.service.reserve(input())).resolves.toMatchObject({ kind: "unavailable" });
  });

  it("does not mutate selection history during reservation", async () => {
    const harness = createHarness();
    const before = { ...harness.state.grant };
    await harness.service.reserve(input());
    expect(harness.state.grant).toMatchObject({
      firstSelectedAt: before.firstSelectedAt,
      lastSelectedAt: before.lastSelectedAt,
      selectionCount: before.selectionCount,
    });
  });

  it("retries a CAS conflict and returns the successful reservation", async () => {
    const harness = createHarness();
    harness.transaction.promotionalCreditGrant.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockImplementationOnce(async (args: any) => {
        harness.state.grant.reservedQuantity += args.data.reservedQuantity.increment;
        harness.state.grant.version += args.data.version.increment;
        return { count: 1 };
      });

    await expect(harness.service.reserve(input())).resolves.toMatchObject({ kind: "reserved" });
    expect(harness.transaction.promotionalCreditGrant.updateMany).toHaveBeenCalledTimes(2);
    expect(harness.state.grant.reservedQuantity).toBe(1);
  });

  it("retries injected Prisma serialization and unique conflicts", async () => {
    const serializationHarness = createHarness();
    serializationHarness.database.$transaction
      .mockRejectedValueOnce(prismaConflict("P2034"))
      .mockImplementationOnce(async (callback: (client: typeof serializationHarness.transaction) => Promise<unknown>) =>
        callback(serializationHarness.transaction));
    await expect(serializationHarness.service.reserve(input())).resolves.toMatchObject({ kind: "reserved" });

    const uniqueHarness = createHarness();
    uniqueHarness.transaction.usageReservation.create
      .mockRejectedValueOnce(prismaConflict("P2002"))
      .mockImplementationOnce(async ({ data }: any) => {
        const reservation = { id: `reservation-${uniqueHarness.state.nextReservationId++}`, ...data, status: "RESERVED", committedUsageEventId: null };
        uniqueHarness.state.reservations.set(data.sourceKey, reservation);
        return reservation;
      });
    await expect(uniqueHarness.service.reserve(input())).resolves.toMatchObject({ kind: "reserved" });
    expect(uniqueHarness.transaction.usageReservation.create).toHaveBeenCalledTimes(2);
  });

  it("stops after the configured retry budget is exhausted", async () => {
    const harness = createHarness();
    harness.database.$transaction.mockRejectedValue(prismaConflict("P2034"));

    await expect(harness.service.reserve(input())).rejects.toMatchObject({ code: "P2034" });
    expect(harness.database.$transaction).toHaveBeenCalledTimes(3);
  });

  it("keeps selection history unchanged across commit and release", async () => {
    const harness = createHarness();
    const before = {
      firstSelectedAt: harness.state.grant.firstSelectedAt,
      lastSelectedAt: harness.state.grant.lastSelectedAt,
      selectionCount: harness.state.grant.selectionCount,
    };

    await harness.service.reserve(input());
    await harness.service.commit(input());
    await harness.service.reserve(input("recovery-2"));
    await harness.service.release(input("recovery-2"));

    expect(harness.state.grant).toMatchObject(before);
  });

  it("owns exact promotional reservation replays and rejects non-promotional ownership", async () => {
    const harness = createHarness();
    await harness.service.reserve(input());
    await expect(harness.service.reserve(input())).resolves.toMatchObject({ kind: "already-reserved" });
    harness.state.reservations.set("non-promo", { id: "other", shopId, promotionalCreditGrantId: null, status: "RESERVED", quantity: 1 });
    await expect(harness.service.commit(input("non-promo"))).rejects.toBeInstanceOf(PromotionalRecoveryReservationError);
  });

  it("commits once, records a non-Shopify usage event, and exhausts only at zero", async () => {
    const harness = createHarness({ quantity: 2 });
    await harness.service.reserve(input());
    await expect(harness.service.commit(input())).resolves.toMatchObject({ kind: "committed" });
    expect(harness.state.grant).toMatchObject({ committedQuantity: 1, reservedQuantity: 0, exhaustedAt: null });
    expect(harness.state.grant.firstUsedAt).toEqual(now);
    expect(harness.state.usageEvents[0]).toMatchObject({
      metric: "RECOVERY_CONVERSATION",
      sourceType: "PROMOTIONAL_RECOVERY_CREDITS",
      shopifyReportState: "NOT_APPLICABLE",
    });
    await expect(harness.service.commit(input())).resolves.toMatchObject({ kind: "already-committed" });

    await harness.service.reserve(input("recovery-2"));
    await harness.service.commit(input("recovery-2"));
    expect(harness.state.grant.exhaustedAt).toEqual(now);
    expect(harness.state.grant.selectionCount).toBe(7);
  });

  it("preserves historical exhaustion and rejects shop mismatches", async () => {
    const historical = new Date("2026-09-10T00:00:00.000Z");
    const harness = createHarness({ quantity: 1, exhaustedAt: historical });
    await harness.service.reserve(input());
    await harness.service.commit(input());
    expect(harness.state.grant.exhaustedAt).toEqual(historical);
    await expect(harness.service.reserve(input("other", { shopId: otherShopId }))).resolves.toMatchObject({ kind: "unavailable" });
  });

  it("releases capacity, protects ambiguous capacity, and prevents committed release", async () => {
    const harness = createHarness();
    await harness.service.reserve(input());
    await expect(harness.service.release(input())).resolves.toMatchObject({ kind: "released" });
    await expect(harness.service.release(input())).resolves.toMatchObject({ kind: "already-released" });
    await harness.service.reserve(input("recovery-2"));
    await expect(harness.service.markAmbiguous(input("recovery-2"))).resolves.toMatchObject({ kind: "ambiguous" });
    expect(harness.state.grant.reservedQuantity).toBe(1);
    await expect(harness.service.release(input("recovery-2"))).resolves.toMatchObject({ kind: "already-ambiguous" });

    await harness.service.reserve(input("recovery-3"));
    await harness.service.commit(input("recovery-3"));
    await expect(harness.service.release(input("recovery-3"))).rejects.toBeInstanceOf(PromotionalRecoveryReservationError);
  });

  it("does not reactivate a released reservation while unusable, then reactivates it after reopening", async () => {
    const harness = createHarness();
    await harness.service.reserve(input());
    await harness.service.release(input());

    harness.state.campaign.expiresAt = now;
    await expect(harness.service.reserve(input())).resolves.toMatchObject({ kind: "already-released" });
    expect(harness.state.grant.reservedQuantity).toBe(0);

    harness.state.campaign.expiresAt = new Date("2026-10-01T00:00:00.000Z");
    await expect(harness.service.reserve(input())).resolves.toMatchObject({ kind: "reserved" });
    expect(harness.state.grant.reservedQuantity).toBe(1);
  });

  it.each([
    { name: "closed campaign", campaign: { status: "CLOSED" as const } },
    { name: "plan mismatch", campaign: { scope: "PLAN" as const, targetPlanId: "other-plan" } },
    { name: "changed selection", selected: false },
  ])("keeps a released reservation ineligible after $name", async ({ campaign, selected }) => {
    const harness = createHarness();
    await harness.service.reserve(input());
    await harness.service.release(input());
    Object.assign(harness.state.campaign, campaign);
    if (selected === false) {
      harness.transaction.merchantPromotionSelection.findUnique.mockResolvedValue(null);
    }

    await expect(harness.service.reserve(input())).resolves.toMatchObject({ kind: "already-released" });
    expect(harness.state.grant.reservedQuantity).toBe(0);
  });

  it.each([
    { name: "expiry", expiresAt: now },
    { name: "closed status", status: "CLOSED" as const },
  ])("commits an existing reservation after $name", async ({ expiresAt, status }) => {
    const harness = createHarness();
    await harness.service.reserve(input());
    Object.assign(harness.state.campaign, { expiresAt, status });

    await expect(harness.service.commit(input())).resolves.toMatchObject({ kind: "committed" });
    expect(harness.state.grant).toMatchObject({ committedQuantity: 1, reservedQuantity: 0 });
  });

  it("keeps duplicate reserve and release idempotent and owns the exact grant", async () => {
    const harness = createHarness();
    await harness.service.reserve(input());
    const reservation = harness.state.reservations.get("recovery-1");
    expect(reservation.promotionalCreditGrantId).toBe(harness.state.grant.id);
    await expect(harness.service.reserve(input())).resolves.toMatchObject({ kind: "already-reserved" });
    await expect(harness.service.release(input())).resolves.toMatchObject({ kind: "released" });
    await expect(harness.service.release(input())).resolves.toMatchObject({ kind: "already-released" });
    expect(harness.state.grant.reservedQuantity).toBe(0);
  });

  it("does not convert a same-source non-promotional reservation", async () => {
    const harness = createHarness();
    harness.state.reservations.set("non-promo", {
      id: "reservation-non-promo",
      shopId,
      sourceKey: "non-promo",
      quantity: 1,
      promotionalCreditGrantId: null,
      status: "RELEASED",
    });

    await expect(harness.service.reserve(input("non-promo"))).resolves.toEqual({ kind: "unavailable" });
    expect(harness.state.grant.reservedQuantity).toBe(0);
  });
});
