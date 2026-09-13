import { describe, expect, it, vi } from "vitest";

import { RecoveryBillingService } from "../../../src/services/recovery-billing.service.js";

function createDatabase() {
  const thread = { id: "thread-1" };
  const transactionMessageUpsert = vi.fn(async () => ({ id: "message-1" }));
  return {
    usageEvent: { upsert: vi.fn(async ({ create }: { create: unknown }) => ({ id: "usage-1", ...create })) },
    merchantSupportThread: {
      upsert: vi.fn(async () => thread),
      update: vi.fn(async () => thread),
    },
    merchantSupportMessage: {
      upsert: vi.fn(async () => ({ id: "message-1" })),
    },
    $transaction: vi.fn(async (callback: (transaction: unknown) => unknown) =>
      callback({
        merchantSupportThread: {
          upsert: vi.fn(async () => thread),
          update: vi.fn(async () => thread),
        },
        merchantSupportMessage: {
          upsert: transactionMessageUpsert,
        },
      }),
    ),
      transactionMessageUpsert,
  };
}

function createIdempotentMessageDatabase() {
  const thread = { id: "thread-1" };
  const messages = new Map<string, { id: string }>();
  const messageUpsert = vi.fn(async ({ where }: { where: { sourceKey: string } }) => {
    const existing = messages.get(where.sourceKey);
    if (existing) return existing;
    const message = { id: `message-${messages.size + 1}` };
    messages.set(where.sourceKey, message);
    return message;
  });

  return {
    usageEvent: { upsert: vi.fn(async ({ create }: { create: unknown }) => ({ id: "usage-1", ...create })) },
    merchantSupportThread: {
      upsert: vi.fn(async () => thread),
      update: vi.fn(async () => thread),
    },
    merchantSupportMessage: { upsert: messageUpsert },
    $transaction: vi.fn(async (callback: (transaction: unknown) => unknown) =>
      callback({
        merchantSupportThread: {
          upsert: vi.fn(async () => thread),
          update: vi.fn(async () => thread),
        },
        merchantSupportMessage: { upsert: messageUpsert },
      }),
    ),
    messageUpsert,
    messages,
  };
}

function freePolicy() {
  return {
    shopId: "shop-1",
    subscriptionId: "subscription-1",
    planKind: "FREE" as const,
    newRecoveriesPaused: false,
    freeAllowance: {
      grant: 5,
      effective: 5,
      committed: 5,
      reserved: 0,
      remaining: 0,
    },
  };
}

function paidPolicy(
  phase: "ACTIVE" | "DRAINING" | "EXPIRED_RECONCILING" = "ACTIVE",
  periodId = "period-1",
) {
  return {
    shopId: "shop-1",
    planKind: "PAID_METERED" as const,
    planId: "plan-1",
    newRecoveriesPaused: false,
    shopifyUsageEventHandle: "basic-recovery-conversation",
    billingPeriod: { id: periodId, phase },
  };
}

function paidIncludedReservationService(
  outcome: "reserved" | "allowance-exhausted" = "reserved",
) {
  return {
    reserve: vi.fn(async ({ recoveryId }: { recoveryId: string }) =>
      outcome === "reserved"
        ? {
            kind: "reserved" as const,
            reservation: {},
            counter: "INCLUDED_RECOVERY_CREDITS" as const,
            sourceKey: `paid-included:${paidPolicy().billingPeriod?.id}:${recoveryId}`,
            policy: paidPolicy(),
          }
        : { kind: "allowance-exhausted" as const, remaining: 0, policy: paidPolicy() },
    ),
    commit: vi.fn(),
    release: vi.fn(),
    markAmbiguous: vi.fn(),
  };
}

function unavailablePromotionalReservationService() {
  return {
    reserve: vi.fn(async () => ({ kind: "unavailable" as const })),
    commit: vi.fn(),
    release: vi.fn(),
    markAmbiguous: vi.fn(),
  };
}

function purchasedPack(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    creditsPerPack: 5,
    shopifyEventHandle: "recovery-pack",
    includedRecoveryConversationAllowance: null,
    normalRecoveryUsageQuantity: null,
    ...overrides,
  };
}

describe("RecoveryBillingService", () => {
  it("does not reserve paid included capacity while the billing period is draining", async () => {
    const purchasedReservationService = {
      reserve: vi.fn(async () => ({ kind: "reserved" as const, reservation: {} })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const paidReservationService = paidIncludedReservationService();
    const service = new RecoveryBillingService(
      createDatabase() as never,
      { resolve: vi.fn(async () => paidPolicy("DRAINING")) } as never,
      { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() } as never,
      purchasedReservationService as never,
      paidReservationService as never,
      unavailablePromotionalReservationService() as never,
    );

    await expect(service.admit({ shopId: "shop-1", recoveryId: "draining" }))
      .resolves.toMatchObject({ kind: "admitted", admission: { kind: "purchased" } });
    expect(paidReservationService.reserve).not.toHaveBeenCalled();
  });

  it("blocks an expired paid period with the reconciliation reason", async () => {
    const service = new RecoveryBillingService(
      createDatabase() as never,
      { resolve: vi.fn(async () => paidPolicy("EXPIRED_RECONCILING")) } as never,
    );

    await expect(service.admit({ shopId: "shop-1", recoveryId: "expired" }))
      .resolves.toEqual({ kind: "blocked", reason: "billing-period-reconciliation" });
  });

  it("uses the closing reason only after all DRAINING fallbacks are exhausted", async () => {
    const service = new RecoveryBillingService(
      createDatabase() as never,
      { resolve: vi.fn(async () => paidPolicy("DRAINING")) } as never,
      {
        reserve: vi.fn(async () => ({ kind: "allowance-exhausted" as const, remaining: 0 })),
        commit: vi.fn(),
        release: vi.fn(),
        markAmbiguous: vi.fn(),
      } as never,
      {
        reserve: vi.fn(async () => ({ kind: "credits-exhausted" as const, available: 0 })),
        commit: vi.fn(),
        release: vi.fn(),
        markAmbiguous: vi.fn(),
      } as never,
      paidIncludedReservationService("allowance-exhausted") as never,
      unavailablePromotionalReservationService() as never,
    );

    await expect(service.admit({ shopId: "shop-1", recoveryId: "draining-blocked" }))
      .resolves.toEqual({ kind: "blocked", reason: "billing-period-closing" });
  });

  it("preserves an included admission when the same period remains ACTIVE", async () => {
    const paidReservationService = paidIncludedReservationService();
    const service = new RecoveryBillingService(
      createDatabase() as never,
      { resolve: vi.fn(async () => paidPolicy("ACTIVE")) } as never,
      undefined as never,
      undefined as never,
      paidReservationService as never,
      unavailablePromotionalReservationService() as never,
    );
    const admitted = await service.admit({ shopId: "shop-1", recoveryId: "active" });
    if (admitted.kind !== "admitted") throw new Error("expected admission");

    const revalidated = await service.revalidateBeforeProvider({
      admission: admitted.admission,
      recoveryId: "active",
    });

    expect(revalidated).toEqual(admitted);
    expect(paidReservationService.release).not.toHaveBeenCalled();
    expect(paidReservationService.reserve).toHaveBeenCalledOnce();
  });

  it.each([
    "paid",
    "purchased",
    "free",
    "lifetime-free",
    "promotional",
  ] as const)("releases a %s admission when new recoveries become paused", async (kind) => {
    const release = vi.fn();
    const admission = {
      kind,
      sourceKey: `source-${kind}`,
      policy: { shopId: "shop-1", planId: "plan-1" },
    };
    const service = new RecoveryBillingService(
      createDatabase() as never,
      { resolve: vi.fn(async () => ({ newRecoveriesPaused: true })) } as never,
      { reserve: vi.fn(), commit: vi.fn(), release } as never,
      { reserve: vi.fn(), commit: vi.fn(), release } as never,
      { reserve: vi.fn(), commit: vi.fn(), release } as never,
      { reserve: vi.fn(), commit: vi.fn(), release } as never,
    );

    await expect(service.revalidateBeforeProvider({ admission, recoveryId: "paused" }))
      .resolves.toEqual({ kind: "blocked", reason: "paused" });
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases and re-admits included capacity when the period changes before the provider", async () => {
    const paidReservationService = paidIncludedReservationService();
    const policyResolver = {
      resolve: vi.fn()
        .mockResolvedValueOnce(paidPolicy("ACTIVE", "period-1"))
        .mockResolvedValueOnce(paidPolicy("ACTIVE", "period-2"))
        .mockResolvedValueOnce(paidPolicy("ACTIVE", "period-2")),
    };
    const service = new RecoveryBillingService(
      createDatabase() as never,
      policyResolver as never,
      undefined as never,
      undefined as never,
      paidReservationService as never,
      unavailablePromotionalReservationService() as never,
    );
    const admitted = await service.admit({ shopId: "shop-1", recoveryId: "rollover" });
    if (admitted.kind !== "admitted") throw new Error("expected admission");

    const revalidated = await service.revalidateBeforeProvider({
      admission: admitted.admission,
      recoveryId: "rollover",
    });

    expect(revalidated.kind).toBe("admitted");
    expect(paidReservationService.release).toHaveBeenCalledWith({
      shopId: "shop-1",
      sourceKey: "paid-included:period-1:rollover",
    });
    expect(paidReservationService.reserve).toHaveBeenCalledTimes(2);
  });

  it("BACKGROUND-008: revalidates an ACTIVE paid admission into DRAINING fallback order", async () => {
    const paidReservationService = {
      reserve: vi.fn()
        .mockResolvedValueOnce({ kind: "reserved" as const, reservation: {}, sourceKey: "paid-included:period-1:draining" })
        .mockResolvedValueOnce({ kind: "allowance-exhausted" as const, remaining: 0 }),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const purchasedReservationService = {
      reserve: vi.fn(async () => ({ kind: "credits-exhausted" as const, available: 0 })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const freeReservationService = {
      reserve: vi.fn(async () => ({ kind: "allowance-exhausted" as const, remaining: 0 })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const promotionalReservationService = unavailablePromotionalReservationService();
    const policyResolver = {
      resolve: vi.fn()
        .mockResolvedValueOnce(paidPolicy("ACTIVE", "period-1"))
        .mockResolvedValueOnce(paidPolicy("DRAINING", "period-1"))
        .mockResolvedValueOnce(paidPolicy("DRAINING", "period-1")),
    };
    const service = new RecoveryBillingService(
      createDatabase() as never,
      policyResolver as never,
      freeReservationService as never,
      purchasedReservationService as never,
      paidReservationService as never,
      promotionalReservationService as never,
    );

    const initial = await service.admit({ shopId: "shop-1", recoveryId: "draining" });
    if (initial.kind !== "admitted") throw new Error("expected initial paid admission");

    await expect(service.revalidateBeforeProvider({ admission: initial.admission, recoveryId: "draining" }))
      .resolves.toEqual({ kind: "blocked", reason: "billing-period-closing" });
    expect(paidReservationService.release).toHaveBeenCalledWith({
      shopId: "shop-1",
      sourceKey: "paid-included:period-1:draining",
    });
    expect(promotionalReservationService.reserve).toHaveBeenCalledTimes(2);
    expect(purchasedReservationService.reserve).toHaveBeenCalledOnce();
    expect(freeReservationService.reserve).toHaveBeenCalledOnce();
    expect(paidReservationService.reserve).toHaveBeenCalledOnce();
  });

  it.each([
    {
      kind: "paid" as const,
      sourceKey: "paid-included:period-1:expired-paid",
      releaseIndex: 2,
    },
    {
      kind: "purchased" as const,
      sourceKey: "purchased:expired-purchased",
      releaseIndex: 3,
    },
  ])("BACKGROUND-008: releases $kind admission during EXPIRED_RECONCILING", async ({ kind, sourceKey, releaseIndex }) => {
    const paidReservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const purchasedReservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const freeReservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const promotionalReservationService = unavailablePromotionalReservationService();
    const service = new RecoveryBillingService(
      createDatabase() as never,
      { resolve: vi.fn(async () => paidPolicy("EXPIRED_RECONCILING")) } as never,
      freeReservationService as never,
      purchasedReservationService as never,
      paidReservationService as never,
      promotionalReservationService as never,
    );
    const admission = {
      kind,
      sourceKey,
      policy: paidPolicy("ACTIVE"),
    } as never;

    await expect(service.revalidateBeforeProvider({ admission, recoveryId: kind }))
      .resolves.toEqual({ kind: "blocked", reason: "billing-period-reconciliation" });
    expect([freeReservationService, promotionalReservationService, paidReservationService, purchasedReservationService][releaseIndex].release)
      .toHaveBeenCalledOnce();
    expect(paidReservationService.reserve).not.toHaveBeenCalled();
    expect(purchasedReservationService.reserve).not.toHaveBeenCalled();
  });

  it("blocks exhausted Free admission and upserts one deterministic SYSTEM notification", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => freePolicy()) };
    const reservationService = {
      reserve: vi.fn(async () => ({ kind: "allowance-exhausted", remaining: 0 })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const purchasedReservationService = {
      reserve: vi.fn(async () => ({ kind: "credits-exhausted", available: 0 })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      reservationService as never,
      purchasedReservationService as never,
    );

    const first = await service.admit({ shopId: "shop-1", recoveryId: "recovery-1" });
    const second = await service.admit({ shopId: "shop-1", recoveryId: "recovery-1" });

    expect(first).toEqual({ kind: "blocked", reason: "allowance-exhausted" });
    expect(second).toEqual({ kind: "blocked", reason: "allowance-exhausted" });
    expect(database.merchantSupportMessage.upsert).toHaveBeenCalledTimes(0);
    expect(database.$transaction).toHaveBeenCalledTimes(2);
    expect(database.transactionMessageUpsert).toHaveBeenCalledTimes(2);
    expect(database.transactionMessageUpsert.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        where: { sourceKey: "billing-system:shop-1:BILLING_RECOVERY_CAPACITY_EXHAUSTED:capacity-exhausted:free-allowance:subscription-1:5:1" },
      }),
    );
    expect(database.transactionMessageUpsert.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        where: { sourceKey: "billing-system:shop-1:BILLING_RECOVERY_CAPACITY_EXHAUSTED:capacity-exhausted:free-allowance:subscription-1:5:1" },
      }),
    );
  });

  it("deduplicates exhaustion notifications by Free allowance lifecycle", async () => {
    const database = createIdempotentMessageDatabase();
    const policyResolver = {
      resolve: vi.fn()
        .mockResolvedValueOnce(freePolicy())
        .mockResolvedValueOnce(freePolicy())
        .mockResolvedValueOnce({
          ...freePolicy(),
          subscriptionId: "subscription-2",
          freeAllowance: { ...freePolicy().freeAllowance, grant: 4, effective: 4 },
        }),
    };
    const reservationService = {
      reserve: vi.fn(async () => ({ kind: "allowance-exhausted", remaining: 0 })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const purchasedReservationService = {
      reserve: vi.fn(async () => ({ kind: "credits-exhausted", available: 0 })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      reservationService as never,
      purchasedReservationService as never,
    );

    await service.admit({ shopId: "shop-1", recoveryId: "recovery-1" });
    await service.admit({ shopId: "shop-1", recoveryId: "recovery-2" });
    await service.admit({ shopId: "shop-1", recoveryId: "recovery-3" });

    expect(database.messages.size).toBe(2);
    expect(database.messageUpsert).toHaveBeenCalledTimes(3);
    expect([...database.messages.keys()][0]).toContain(
      "capacity-exhausted:free-allowance:subscription-1:5",
    );
    expect([...database.messages.keys()][1]).toContain(
      "capacity-exhausted:free-allowance:subscription-2:4",
    );
  });

  it("records paid recovery usage once with the plan meter and successful initiation time", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => paidPolicy()) };
    const paidReservationService = paidIncludedReservationService();
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      undefined as never,
      undefined as never,
      paidReservationService as never,
      unavailablePromotionalReservationService() as never,
    );
    const admitted = await service.admit({ shopId: "shop-1", recoveryId: "recovery-1" });
    const occurredAt = new Date("2026-09-08T00:45:00.000Z");

    await service.commitSuccessfulInitiation({
      admission: admitted.kind === "admitted" ? admitted.admission : (() => { throw new Error("not admitted"); })(),
      recoveryId: "recovery-1",
      occurredAt,
    });
    await service.commitSuccessfulInitiation({
      admission: admitted.kind === "admitted" ? admitted.admission : (() => { throw new Error("not admitted"); })(),
      recoveryId: "recovery-1",
      occurredAt: new Date("2026-09-08T00:46:00.000Z"),
    });

      expect(paidReservationService.reserve).toHaveBeenCalledTimes(1);
      expect(paidReservationService.commit).toHaveBeenCalledTimes(2);
      expect(paidReservationService.commit).toHaveBeenNthCalledWith(1, {
        shopId: "shop-1",
        sourceKey: "paid-included:period-1:recovery-1",
        occurredAt,
      });
      expect(database.usageEvent.upsert).not.toHaveBeenCalled();
  });

  it("blocks paid recovery when all three current capacity sources are exhausted", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => paidPolicy()) };
    const paidReservationService = paidIncludedReservationService("allowance-exhausted");
    const purchasedReservationService = { reserve: vi.fn(async () => ({ kind: "credits-exhausted" as const, available: 0 })), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const lifetimeReservationService = { reserve: vi.fn(async () => ({ kind: "allowance-exhausted" as const, remaining: 0 })), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      lifetimeReservationService as never,
      purchasedReservationService as never,
      paidReservationService as never,
      unavailablePromotionalReservationService() as never,
    );

    await expect(service.admit({ shopId: "shop-1", recoveryId: "recovery-overage" }))
      .resolves.toEqual({ kind: "blocked", reason: "allowance-exhausted" });
    expect(purchasedReservationService.reserve).toHaveBeenCalledTimes(1);
    expect(lifetimeReservationService.reserve).toHaveBeenCalledTimes(1);
    expect(database.usageEvent.upsert).not.toHaveBeenCalled();
  });

  it("uses purchased capacity after included capacity is exhausted", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => paidPolicy()) };
    const paidReservationService = paidIncludedReservationService("allowance-exhausted");
    const purchasedReservationService = {
      reserve: vi.fn(async () => ({ kind: "reserved" as const, reservation: {} })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const lifetimeReservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      lifetimeReservationService as never,
      purchasedReservationService as never,
      paidReservationService as never,
      unavailablePromotionalReservationService() as never,
    );

    await expect(service.admit({ shopId: "shop-1", recoveryId: "recovery-purchased" }))
      .resolves.toMatchObject({ kind: "admitted", admission: { kind: "purchased" } });
    expect(purchasedReservationService.reserve).toHaveBeenCalledOnce();
    expect(purchasedReservationService.reserve).toHaveBeenCalledWith({
      shopId: "shop-1",
      sourceKey: "recovery:shop-1:recovery-purchased",
    });
    expect(lifetimeReservationService.reserve).not.toHaveBeenCalled();
  });

  it("uses lifetime Free capacity after included and purchased capacity are exhausted", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => paidPolicy()) };
    const paidReservationService = paidIncludedReservationService("allowance-exhausted");
    const purchasedReservationService = {
      reserve: vi.fn(async () => ({ kind: "credits-exhausted" as const, available: 0 })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const lifetimeReservationService = {
      reserve: vi.fn(async () => ({ kind: "reserved" as const, reservation: {} })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      lifetimeReservationService as never,
      purchasedReservationService as never,
      paidReservationService as never,
      unavailablePromotionalReservationService() as never,
    );

    await expect(service.admit({ shopId: "shop-1", recoveryId: "recovery-lifetime" }))
      .resolves.toMatchObject({ kind: "admitted", admission: { kind: "lifetime-free" } });
    expect(purchasedReservationService.reserve).toHaveBeenCalledOnce();
    expect(lifetimeReservationService.reserve).toHaveBeenCalledWith({
      shopId: "shop-1",
      sourceKey: "recovery:shop-1:recovery-lifetime",
    });
  });

  it.each([
    { kind: "already-ambiguous" as const },
    { kind: "already-released" as const },
  ])("does not switch funding buckets for an included $kind replay", async ({ kind }) => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => paidPolicy()) };
    const paidReservationService = {
      ...paidIncludedReservationService(),
      reserve: vi.fn(async () => ({ kind, reservation: {}, counter: "INCLUDED_RECOVERY_CREDITS" as const })),
    };
    const purchasedReservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const lifetimeReservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      lifetimeReservationService as never,
      purchasedReservationService as never,
      paidReservationService as never,
      unavailablePromotionalReservationService() as never,
    );

    await expect(service.admit({ shopId: "shop-1", recoveryId: `recovery-${kind}` }))
      .resolves.toEqual({ kind: "blocked", reason: "reservation-in-flight" });
    expect(purchasedReservationService.reserve).not.toHaveBeenCalled();
    expect(lifetimeReservationService.reserve).not.toHaveBeenCalled();
  });

  it("commits a purchased-funded Paid recovery without the paid meter", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => paidPolicy()) };
    const paidReservationService = paidIncludedReservationService("allowance-exhausted");
    const purchasedReservationService = {
      reserve: vi.fn(async () => ({ kind: "reserved" as const, reservation: {} })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() } as never,
      purchasedReservationService as never,
      paidReservationService as never,
      unavailablePromotionalReservationService() as never,
    );
    const result = await service.admit({ shopId: "shop-1", recoveryId: "recovery-purchased-commit" });
    if (result.kind !== "admitted") throw new Error("expected purchased admission");

    await service.commitSuccessfulInitiation({
      admission: result.admission,
      recoveryId: "recovery-purchased-commit",
      occurredAt: new Date("2026-09-12T00:00:00.000Z"),
    });
    expect(purchasedReservationService.commit).toHaveBeenCalledOnce();
    expect(paidReservationService.commit).not.toHaveBeenCalled();
    expect(database.usageEvent.upsert).not.toHaveBeenCalled();
  });

  it("commits a lifetime-Free-funded Paid recovery without the paid meter", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => paidPolicy()) };
    const paidReservationService = paidIncludedReservationService("allowance-exhausted");
    const purchasedReservationService = {
      reserve: vi.fn(async () => ({ kind: "credits-exhausted" as const, available: 0 })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const lifetimeReservationService = {
      reserve: vi.fn(async () => ({ kind: "reserved" as const, reservation: {} })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      lifetimeReservationService as never,
      purchasedReservationService as never,
      paidReservationService as never,
      unavailablePromotionalReservationService() as never,
    );
    const result = await service.admit({ shopId: "shop-1", recoveryId: "recovery-lifetime-commit" });
    if (result.kind !== "admitted") throw new Error("expected lifetime-Free admission");

    await service.commitSuccessfulInitiation({
      admission: result.admission,
      recoveryId: "recovery-lifetime-commit",
      occurredAt: new Date("2026-09-12T00:00:00.000Z"),
    });
    expect(lifetimeReservationService.commit).toHaveBeenCalledOnce();
    expect(paidReservationService.commit).not.toHaveBeenCalled();
    expect(database.usageEvent.upsert).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "definitive provider rejection",
      error: Object.assign(new Error("rejected"), {
        name: "WhatsAppServiceError",
        code: "provider-rejected",
      }),
      method: "release" as const,
    },
    {
      name: "ambiguous provider response",
      error: Object.assign(new Error("malformed response"), {
        name: "WhatsAppServiceError",
        code: "invalid-provider-response",
      }),
      method: "markAmbiguous" as const,
    },
  ])("$name transitions the Free reservation safely", async ({ error, method }) => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => freePolicy()) };
    const reservationService = {
      reserve: vi.fn(async () => ({ kind: "reserved", reservation: {} })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const purchasedReservationService = {
      reserve: vi.fn(async () => ({ kind: "credits-exhausted", available: 0 })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      reservationService as never,
      purchasedReservationService as never,
    );
    const admitted = await service.admit({ shopId: "shop-1", recoveryId: "recovery-1" });

    await service.handleProviderFailure({
      admission: admitted.kind === "admitted" ? admitted.admission : (() => { throw new Error("not admitted"); })(),
      error,
    });

    expect(reservationService[method]).toHaveBeenCalledWith({
      shopId: "shop-1",
      sourceKey: "recovery:shop-1:recovery-1",
    });
  });

  it("classifies an ambiguous paid provider response without inventing usage", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => paidPolicy()) };
    const paidReservationService = paidIncludedReservationService();
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      undefined as never,
      undefined as never,
      paidReservationService as never,
      unavailablePromotionalReservationService() as never,
    );
    const admitted = await service.admit({ shopId: "shop-1", recoveryId: "paid-ambiguous" });

    const disposition = await service.handleProviderFailure({
      admission: admitted.kind === "admitted" ? admitted.admission : (() => { throw new Error("not admitted"); })(),
      error: Object.assign(new Error("malformed response"), {
        name: "WhatsAppServiceError",
        code: "invalid-provider-response",
      }),
    });

    expect(disposition).toBe("ambiguous");
    expect(paidReservationService.markAmbiguous).toHaveBeenCalledWith({
      shopId: "shop-1",
      sourceKey: "paid-included:period-1:paid-ambiguous",
    });
    expect(paidReservationService.release).not.toHaveBeenCalled();
  });

  it("BACKGROUND-008: classifies timeout-shaped provider failures as ambiguous", async () => {
    const paidReservationService = paidIncludedReservationService();
    const service = new RecoveryBillingService(
      createDatabase() as never,
      { resolve: vi.fn(async () => paidPolicy()) } as never,
      undefined as never,
      undefined as never,
      paidReservationService as never,
      unavailablePromotionalReservationService() as never,
    );
    const admission = {
      kind: "paid" as const,
      sourceKey: "paid-included:period-1:timeout",
      policy: paidPolicy(),
    };
    const error = new Error("timeout");
    error.name = "TimeoutError";

    await expect(service.handleProviderFailure({ admission, error })).resolves.toBe("ambiguous");
    expect(paidReservationService.markAmbiguous).toHaveBeenCalledWith({
      shopId: "shop-1",
      sourceKey: "paid-included:period-1:timeout",
    });
    expect(paidReservationService.release).not.toHaveBeenCalled();
  });

  it("uses purchased credits after Free lifetime capacity is exhausted", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => ({ ...freePolicy(), recoveryCreditPack: purchasedPack() })) };
    const reservationService = {
      reserve: vi.fn(async () => ({ kind: "allowance-exhausted", remaining: 0 })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const purchasedReservationService = {
      reserve: vi.fn(async () => ({ kind: "reserved", reservation: {} })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      reservationService as never,
      purchasedReservationService as never,
    );

    const result = await service.admit({ shopId: "shop-1", recoveryId: "recovery-purchased" });

    expect(result).toMatchObject({ kind: "admitted", admission: { kind: "purchased" } });
    expect(purchasedReservationService.reserve).toHaveBeenCalledWith({
      shopId: "shop-1",
      sourceKey: "recovery:shop-1:recovery-purchased",
    });
  });

  it("falls back from exhausted purchased credits to lifetime Free credits", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => ({ ...freePolicy(), recoveryCreditPack: purchasedPack() })) };
    const reservationService = {
      reserve: vi.fn(async () => ({ kind: "reserved", reservation: {} })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const purchasedReservationService = {
      reserve: vi.fn(async () => ({ kind: "credits-exhausted", available: 0 })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      reservationService as never,
      purchasedReservationService as never,
    );

    const result = await service.admit({ shopId: "shop-1", recoveryId: "recovery-lifetime" });

    expect(result).toMatchObject({ kind: "admitted", admission: { kind: "lifetime-free" } });
    expect(reservationService.reserve).toHaveBeenCalledWith({
      shopId: "shop-1",
      sourceKey: "recovery:shop-1:recovery-lifetime",
    });
    if (result.kind === "admitted") {
      await service.commitSuccessfulInitiation({
        admission: result.admission,
        recoveryId: "recovery-lifetime",
        occurredAt: new Date("2026-09-08T00:45:00.000Z"),
      });
    }
    expect(reservationService.commit).toHaveBeenCalledWith({
      shopId: "shop-1",
      sourceKey: "recovery:shop-1:recovery-lifetime",
    });
    expect(database.usageEvent.upsert).not.toHaveBeenCalled();
  });

  it("keeps Paid included-credit composition for BACKGROUND-002", async () => {
    const database = createDatabase();
    const policyResolver = {
      resolve: vi.fn(async () => ({
        ...paidPolicy(),
        recoveryCreditPack: purchasedPack({
          includedRecoveryConversationAllowance: 1,
          normalRecoveryUsageQuantity: 1,
        }),
      })),
    };
    const reservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
      const paidReservationService = paidIncludedReservationService();
    const purchasedReservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      reservationService as never,
      purchasedReservationService as never,
      paidReservationService as never,
      unavailablePromotionalReservationService() as never,
    );

    const result = await service.admit({ shopId: "shop-1", recoveryId: "paid-lifetime" });

    expect(result).toMatchObject({ kind: "admitted", admission: { kind: "paid" } });
    expect(purchasedReservationService.reserve).not.toHaveBeenCalled();
    expect(reservationService.reserve).not.toHaveBeenCalled();
  });

  it("admits Free recovery after a newly activated pack restores purchased capacity", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => ({ ...freePolicy(), recoveryCreditPack: purchasedPack() })) };
    const reservationService = {
      reserve: vi.fn(async () => ({ kind: "allowance-exhausted", remaining: 0 })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const purchasedReservationService = {
      reserve: vi.fn()
        .mockResolvedValueOnce({ kind: "credits-exhausted", available: 0 })
        .mockResolvedValueOnce({ kind: "reserved", reservation: {} }),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      reservationService as never,
      purchasedReservationService as never,
    );

    await expect(service.admit({ shopId: "shop-1", recoveryId: "before-pack" }))
      .resolves.toMatchObject({ kind: "blocked", reason: "allowance-exhausted" });
    await expect(service.admit({ shopId: "shop-1", recoveryId: "after-pack" }))
      .resolves.toMatchObject({ kind: "admitted", admission: { kind: "purchased" } });
  });

  it("prefers purchased credits before remaining lifetime Free capacity", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => ({ ...freePolicy(), recoveryCreditPack: purchasedPack() })) };
    const reservationService = {
      reserve: vi.fn(),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const purchasedReservationService = {
      reserve: vi.fn(async () => ({ kind: "reserved", reservation: {} })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      reservationService as never,
      purchasedReservationService as never,
    );

    const result = await service.admit({ shopId: "shop-1", recoveryId: "recovery-free" });

    expect(result).toMatchObject({ kind: "admitted", admission: { kind: "purchased" } });
    expect(purchasedReservationService.reserve).toHaveBeenCalledTimes(1);
    expect(reservationService.reserve).not.toHaveBeenCalled();
  });

  it("spends purchased credits when pack purchasing is disabled", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => ({ ...freePolicy(), recoveryCreditPack: null })) };
    const reservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const purchasedReservationService = {
      reserve: vi.fn(async () => ({ kind: "reserved", reservation: {} })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      reservationService as never,
      purchasedReservationService as never,
    );

    await expect(service.admit({ shopId: "shop-1", recoveryId: "pack-disabled" }))
      .resolves.toMatchObject({ kind: "admitted", admission: { kind: "purchased" } });
    expect(purchasedReservationService.reserve).toHaveBeenCalledWith({
      shopId: "shop-1",
      sourceKey: "recovery:shop-1:pack-disabled",
    });
    expect(reservationService.reserve).not.toHaveBeenCalled();
  });

  it("keeps a lifetime-funded replay from switching to purchased capacity", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => ({ ...freePolicy(), recoveryCreditPack: purchasedPack() })) };
    const reservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const purchasedReservationService = {
      reserve: vi.fn(async () => ({
        kind: "already-reserved",
        counter: "LIFETIME_FREE_RECOVERY_CREDITS",
        reservation: {},
      })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      reservationService as never,
      purchasedReservationService as never,
    );

    await expect(service.admit({ shopId: "shop-1", recoveryId: "lifetime-replay" }))
      .resolves.toMatchObject({ kind: "admitted", admission: { kind: "lifetime-free" } });
    expect(reservationService.reserve).not.toHaveBeenCalled();
  });

  it("keeps a purchased-funded replay from switching to lifetime Free", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => ({ ...freePolicy(), recoveryCreditPack: purchasedPack() })) };
    const reservationService = {
      reserve: vi.fn(async () => ({
        kind: "already-committed",
        counter: "PURCHASED_RECOVERY_CREDITS",
        reservation: {},
      })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const purchasedReservationService = {
      reserve: vi.fn(async () => ({ kind: "credits-exhausted", available: 0 })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      reservationService as never,
      purchasedReservationService as never,
    );

    await expect(service.admit({ shopId: "shop-1", recoveryId: "purchased-replay" }))
      .resolves.toMatchObject({ kind: "admitted", admission: { kind: "purchased" } });
    expect(purchasedReservationService.reserve).toHaveBeenCalledTimes(1);
  });

  it("uses the normal paid path until included usage is exhausted", async () => {
    const database = createDatabase();
    const policyResolver = {
      resolve: vi.fn(async () => ({
        ...paidPolicy(),
        recoveryCreditPack: purchasedPack({
          includedRecoveryConversationAllowance: 200,
          normalRecoveryUsageQuantity: 199,
        }),
      })),
    };
      const paidReservationService = paidIncludedReservationService();
    const purchasedReservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      undefined as never,
      purchasedReservationService as never,
      paidReservationService as never,
      unavailablePromotionalReservationService() as never,
    );

    const result = await service.admit({ shopId: "shop-1", recoveryId: "recovery-included" });

    expect(result).toMatchObject({ kind: "admitted", admission: { kind: "paid" } });
    expect(purchasedReservationService.reserve).not.toHaveBeenCalled();
  });

  it("does not decide Paid included exhaustion from recovery-pack policy", async () => {
    const database = createDatabase();
    const policyResolver = {
      resolve: vi.fn(async () => ({
        ...paidPolicy(),
        recoveryCreditPack: purchasedPack({
          includedRecoveryConversationAllowance: 200,
          normalRecoveryUsageQuantity: 200,
        }),
      })),
    };
    const purchasedReservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
      const paidReservationService = paidIncludedReservationService();
    const lifetimeReservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      lifetimeReservationService as never,
      purchasedReservationService as never,
      paidReservationService as never,
      unavailablePromotionalReservationService() as never,
    );

    const result = await service.admit({ shopId: "shop-1", recoveryId: "recovery-overage" });

    expect(result).toMatchObject({ kind: "admitted", admission: { kind: "paid" } });
    expect(purchasedReservationService.reserve).not.toHaveBeenCalled();
  });

  it("does not reserve purchased credits on the Paid path", async () => {
    const database = createDatabase();
    const policyResolver = {
      resolve: vi.fn(async () => ({
        ...paidPolicy(),
        recoveryCreditPack: purchasedPack({
          includedRecoveryConversationAllowance: 200,
          normalRecoveryUsageQuantity: 200,
        }),
      })),
    };
    const purchasedReservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
      const paidReservationService = paidIncludedReservationService();
    const lifetimeReservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      lifetimeReservationService as never,
      purchasedReservationService as never,
      paidReservationService as never,
      unavailablePromotionalReservationService() as never,
    );

    await expect(service.admit({ shopId: "shop-1", recoveryId: "overage-before-pack" }))
      .resolves.toMatchObject({ kind: "admitted", admission: { kind: "paid" } });
    await expect(service.admit({ shopId: "shop-1", recoveryId: "purchased-after-pack" }))
      .resolves.toMatchObject({ kind: "admitted", admission: { kind: "paid" } });
    expect(purchasedReservationService.reserve).not.toHaveBeenCalled();
  });

  it("commits purchased recovery usage locally without creating a normal paid meter event", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => ({ ...freePolicy(), recoveryCreditPack: purchasedPack({ enabled: false }) })) };
    const purchasedReservationService = {
      reserve: vi.fn(async () => ({ kind: "reserved", reservation: {} })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const lifetimeReservationService = {
      reserve: vi.fn(async () => ({ kind: "credits-exhausted", available: 0 })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      lifetimeReservationService as never,
      purchasedReservationService as never,
    );
    const admitted = await service.admit({ shopId: "shop-1", recoveryId: "recovery-topup" });

    await service.commitSuccessfulInitiation({
      admission: admitted.kind === "admitted" ? admitted.admission : (() => { throw new Error("not admitted"); })(),
      recoveryId: "recovery-topup",
      occurredAt: new Date("2026-09-08T00:45:00.000Z"),
    });

    expect(purchasedReservationService.commit).toHaveBeenCalledWith({
      shopId: "shop-1",
      sourceKey: "recovery:shop-1:recovery-topup",
    });
    expect(database.usageEvent.upsert).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "releases purchased capacity after a definitive provider failure",
      error: Object.assign(new Error("rejected"), { name: "WhatsAppServiceError", code: "provider-rejected" }),
      method: "release" as const,
    },
    {
      name: "keeps purchased capacity attached after an ambiguous provider failure",
      error: Object.assign(new Error("malformed response"), { name: "WhatsAppServiceError", code: "invalid-provider-response" }),
      method: "markAmbiguous" as const,
    },
  ])("$name", async ({ error, method }) => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => ({ ...freePolicy(), recoveryCreditPack: null })) };
    const lifetimeReservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const purchasedReservationService = {
      reserve: vi.fn(async () => ({ kind: "reserved", reservation: {} })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      lifetimeReservationService as never,
      purchasedReservationService as never,
    );
    const admitted = await service.admit({ shopId: "shop-1", recoveryId: "purchased-failure" });
    expect(admitted.kind).toBe("admitted");

    await service.handleProviderFailure({
      admission: admitted.kind === "admitted" ? admitted.admission : (() => { throw new Error("not admitted"); })(),
      error,
    });

    expect(purchasedReservationService[method]).toHaveBeenCalledWith({
      shopId: "shop-1",
      sourceKey: "recovery:shop-1:purchased-failure",
    });
    expect(lifetimeReservationService[method]).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "purchased ambiguous replay",
      purchasedOutcome: { kind: "already-ambiguous", counter: "PURCHASED_RECOVERY_CREDITS" },
      lifetimeOutcome: { kind: "reserved", counter: "LIFETIME_FREE_RECOVERY_CREDITS" },
      expected: { kind: "blocked", reason: "reservation-in-flight" },
    },
    {
      name: "lifetime ambiguous replay",
      purchasedOutcome: { kind: "credits-exhausted", available: 0 },
      lifetimeOutcome: { kind: "already-ambiguous", counter: "LIFETIME_FREE_RECOVERY_CREDITS" },
      expected: { kind: "blocked", reason: "reservation-in-flight" },
    },
    {
      name: "released purchased replay does not switch to lifetime",
      purchasedOutcome: { kind: "already-released", counter: "PURCHASED_RECOVERY_CREDITS" },
      lifetimeOutcome: { kind: "reserved", counter: "LIFETIME_FREE_RECOVERY_CREDITS" },
      expected: { kind: "blocked", reason: "reservation-in-flight" },
    },
    {
      name: "released lifetime replay does not switch to purchased",
      purchasedOutcome: { kind: "credits-exhausted", available: 0 },
      lifetimeOutcome: { kind: "already-released", counter: "LIFETIME_FREE_RECOVERY_CREDITS" },
      expected: { kind: "blocked", reason: "reservation-in-flight" },
    },
  ])("$name", async ({ purchasedOutcome, lifetimeOutcome, expected }) => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => ({ ...freePolicy(), recoveryCreditPack: null })) };
    const lifetimeReservationService = {
      reserve: vi.fn(async () => lifetimeOutcome),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const purchasedReservationService = {
      reserve: vi.fn(async () => purchasedOutcome),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      lifetimeReservationService as never,
      purchasedReservationService as never,
    );

    await expect(service.admit({ shopId: "shop-1", recoveryId: "replay-state" })).resolves.toEqual(expected);
    expect(purchasedReservationService.reserve).toHaveBeenCalledTimes(1);
    expect(lifetimeReservationService.reserve).toHaveBeenCalledTimes(
      purchasedOutcome.kind === "credits-exhausted" ? 1 : 0,
    );
  });

  it("reactivates a released lifetime reservation through the same owner", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => ({ ...freePolicy(), recoveryCreditPack: null })) };
    const lifetimeReservationService = {
      reserve: vi.fn(async () => ({ kind: "reserved", counter: "LIFETIME_FREE_RECOVERY_CREDITS" })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const purchasedReservationService = {
      reserve: vi.fn(async () => ({ kind: "credits-exhausted", available: 0 })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      lifetimeReservationService as never,
      purchasedReservationService as never,
    );

    await expect(service.admit({ shopId: "shop-1", recoveryId: "reactivate-lifetime" }))
      .resolves.toMatchObject({ kind: "admitted", admission: { kind: "lifetime-free" } });
    expect(lifetimeReservationService.reserve).toHaveBeenCalledTimes(1);
    expect(purchasedReservationService.reserve).toHaveBeenCalledTimes(1);
  });

  it("reactivates a released purchased reservation through the same owner", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => ({ ...freePolicy(), recoveryCreditPack: null })) };
    const lifetimeReservationService = {
      reserve: vi.fn(async () => ({ kind: "allowance-exhausted", remaining: 0 })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const purchasedReservationService = {
      reserve: vi.fn(async () => ({ kind: "reserved", counter: "PURCHASED_RECOVERY_CREDITS" })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      lifetimeReservationService as never,
      purchasedReservationService as never,
    );

    await expect(service.admit({ shopId: "shop-1", recoveryId: "reactivate-purchased" }))
      .resolves.toMatchObject({ kind: "admitted", admission: { kind: "purchased" } });
    expect(purchasedReservationService.reserve).toHaveBeenCalledTimes(1);
    expect(lifetimeReservationService.reserve).not.toHaveBeenCalled();
  });

  it("reserves selected promotion before paid included capacity", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => ({ ...paidPolicy(), planId: "plan-1" })) };
    const promotionalReservationService = {
      reserve: vi.fn(async ({ sourceKey }: { sourceKey: string }) => ({
        kind: "reserved" as const,
        reservation: {},
        sourceKey,
      })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const paidReservationService = paidIncludedReservationService();
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      undefined as never,
      undefined as never,
      paidReservationService as never,
      promotionalReservationService as never,
    );

    const result = await service.admit({ shopId: "shop-1", recoveryId: "promo-first" });

    expect(result).toMatchObject({ kind: "admitted", admission: { kind: "promotional" } });
    expect(promotionalReservationService.reserve).toHaveBeenCalledWith({
      shopId: "shop-1",
      sourceKey: "recovery:shop-1:promo-first",
      planId: "plan-1",
    });
    expect(paidReservationService.reserve).not.toHaveBeenCalled();
  });

  it("falls back to purchased capacity when the selected promotion is unavailable", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => ({ ...freePolicy(), planId: "plan-1" })) };
    const promotionalReservationService = {
      reserve: vi.fn(async () => ({ kind: "unavailable" as const })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const purchasedReservationService = {
      reserve: vi.fn(async () => ({ kind: "reserved" as const, reservation: {} })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      undefined as never,
      purchasedReservationService as never,
      undefined as never,
      promotionalReservationService as never,
    );

    const result = await service.admit({ shopId: "shop-1", recoveryId: "promo-fallback" });

    expect(result).toMatchObject({ kind: "admitted", admission: { kind: "purchased" } });
    expect(purchasedReservationService.reserve).toHaveBeenCalledWith({
      shopId: "shop-1",
      sourceKey: "recovery:shop-1:promo-fallback",
    });
  });

  it("uses free-plan promotional capacity before purchased or lifetime capacity", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => ({ ...freePolicy(), planId: "plan-1" })) };
    const promotionalReservationService = {
      reserve: vi.fn(async () => ({ kind: "reserved" as const, reservation: {}, sourceKey: "recovery:shop-1:free-promo" })),
      commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn(),
    };
    const purchasedReservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const lifetimeReservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      lifetimeReservationService as never,
      purchasedReservationService as never,
      undefined as never,
      promotionalReservationService as never,
    );

    await expect(service.admit({ shopId: "shop-1", recoveryId: "free-promo" }))
      .resolves.toMatchObject({ kind: "admitted", admission: { kind: "promotional" } });
    expect(purchasedReservationService.reserve).not.toHaveBeenCalled();
    expect(lifetimeReservationService.reserve).not.toHaveBeenCalled();
  });

  it("falls from unavailable promotional capacity to paid included capacity", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => ({ ...paidPolicy(), planId: "plan-1" })) };
    const promotionalReservationService = {
      reserve: vi.fn(async () => ({ kind: "unavailable" as const })),
      commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn(),
    };
    const paidReservationService = paidIncludedReservationService();
    const purchasedReservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      undefined as never,
      purchasedReservationService as never,
      paidReservationService as never,
      promotionalReservationService as never,
    );

    await expect(service.admit({ shopId: "shop-1", recoveryId: "paid-promo-fallback" }))
      .resolves.toMatchObject({ kind: "admitted", admission: { kind: "paid" } });
    expect(paidReservationService.reserve).toHaveBeenCalledOnce();
    expect(purchasedReservationService.reserve).not.toHaveBeenCalled();
  });

  it("routes promotional lifecycle transitions to the exact-grant service", async () => {
    const database = createDatabase();
    const policy = { ...freePolicy(), planId: "plan-1" };
    const policyResolver = { resolve: vi.fn(async () => policy) };
    const promotionalReservationService = {
      reserve: vi.fn(async ({ sourceKey }: { sourceKey: string }) => ({
        kind: "reserved" as const,
        reservation: {},
        sourceKey,
      })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      undefined as never,
      undefined as never,
      undefined as never,
      promotionalReservationService as never,
    );
    const admitted = await service.admit({ shopId: "shop-1", recoveryId: "promo-lifecycle" });

    if (admitted.kind !== "admitted") throw new Error("expected promotional admission");
    await service.commitSuccessfulInitiation({ admission: admitted.admission, recoveryId: "promo-lifecycle", occurredAt: new Date() });

    expect(promotionalReservationService.commit).toHaveBeenCalledWith({
      shopId: policy.shopId,
      sourceKey: "recovery:shop-1:promo-lifecycle",
      planId: "plan-1",
    });
  });

  it("falls through paid included, purchased, and lifetime Free capacity in order", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => ({ ...paidPolicy(), planId: "plan-1" })) };
    const promotionalReservationService = {
      reserve: vi.fn(async () => ({ kind: "unavailable" as const })),
      commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn(),
    };
    const paidReservationService = paidIncludedReservationService("allowance-exhausted");
    const purchasedReservationService = {
      reserve: vi.fn(async () => ({ kind: "credits-exhausted" as const, available: 0 })),
      commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn(),
    };
    const lifetimeReservationService = {
      reserve: vi.fn(async () => ({ kind: "reserved" as const, reservation: {} })),
      commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn(),
    };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      lifetimeReservationService as never,
      purchasedReservationService as never,
      paidReservationService as never,
      promotionalReservationService as never,
    );

    await expect(service.admit({ shopId: "shop-1", recoveryId: "ordered-fallback" }))
      .resolves.toMatchObject({ kind: "admitted", admission: { kind: "lifetime-free" } });
    expect(promotionalReservationService.reserve).toHaveBeenCalledOnce();
    expect(paidReservationService.reserve).toHaveBeenCalledOnce();
    expect(purchasedReservationService.reserve).toHaveBeenCalledOnce();
    expect(lifetimeReservationService.reserve).toHaveBeenCalledOnce();
  });

  it("falls back from promotional capacity to paid included capacity", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => ({ ...paidPolicy(), planId: "plan-1" })) };
    const promotionalReservationService = {
      reserve: vi.fn(async () => ({ kind: "unavailable" as const })),
      commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn(),
    };
    const paidReservationService = paidIncludedReservationService();
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      undefined as never,
      undefined as never,
      paidReservationService as never,
      promotionalReservationService as never,
    );

    await expect(service.admit({ shopId: "shop-1", recoveryId: "promo-to-paid" }))
      .resolves.toMatchObject({ kind: "admitted", admission: { kind: "paid" } });
    expect(promotionalReservationService.reserve).toHaveBeenCalledOnce();
    expect(paidReservationService.reserve).toHaveBeenCalledOnce();
  });

  it("keeps a promotional replay from switching to another capacity source", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => ({ ...paidPolicy(), planId: "plan-1" })) };
    const promotionalReservationService = {
      reserve: vi.fn(async () => ({ kind: "already-ambiguous" as const, reservation: {}, sourceKey: "recovery:shop-1:promo-replay" })),
      commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn(),
    };
    const paidReservationService = paidIncludedReservationService();
    const purchasedReservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      undefined as never,
      purchasedReservationService as never,
      paidReservationService as never,
      promotionalReservationService as never,
    );

    await expect(service.admit({ shopId: "shop-1", recoveryId: "promo-replay" }))
      .resolves.toEqual({ kind: "blocked", reason: "reservation-in-flight" });
    expect(paidReservationService.reserve).not.toHaveBeenCalled();
    expect(purchasedReservationService.reserve).not.toHaveBeenCalled();
  });

  it("blocks a released promotional replay without falling back", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => ({ ...paidPolicy(), planId: "plan-1" })) };
    const promotionalReservationService = {
      reserve: vi.fn(async () => ({ kind: "already-released" as const, reservation: {}, sourceKey: "recovery:shop-1:released-promo" })),
      commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn(),
    };
    const paidReservationService = paidIncludedReservationService();
    const purchasedReservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      undefined as never,
      purchasedReservationService as never,
      paidReservationService as never,
      promotionalReservationService as never,
    );

    await expect(service.admit({ shopId: "shop-1", recoveryId: "released-promo" }))
      .resolves.toEqual({ kind: "blocked", reason: "reservation-in-flight" });
    expect(paidReservationService.reserve).not.toHaveBeenCalled();
    expect(purchasedReservationService.reserve).not.toHaveBeenCalled();
  });

  it("commits promotional capacity without invoking paid meter accounting", async () => {
    const database = createDatabase();
    const policy = { ...paidPolicy(), planId: "plan-1" };
    const policyResolver = { resolve: vi.fn(async () => policy) };
    const promotionalReservationService = {
      reserve: vi.fn(async ({ sourceKey }: { sourceKey: string }) => ({ kind: "reserved" as const, reservation: {}, sourceKey })),
      commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn(),
    };
    const paidReservationService = paidIncludedReservationService();
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      undefined as never,
      undefined as never,
      paidReservationService as never,
      promotionalReservationService as never,
    );
    const admitted = await service.admit({ shopId: "shop-1", recoveryId: "promo-commit" });
    if (admitted.kind !== "admitted") throw new Error("expected promotional admission");

    await service.commitSuccessfulInitiation({ admission: admitted.admission, recoveryId: "promo-commit", occurredAt: new Date() });

    expect(promotionalReservationService.commit).toHaveBeenCalledOnce();
    expect(paidReservationService.commit).not.toHaveBeenCalled();
    expect(database.usageEvent.upsert).not.toHaveBeenCalled();
  });

  it("keeps promotional capacity owned through release, definitive failure, and ambiguity", async () => {
    const database = createDatabase();
    const policy = { ...freePolicy(), planId: "plan-1" };
    const policyResolver = { resolve: vi.fn(async () => policy) };
    const promotionalReservationService = {
      reserve: vi.fn(async ({ sourceKey }: { sourceKey: string }) => ({ kind: "reserved" as const, reservation: {}, sourceKey })),
      commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn(),
    };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      undefined as never,
      undefined as never,
      undefined as never,
      promotionalReservationService as never,
    );
    const admitted = await service.admit({ shopId: "shop-1", recoveryId: "promo-failure" });
    if (admitted.kind !== "admitted") throw new Error("expected promotional admission");

    await service.releaseBeforeProvider(admitted.admission);
    await service.handleProviderFailure({
      admission: admitted.admission,
      error: Object.assign(new Error("rejected"), { name: "WhatsAppServiceError", code: "provider-rejected" }),
    });
    await service.handleProviderFailure({
      admission: admitted.admission,
      error: Object.assign(new Error("unknown response"), { name: "WhatsAppServiceError", code: "invalid-provider-response" }),
    });
    expect(promotionalReservationService.release).toHaveBeenCalledTimes(2);
    expect(promotionalReservationService.markAmbiguous).toHaveBeenCalledOnce();
  });

  it("transitions only promotional capacity on provider outcomes", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => ({ ...freePolicy(), planId: "plan-1" })) };
    const promotionalReservationService = {
      reserve: vi.fn(async () => ({ kind: "reserved" as const, reservation: {}, sourceKey: "recovery:shop-1:promo-only" })),
      commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn(),
    };
    const purchasedReservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const lifetimeReservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      lifetimeReservationService as never,
      purchasedReservationService as never,
      undefined as never,
      promotionalReservationService as never,
    );
    const admitted = await service.admit({ shopId: "shop-1", recoveryId: "promo-only" });
    if (admitted.kind !== "admitted") throw new Error("expected promotional admission");

    await service.handleProviderFailure({
      admission: admitted.admission,
      error: Object.assign(new Error("rejected"), { name: "WhatsAppServiceError", code: "provider-rejected" }),
    });
    await service.releaseBeforeProvider(admitted.admission);
    await service.handleProviderFailure({
      admission: admitted.admission,
      error: Object.assign(new Error("unknown"), { name: "WhatsAppServiceError", code: "invalid-provider-response" }),
    });

    expect(promotionalReservationService.release).toHaveBeenCalledTimes(2);
    expect(promotionalReservationService.markAmbiguous).toHaveBeenCalledOnce();
    expect(purchasedReservationService.release).not.toHaveBeenCalled();
    expect(lifetimeReservationService.release).not.toHaveBeenCalled();
  });
});