import { describe, expect, it, vi } from "vitest";

import { RecoveryBillingService } from "../../../src/services/recovery-billing.service.js";
import { EffectiveBillingPolicyError } from "../../../src/services/effective-billing-policy.service.js";
import { PostContractRecoveryPolicyError } from "../../../src/services/post-contract-recovery-policy.service.js";

import {
  createDatabase,
  freePolicy,
  paidIncludedReservationService,
  paidPolicy,
  unavailablePromotionalReservationService,
} from "./recovery-billing/recovery-billing.test-support.js";

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



































});