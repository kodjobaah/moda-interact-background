import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/lib/db.js", () => ({ default: {} }));
import {
  inspectFollowUpCredit, RecoveryFollowUpBillingService,
  type PersistedFollowUpReservation,
} from "../../../../src/services/recovery-conversation/recovery-follow-up-billing.service.js";
import type { SqlTransaction } from
  "../../../../src/services/recovery-conversation/recovery-conversation.sql.js";

function fixture(reservations: Array<{
  id?: string; sourceKey: string; status: string; quantity?: number;
  counterId?: string | null; counterKind?: string | null;
  billingPeriodEntitlementCounterId?: string | null;
  purchasedCreditPurchaseId?: string | null;
  promotionalCreditGrantId?: string | null;
  committedUsageEventId?: string | null; compensationUsageEventId?: string | null;
}> = [], usage = false) {
  const db = {
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes('FROM "billing"."UsageReservation"')) return reservations.map((r) => ({
        id: "reservation", quantity: 1, counterId: null, counterKind: null,
        billingPeriodEntitlementCounterId: null, periodCounterKind: null,
        purchasedCreditPurchaseId: null,
        promotionalCreditGrantId: null, committedUsageEventId: null,
        compensationUsageEventId: null, ...r,
      }));
      if (sql.includes('FROM "billing"."UsageEvent"')) return usage ? [{ id: "usage" }] : [];
      throw new Error("Unexpected billing SQL query");
    }),
  } as unknown as SqlTransaction;
  return db;
}
const input = { shopId: "shop", attemptId: "attempt" };

describe("ARCH-040 persisted recovery credit reconciliation", () => {
  it("proves no existing reservation and no settled usage before declaring a clear credit", async () => {
    const db = fixture();
    expect(await inspectFollowUpCredit(db, input)).toEqual({ kind: "clear" });
    expect(await inspectFollowUpCredit(fixture([], true), input)).toEqual({ kind: "unsafe" });
  });

  it("classifies the actual persisted capacity source, including period-qualified included credit", async () => {
    const variants = [
      [{ counterId: "counter", counterKind: "LIFETIME_FREE_RECOVERY_CREDITS", sourceKey: "free" }, "free"],
      [{ purchasedCreditPurchaseId: "purchase", sourceKey: "purchased" }, "purchased"],
      [{ promotionalCreditGrantId: "grant", sourceKey: "promotional" }, "promotional"],
      [{ billingPeriodEntitlementCounterId: "period", periodCounterKind: "INCLUDED_RECOVERY_CREDITS", sourceKey: "paid-included:period:credit" }, "paid"],
    ] as const;
    for (const [record, capacity] of variants) {
      expect(await inspectFollowUpCredit(fixture([{ ...record, status: "RESERVED" }]), input))
        .toEqual({ kind: "reserved", admission: {
          kind: "persisted", shopId: "shop", sourceKey: record.sourceKey,
          quantity: 1, capacity,
        } });
    }
  });

  it("fails closed on ambiguous, settled, double or invalid-capacity reservations", async () => {
    const reserved = { sourceKey: "credit", status: "RESERVED", counterId: "counter",
      counterKind: "LIFETIME_FREE_RECOVERY_CREDITS" };
    for (const db of [
      fixture([{ ...reserved, status: "AMBIGUOUS" }]),
      fixture([{ ...reserved, committedUsageEventId: "event" }]),
      fixture([reserved, { ...reserved, id: "other" }]),
      fixture([{ ...reserved, counterId: null }]),
      fixture([{ ...reserved, quantity: 2 }]),
      fixture([{ billingPeriodEntitlementCounterId: "period", sourceKey: "paid-included:period:credit", status: "RESERVED" }]),
      fixture([reserved], true),
    ]) {
      expect(await inspectFollowUpCredit(db, input)).toEqual({ kind: "unsafe" });
    }
  });

  it("uses releaseBeforePermit's injected persisted-reservation release without fabricating policy", async () => {
    const released = vi.fn(async (_input: PersistedFollowUpReservation) => {});
    const service = new RecoveryFollowUpBillingService({} as never, released);
    const admission: PersistedFollowUpReservation = {
      kind: "persisted", shopId: "shop", sourceKey: "credit", quantity: 1, capacity: "paid",
    };
    await service.releaseBeforePermit(admission);
    expect(released).toHaveBeenCalledWith(admission);
  });
});
