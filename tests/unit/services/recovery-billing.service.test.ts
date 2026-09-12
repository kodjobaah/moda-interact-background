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

function paidPolicy() {
  return {
    shopId: "shop-1",
    planKind: "PAID_METERED" as const,
    newRecoveriesPaused: false,
    shopifyUsageEventHandle: "basic-recovery-conversation",
    billingPeriod: { id: "period-1" },
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
    const reservationService = {
      reserve: vi.fn(),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      reservationService as never,
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

    expect(database.usageEvent.upsert).toHaveBeenCalledTimes(2);
    expect(database.usageEvent.upsert).toHaveBeenNthCalledWith(1,
      expect.objectContaining({
        where: { idempotencyKey: "recovery:shop-1:recovery-1" },
        create: expect.objectContaining({
          billingPeriodId: "period-1",
          quantity: 1,
          occurredAt,
          shopifyReportState: "PENDING",
          shopifyEventHandle: "basic-recovery-conversation",
          sourceId: "recovery-1",
        }),
        update: {},
      }),
    );
    expect(reservationService.reserve).not.toHaveBeenCalled();
  });

  it("allows paid recovery beyond included units and keeps replay identity stable", async () => {
    const database = createDatabase();
    const policyResolver = { resolve: vi.fn(async () => paidPolicy()) };
    const reservationService = {
      reserve: vi.fn(),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      reservationService as never,
    );

    const admitted = await service.admit({ shopId: "shop-1", recoveryId: "recovery-overage" });
    expect(admitted.kind).toBe("admitted");
    expect(reservationService.reserve).not.toHaveBeenCalled();

    if (admitted.kind === "admitted") {
      await service.commitSuccessfulInitiation({
        admission: admitted.admission,
        recoveryId: "recovery-overage",
        occurredAt: new Date("2026-09-08T00:45:00.000Z"),
      });
      await service.commitSuccessfulInitiation({
        admission: admitted.admission,
        recoveryId: "recovery-overage",
        occurredAt: new Date("2026-09-08T00:46:00.000Z"),
      });
    }

    expect(database.usageEvent.upsert).toHaveBeenCalledTimes(2);
    expect(database.usageEvent.upsert.mock.calls[0]?.[0].where).toEqual(
      database.usageEvent.upsert.mock.calls[1]?.[0].where,
    );
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
    const reservationService = {
      reserve: vi.fn(),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      reservationService as never,
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
    expect(reservationService.markAmbiguous).not.toHaveBeenCalled();
    expect(reservationService.release).not.toHaveBeenCalled();
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
    const purchasedReservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      reservationService as never,
      purchasedReservationService as never,
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
    const purchasedReservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      undefined as never,
      purchasedReservationService as never,
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
    const lifetimeReservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      lifetimeReservationService as never,
      purchasedReservationService as never,
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
    const lifetimeReservationService = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const service = new RecoveryBillingService(
      database as never,
      policyResolver as never,
      lifetimeReservationService as never,
      purchasedReservationService as never,
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
});