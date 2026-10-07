import { describe, expect, it, vi } from "vitest";

import { RecoveryBillingService } from "../../../src/services/recovery-billing.service.js";
import { EffectiveBillingPolicyError } from "../../../src/services/effective-billing-policy.service.js";
import { PostContractRecoveryPolicyError } from "../../../src/services/post-contract-recovery-policy.service.js";

function createDatabase(selectedGrant?: Record<string, unknown> | null) {
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
    merchantPromotionSelection: selectedGrant === undefined
      ? undefined
      : {
          findUnique: vi.fn(async () => selectedGrant ? { promotionalCreditGrant: selectedGrant } : null),
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

function freePolicy() {
  return {
    shopId: "shop-1",
    subscriptionId: "subscription-1",
    planKind: "FREE" as const,
    features: new Set(["checkout_recovery"]),
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
    features: new Set(["checkout_recovery"]),
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

  it("uses purchased credits after an onboarded Shopify subscription has ended", async () => {
    const freeReservationService = {
      reserve: vi.fn(),
      reservePostContract: vi.fn(),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const purchasedReservationService = {
      reserve: vi.fn(async () => ({
        kind: "reserved" as const,
        reservation: {},
        counter: "PURCHASED_RECOVERY_CREDITS" as const,
      })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const postContractPolicy = {
      mode: "POST_CONTRACT_DURABLE_CREDITS" as const,
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      subscriptionStatus: "NO_CONTRACT" as const,
      newRecoveriesPaused: false,
      automatedWhatsappPaused: false,
      outboundSoftLimit: 1000,
      outboundHardLimit: 2000,
      terminalMessageReservedSlots: 1,
      billingPeriod: null,
    };
    const service = new RecoveryBillingService(
      createDatabase() as never,
      {
        resolve: vi.fn(async () => {
          throw new EffectiveBillingPolicyError(
            "NO_CONTRACT",
            "contract ended",
          );
        }),
      } as never,
      freeReservationService as never,
      purchasedReservationService as never,
      paidIncludedReservationService() as never,
      unavailablePromotionalReservationService() as never,
      { resolve: vi.fn(async () => postContractPolicy) } as never,
    );

    await expect(
      service.admit({ shopId: "shop-1", recoveryId: "post-contract" }),
    ).resolves.toMatchObject({
      kind: "admitted",
      admission: {
        kind: "purchased",
        policy: { mode: "POST_CONTRACT_DURABLE_CREDITS" },
      },
    });
    expect(purchasedReservationService.reserve).toHaveBeenCalledTimes(1);
    expect(freeReservationService.reservePostContract).not.toHaveBeenCalled();
  });

  it("falls back to lifetime credits after contract end without using paid or promotional allowance", async () => {
    const freeReservationService = {
      reserve: vi.fn(),
      reservePostContract: vi.fn(async () => ({
        kind: "reserved" as const,
        reservation: {},
        counter: "LIFETIME_FREE_RECOVERY_CREDITS" as const,
      })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const purchasedReservationService = {
      reserve: vi.fn(async () => ({
        kind: "credits-exhausted" as const,
        available: 0,
      })),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const paid = paidIncludedReservationService();
    const promotional = unavailablePromotionalReservationService();
    const service = new RecoveryBillingService(
      createDatabase() as never,
      {
        resolve: vi.fn(async () => {
          throw new EffectiveBillingPolicyError(
            "NO_CONTRACT",
            "contract ended",
          );
        }),
      } as never,
      freeReservationService as never,
      purchasedReservationService as never,
      paid as never,
      promotional as never,
      {
        resolve: vi.fn(async () => ({
          mode: "POST_CONTRACT_DURABLE_CREDITS",
          shopId: "shop-1",
          subscriptionId: "subscription-1",
          subscriptionStatus: "NO_CONTRACT",
          newRecoveriesPaused: false,
          automatedWhatsappPaused: false,
          outboundSoftLimit: 1000,
          outboundHardLimit: 2000,
          terminalMessageReservedSlots: 1,
          billingPeriod: null,
        })),
      } as never,
    );

    await expect(
      service.admit({ shopId: "shop-1", recoveryId: "lifetime-after-end" }),
    ).resolves.toMatchObject({
      kind: "admitted",
      admission: { kind: "lifetime-free" },
    });
    expect(freeReservationService.reservePostContract).toHaveBeenCalledTimes(1);
    expect(paid.reserve).not.toHaveBeenCalled();
    expect(promotional.reserve).not.toHaveBeenCalled();
  });

  it("keeps an onboarded merchant that never subscribed contract-required", async () => {
    const service = new RecoveryBillingService(
      createDatabase() as never,
      {
        resolve: vi.fn(async () => {
          throw new EffectiveBillingPolicyError(
            "NO_CONTRACT",
            "no contract",
          );
        }),
      } as never,
      {
        reserve: vi.fn(),
        reservePostContract: vi.fn(),
        commit: vi.fn(),
        release: vi.fn(),
        markAmbiguous: vi.fn(),
      } as never,
      { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() } as never,
      paidIncludedReservationService() as never,
      unavailablePromotionalReservationService() as never,
      {
        resolve: vi.fn(async () => {
          throw new PostContractRecoveryPolicyError(
            "CONTRACT_REQUIRED",
            "never subscribed",
          );
        }),
      } as never,
    );

    await expect(
      service.admit({ shopId: "shop-1", recoveryId: "never-subscribed" }),
    ).resolves.toEqual({ kind: "blocked", reason: "contract-required" });
  });
  it("denies checkout recovery before any reservation when the feature is absent", async () => {
    const database = createDatabase();
    const reservation = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
    const service = new RecoveryBillingService(
      database as never,
      { resolve: vi.fn(async () => ({ ...freePolicy(), features: new Set<string>() })) } as never,
      reservation as never,
      reservation as never,
      reservation as never,
      reservation as never,
    );

    await expect(service.admit({ shopId: "shop-1", recoveryId: "feature-disabled" }))
      .resolves.toEqual({ kind: "blocked", reason: "feature-unavailable" });
    expect(reservation.reserve).not.toHaveBeenCalled();
    expect(database.usageEvent.upsert).not.toHaveBeenCalled();
  });

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

  it("keeps a purchased reservation admitted when the contract ends before provider send", async () => {
    const purchasedReservationService = {
      reserve: vi.fn(),
      commit: vi.fn(),
      release: vi.fn(),
      markAmbiguous: vi.fn(),
    };
    const service = new RecoveryBillingService(
      createDatabase() as never,
      {
        resolve: vi.fn(async () => {
          throw new EffectiveBillingPolicyError(
            "NO_CONTRACT",
            "contract ended",
          );
        }),
      } as never,
      {
        reserve: vi.fn(),
        reservePostContract: vi.fn(),
        commit: vi.fn(),
        release: vi.fn(),
        markAmbiguous: vi.fn(),
      } as never,
      purchasedReservationService as never,
      paidIncludedReservationService() as never,
      unavailablePromotionalReservationService() as never,
      {
        resolve: vi.fn(async () => ({
          mode: "POST_CONTRACT_DURABLE_CREDITS",
          shopId: "shop-1",
          subscriptionId: "subscription-1",
          subscriptionStatus: "NO_CONTRACT",
          newRecoveriesPaused: false,
          automatedWhatsappPaused: false,
          outboundSoftLimit: 1000,
          outboundHardLimit: 2000,
          terminalMessageReservedSlots: 1,
          billingPeriod: null,
        })),
      } as never,
    );
    const admission = {
      kind: "purchased",
      sourceKey: "purchased:before-contract-end",
      policy: paidPolicy("ACTIVE"),
    } as never;

    await expect(
      service.revalidateBeforeProvider({
        admission,
        recoveryId: "before-contract-end",
      }),
    ).resolves.toEqual({ kind: "admitted", admission });
    expect(purchasedReservationService.release).not.toHaveBeenCalled();
  });

  it("releases non-durable plan capacity when the contract ends before provider send", async () => {
    const paidReservationService = paidIncludedReservationService();
    const postContractResolver = { resolve: vi.fn() };
    const service = new RecoveryBillingService(
      createDatabase() as never,
      {
        resolve: vi.fn(async () => {
          throw new EffectiveBillingPolicyError(
            "NO_CONTRACT",
            "contract ended",
          );
        }),
      } as never,
      {
        reserve: vi.fn(),
        reservePostContract: vi.fn(),
        commit: vi.fn(),
        release: vi.fn(),
        markAmbiguous: vi.fn(),
      } as never,
      { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() } as never,
      paidReservationService as never,
      unavailablePromotionalReservationService() as never,
      postContractResolver as never,
    );
    const admission = {
      kind: "paid",
      sourceKey: "paid-included:period-1:contract-ended",
      policy: paidPolicy("ACTIVE", "period-1"),
    } as never;

    await expect(
      service.revalidateBeforeProvider({
        admission,
        recoveryId: "contract-ended",
      }),
    ).resolves.toEqual({ kind: "blocked", reason: "contract-required" });
    expect(paidReservationService.release).toHaveBeenCalledOnce();
    expect(postContractResolver.resolve).not.toHaveBeenCalled();
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

    expect(first).toEqual({ kind: "blocked", reason: "capacity-exhausted" });
    expect(second).toEqual({ kind: "blocked", reason: "capacity-exhausted" });
    expect(database.merchantSupportMessage.upsert).toHaveBeenCalledTimes(0);
    expect(database.$transaction).toHaveBeenCalledTimes(2);
    expect(database.transactionMessageUpsert).toHaveBeenCalledTimes(2);
    expect(database.transactionMessageUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          systemCode: "BILLING_RECOVERY_CAPACITY_EXHAUSTED",
        }),
      }),
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
      .resolves.toEqual({ kind: "blocked", reason: "capacity-exhausted" });
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
      .resolves.toMatchObject({ kind: "blocked", reason: "capacity-exhausted" });
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

});