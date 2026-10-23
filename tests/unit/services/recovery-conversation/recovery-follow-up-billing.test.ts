import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/lib/db.js", () => ({ default: {} }));
import {
  inspectFollowUpCredit, RecoveryFollowUpBillingService,
  type PersistedFollowUpReservation,
} from "../../../../src/services/recovery-conversation/recovery-follow-up-billing.service.js";
import type { SqlTransaction } from
  "../../../../src/services/recovery-conversation/recovery-conversation.sql.js";
import { purchasedRecoveryReservationService } from
  "../../../../src/services/purchased-recovery-reservation.service.js";

const input = { shopId: "shop", attemptId: "attempt" };
const logicalKey = createRecoveryIdempotencyKey(input.shopId, `recovery-outreach:${input.attemptId}`);
const periodKey = `paid-included:period:${logicalKey}`;

type Reservation = {
  id?: string; shopId?: string; sourceKey?: string; status?: string; quantity?: number;
  counterId?: string | null; counterKind?: string | null; counterShopId?: string | null;
  billingPeriodEntitlementCounterId?: string | null; periodCounterKind?: string | null;
  periodCounterShopId?: string | null; billingPeriodId?: string | null;
  purchasedCreditPurchaseId?: string | null; purchaseShopId?: string | null;
  promotionalCreditGrantId?: string | null; promotionalShopId?: string | null;
  committedUsageEventId?: string | null; compensationUsageEventId?: string | null;
  expired?: boolean;
};
const free = { counterId: "counter", counterKind: "LIFETIME_FREE_RECOVERY_CREDITS" };
const purchased = {
  counterId: "purchased-counter", counterKind: "PURCHASED_RECOVERY_CREDITS",
  purchasedCreditPurchaseId: "exact-original-lot",
};
const paid = {
  billingPeriodEntitlementCounterId: "period-counter",
  periodCounterKind: "INCLUDED_RECOVERY_CREDITS", billingPeriodId: "period",
  sourceKey: periodKey,
};
const promotional = { promotionalCreditGrantId: "grant" };

function fixture(reservations: Reservation[] = [], usage = false) {
  return {
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes('FROM "billing"."UsageReservation"')) return reservations.map((r) => ({
        id: "reservation", shopId: "shop", sourceKey: logicalKey, status: "RESERVED", quantity: 1,
        counterId: null, counterKind: null, counterShopId: r.counterId ? "shop" : null,
        billingPeriodEntitlementCounterId: null, periodCounterKind: null,
        periodCounterShopId: r.billingPeriodEntitlementCounterId ? "shop" : null,
        billingPeriodId: null, purchasedCreditPurchaseId: null,
        purchaseShopId: r.purchasedCreditPurchaseId ? "shop" : null,
        promotionalCreditGrantId: null, promotionalShopId: r.promotionalCreditGrantId ? "shop" : null,
        committedUsageEventId: null, compensationUsageEventId: null,
        expired: false, ...r,
      }));
      if (sql.includes('FROM "billing"."UsageEvent"')) return usage ? [{ id: "usage" }] : [];
      throw new Error("Unexpected billing SQL query");
    }),
  } as unknown as SqlTransaction;
}

async function state(record: Reservation, usage = false) {
  return inspectFollowUpCredit(fixture([record], usage), input);
}

describe("ARCH-040-BACKGROUND-009 persisted recovery credit source", () => {
  it("checks for settled usage before treating an absent reservation as clear", async () => {
    expect(await inspectFollowUpCredit(fixture(), input)).toEqual({ kind: "clear" });
    expect(await inspectFollowUpCredit(fixture([], true), input)).toEqual({ kind: "unsafe" });
  });

  it("recognises a purchased lot's paired aggregate and purchase foreign keys", async () => {
    expect(await state(purchased)).toEqual({ kind: "reserved", admission: {
      kind: "persisted", shopId: "shop", sourceKey: logicalKey, quantity: 1, capacity: "purchased",
    } });
  });

  it("preserves the existing free, paid-included and promotional capacity shapes", async () => {
    for (const [row, capacity] of [
      [free, "free"], [paid, "paid"], [promotional, "promotional"],
    ] as const) {
      expect(await state(row)).toEqual({ kind: "reserved", admission: {
        kind: "persisted", shopId: "shop", sourceKey: row === paid ? periodKey : logicalKey,
        quantity: 1, capacity,
      } });
    }
  });

  it("fails closed for purchased lots without their exact paired source and tenant", async () => {
    for (const invalid of [
      { ...purchased, counterId: null },
      { ...purchased, counterKind: "LIFETIME_FREE_RECOVERY_CREDITS" },
      { ...purchased, counterKind: null },
      { ...purchased, purchaseShopId: "different-shop" },
      { ...purchased, counterShopId: "different-shop" },
      { ...purchased, purchasedCreditPurchaseId: null },
      { ...purchased, purchaseShopId: null },
      { ...purchased, billingPeriodEntitlementCounterId: "period-counter" },
      { ...purchased, promotionalCreditGrantId: "grant" },
      { ...purchased, quantity: 2 },
      { ...purchased, quantity: 0 },
      { ...purchased, shopId: "different-shop" },
      { ...purchased, sourceKey: "different-original-credit" },
    ]) {
      expect(await state(invalid)).toEqual({ kind: "unsafe" });
    }
  });

  it("rejects mixed sources, broken period/Shop links and incorrect counter kinds", async () => {
    for (const invalid of [
      { ...free, purchasedCreditPurchaseId: "lot" },
      { ...free, counterKind: "PURCHASED_RECOVERY_CREDITS" },
      { ...paid, periodCounterShopId: "different-shop" },
      { ...paid, periodCounterKind: null },
      { ...paid, billingPeriodId: "different-period" },
      { ...promotional, promotionalShopId: "different-shop" },
      { ...promotional, counterId: "counter" },
    ]) expect(await state(invalid)).toEqual({ kind: "unsafe" });
  });

  it("rejects duplicate, committed, compensated, ambiguous and expired sources", async () => {
    for (const invalid of [
      { ...purchased, status: "COMMITTED" },
      { ...purchased, status: "AMBIGUOUS" },
      { ...purchased, committedUsageEventId: "event" },
      { ...purchased, compensationUsageEventId: "compensation" },
      { ...purchased, expired: true },
      { ...purchased, status: "RELEASED", purchaseShopId: "another-shop" },
    ]) expect(await state(invalid)).toEqual({ kind: "unsafe" });
    expect(await state(purchased, true)).toEqual({ kind: "unsafe" });
    expect(await inspectFollowUpCredit(fixture([purchased, { ...purchased, id: "other" }]), input))
      .toEqual({ kind: "unsafe" });
  });

  it("recognises a durable released original purchased reservation without re-releasing", async () => {
    expect(await state({ ...purchased, status: "RELEASED" })).toEqual({ kind: "clear" });
  });

  it("uses the actual purchased reservation release owner rather than free-credit accounting", async () => {
    const spy = vi.spyOn(purchasedRecoveryReservationService, "release")
      .mockResolvedValue({ kind: "released", reservation: {} as never });
    try {
      const service = new RecoveryFollowUpBillingService({} as never);
      await service.releaseBeforePermit({
        kind: "persisted", shopId: input.shopId, sourceKey: logicalKey,
        capacity: "purchased", quantity: 1,
      });
      expect(spy).toHaveBeenCalledExactlyOnceWith({
        shopId: input.shopId, sourceKey: logicalKey, quantity: 1,
      });
    } finally { spy.mockRestore(); }
  });

  it("delegates exact persisted purchased source to the existing release owner", async () => {
    const release = vi.fn(async (_input: PersistedFollowUpReservation) => {});
    const service = new RecoveryFollowUpBillingService({} as never, release);
    const credit = await state(purchased);
    expect(credit.kind).toBe("reserved");
    if (credit.kind !== "reserved") throw new Error("expected purchased capacity");
    await service.releaseBeforePermit(credit.admission);
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith({
      kind: "persisted", shopId: input.shopId, sourceKey: logicalKey,
      capacity: "purchased", quantity: 1,
    });
  });
});
