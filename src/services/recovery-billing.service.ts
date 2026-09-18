import {
  ARCH007_BILLING_CONTRACT_SCHEMA_VERSION,
  BILLING_SYSTEM_MESSAGE_CODES,
  createMerchantBillingSystemSourceKey,
  createRecoveryIdempotencyKey,
} from "@modainteract/moda-interact-shared/billing";
import {
  MerchantSupportMessageKind,
  MerchantSupportMessageState,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import prisma from "../lib/db.js";
import {
  effectiveBillingPolicyResolver,
  EffectiveBillingPolicyError,
  type EffectiveBillingPolicy,
} from "./effective-billing-policy.service.js";
import {
  freeRecoveryReservationService,
  type FreeRecoveryReservationInput,
} from "./free-recovery-reservation.service.js";
import {
  purchasedRecoveryReservationService,
  type PurchasedRecoveryReservationInput,
} from "./purchased-recovery-reservation.service.js";
import {
  paidIncludedRecoveryReservationService,
  type PaidIncludedReservationOutcome,
} from "./paid-included-recovery-reservation.service.js";
import {
  promotionalRecoveryReservationService,
  type PromotionalReservationOutcome,
} from "./promotional-recovery-reservation.service.js";

const CHECKOUT_RECOVERY_FEATURE_KEY = "checkout_recovery";

type RecoveryBillingDatabase = Pick<
  PrismaClient,
  "$transaction" | "merchantSupportThread" | "merchantSupportMessage"
> &
  Partial<
    Pick<
      PrismaClient,
      "shopEntitlementCounter" | "billingPeriodEntitlementCounter"
    >
  > &
  Partial<Pick<PrismaClient, "merchantPromotionSelection">>;

type RecoveryPolicyResolver = Pick<
  typeof effectiveBillingPolicyResolver,
  "resolve"
>;
type FreeReservationService = Pick<
  typeof freeRecoveryReservationService,
  "reserve" | "commit" | "release" | "markAmbiguous"
>;
type PurchasedReservationService = Pick<
  typeof purchasedRecoveryReservationService,
  "reserve" | "commit" | "release" | "markAmbiguous"
>;
type PaidIncludedReservationService = Pick<
  typeof paidIncludedRecoveryReservationService,
  "reserve" | "commit" | "release" | "markAmbiguous"
>;
type PromotionalReservationService = Pick<
  typeof promotionalRecoveryReservationService,
  "reserve" | "commit" | "release" | "markAmbiguous"
>;

export type RecoveryBillingAdmission =
  | {
      kind: "free";
      sourceKey: string;
      policy: EffectiveBillingPolicy;
    }
  | {
      kind: "paid";
      sourceKey: string;
      policy: EffectiveBillingPolicy;
    }
  | {
      kind: "purchased";
      sourceKey: string;
      policy: EffectiveBillingPolicy;
    }
  | {
      kind: "promotional";
      sourceKey: string;
      policy: EffectiveBillingPolicy;
    }
  | {
      kind: "lifetime-free";
      sourceKey: string;
      policy: EffectiveBillingPolicy;
    };

export type RecoveryBillingAdmissionResult =
  | { kind: "admitted"; admission: RecoveryBillingAdmission }
  | {
      kind: "blocked";
      reason:
        | "paused"
        | "capacity-exhausted"
        | "reservation-in-flight"
        | "billing-period-closing"
        | "billing-period-reconciliation"
        | "contract-required"
        | "subscription-frozen"
        | "feature-unavailable";
    };

export type RecoveryProviderFailureDisposition = "definitive" | "ambiguous";

export class RecoveryBillingService {
  constructor(
    private readonly database: RecoveryBillingDatabase = prisma,
    private readonly policyResolver: RecoveryPolicyResolver = effectiveBillingPolicyResolver,
    private readonly reservationService: FreeReservationService = freeRecoveryReservationService,
    private readonly purchasedReservationService: PurchasedReservationService = purchasedRecoveryReservationService,
    private readonly paidIncludedReservationService: PaidIncludedReservationService = paidIncludedRecoveryReservationService,
    private readonly promotionalReservationService: PromotionalReservationService = promotionalRecoveryReservationService,
  ) {}

  async admit(input: {
    shopId: string;
    recoveryId: string;
    outreachAttemptId?: string;
  }): Promise<RecoveryBillingAdmissionResult> {
    let policy: EffectiveBillingPolicy;
    try {
      policy = await this.policyResolver.resolve(input.shopId);
    } catch (error) {
      if (error instanceof EffectiveBillingPolicyError) {
        if (error.reason === "NO_CONTRACT") {
          return { kind: "blocked", reason: "contract-required" };
        }
        if (error.reason === "SUBSCRIPTION_FROZEN") {
          return { kind: "blocked", reason: "subscription-frozen" };
        }
      }
      throw error;
    }
    if (!policy.features.has(CHECKOUT_RECOVERY_FEATURE_KEY)) {
      return { kind: "blocked", reason: "feature-unavailable" };
    }
    const sourceKey = createRecoveryIdempotencyKey(
      input.shopId,
      input.outreachAttemptId
        ? `recovery-outreach:${input.outreachAttemptId}`
        : input.recoveryId,
    );

    if (policy.newRecoveriesPaused) {
      return { kind: "blocked", reason: "paused" };
    }

    if (
      policy.planKind === "PAID_METERED" &&
      policy.billingPeriod?.phase === "EXPIRED_RECONCILING"
    ) {
      return { kind: "blocked", reason: "billing-period-reconciliation" };
    }

    if (policy.planId) {
      const promotional = await this.promotionalReservationService.reserve({
        shopId: input.shopId,
        sourceKey,
        planId: policy.planId,
      });
      if (isPromotionalAdmission(promotional)) {
        return {
          kind: "admitted",
          admission: {
            kind: "promotional",
            sourceKey: promotional.sourceKey,
            policy,
          },
        };
      }
      if (
        promotional.kind === "already-ambiguous" ||
        promotional.kind === "already-released"
      ) {
        return { kind: "blocked", reason: "reservation-in-flight" };
      }
    }

    if (
      policy.planKind === "PAID_METERED" &&
      policy.billingPeriod?.phase === "ACTIVE"
    ) {
      const paid = await this.paidIncludedReservationService.reserve(
        input.outreachAttemptId
          ? { shopId: input.shopId, sourceKey }
          : { shopId: input.shopId, recoveryId: input.recoveryId },
      );
      if (isPaidIncludedAdmission(paid)) {
        return {
          kind: "admitted",
          admission: { kind: "paid", sourceKey: paid.sourceKey, policy },
        };
      }
      if (paid.kind === "allowance-exhausted") {
        const purchased = await this.tryPurchasedAdmission(
          input.shopId,
          sourceKey,
          policy,
        );
        if (purchased) return purchased;
        const lifetimeFree = await this.tryLifetimeFreeAdmission(
          input.shopId,
          sourceKey,
          policy,
        );
        if (lifetimeFree) return lifetimeFree;
        await this.createCapacityExhaustedMessage(input.shopId, policy);
        return { kind: "blocked", reason: "capacity-exhausted" };
      }
      return { kind: "blocked", reason: "reservation-in-flight" };
    }

    const purchased = await this.tryPurchasedAdmission(
      input.shopId,
      sourceKey,
      policy,
    );
    if (purchased) return purchased;
    const lifetimeFree = await this.tryLifetimeFreeAdmission(
      input.shopId,
      sourceKey,
      policy,
    );
    if (lifetimeFree) return lifetimeFree;
    if (
      policy.planKind === "PAID_METERED" &&
      policy.billingPeriod?.phase === "DRAINING"
    ) {
      return {
        kind: "blocked",
        reason: "billing-period-closing",
      };
    }

    await this.createCapacityExhaustedMessage(input.shopId, policy);

    return {
      kind: "blocked",
      reason: "capacity-exhausted",
    };
  }

  async revalidateBeforeProvider(input: {
    admission: RecoveryBillingAdmission;
    recoveryId: string;
    outreachAttemptId?: string;
  }): Promise<RecoveryBillingAdmissionResult> {
    let current: EffectiveBillingPolicy;
    try {
      current = await this.policyResolver.resolve(input.admission.policy.shopId);
    } catch (error) {
      if (error instanceof EffectiveBillingPolicyError) {
        if (error.reason === "NO_CONTRACT" || error.reason === "SUBSCRIPTION_FROZEN") {
          await this.releaseBeforeProvider(input.admission);
          return {
            kind: "blocked",
            reason: error.reason === "NO_CONTRACT" ? "contract-required" : "subscription-frozen",
          };
        }
      }
      throw error;
    }

    if (
      current.planKind === "PAID_METERED" &&
      current.billingPeriod?.phase === "EXPIRED_RECONCILING"
    ) {
      await this.releaseBeforeProvider(input.admission);
      return { kind: "blocked", reason: "billing-period-reconciliation" };
    }

    if (current.newRecoveriesPaused) {
      await this.releaseBeforeProvider(input.admission);
      return { kind: "blocked", reason: "paused" };
    }

    if (
      input.admission.kind === "free" ||
      input.admission.kind === "lifetime-free" ||
      input.admission.kind === "purchased"
    ) {
      return { kind: "admitted", admission: input.admission };
    }

    if (
      input.admission.kind === "paid" &&
      current.planKind === "PAID_METERED" &&
      current.billingPeriod?.phase === "ACTIVE" &&
      current.billingPeriod.id === input.admission.policy.billingPeriod?.id
    ) {
      return { kind: "admitted", admission: input.admission };
    }

    await this.releaseBeforeProvider(input.admission);
    return this.admit({
      shopId: input.admission.policy.shopId,
      recoveryId: input.recoveryId,
      ...(input.outreachAttemptId
        ? { outreachAttemptId: input.outreachAttemptId }
        : {}),
    });
  }

  async commitSuccessfulInitiation(input: {
    admission: RecoveryBillingAdmission;
    recoveryId: string;
    occurredAt: Date;
  }): Promise<void> {
    if (input.admission.kind === "promotional") {
      await this.promotionalReservationService.commit({
        shopId: input.admission.policy.shopId,
        sourceKey: input.admission.sourceKey,
        planId: input.admission.policy.planId,
      });
      return;
    }
    if (
      input.admission.kind === "free" ||
      input.admission.kind === "lifetime-free"
    ) {
      await this.reservationService.commit({
        shopId: input.admission.policy.shopId,
        sourceKey: input.admission.sourceKey,
      });
      return;
    }

    if (input.admission.kind === "purchased") {
      await this.purchasedReservationService.commit({
        shopId: input.admission.policy.shopId,
        sourceKey: input.admission.sourceKey,
      });
      return;
    }

    await this.paidIncludedReservationService.commit({
      shopId: input.admission.policy.shopId,
      sourceKey: input.admission.sourceKey,
      occurredAt: input.occurredAt,
    });
  }

  async handleProviderFailure(input: {
    admission: RecoveryBillingAdmission;
    error: unknown;
  }): Promise<RecoveryProviderFailureDisposition> {
    const disposition = isDefinitiveProviderFailure(input.error)
      ? "definitive"
      : "ambiguous";

    if (input.admission.kind === "promotional") {
      const reservationInput = {
        shopId: input.admission.policy.shopId,
        sourceKey: input.admission.sourceKey,
        planId: input.admission.policy.planId,
      };
      if (disposition === "definitive") {
        await this.promotionalReservationService.release(reservationInput);
      } else {
        await this.promotionalReservationService.markAmbiguous(
          reservationInput,
        );
      }
      return disposition;
    }

    if (input.admission.kind === "purchased") {
      const reservationInput = {
        shopId: input.admission.policy.shopId,
        sourceKey: input.admission.sourceKey,
      };
      if (disposition === "definitive") {
        await this.purchasedReservationService.release(reservationInput);
      } else {
        await this.purchasedReservationService.markAmbiguous(reservationInput);
      }
      return disposition;
    }

    if (input.admission.kind === "paid") {
      const reservationInput = {
        shopId: input.admission.policy.shopId,
        sourceKey: input.admission.sourceKey,
      };
      if (disposition === "definitive") {
        await this.paidIncludedReservationService.release(reservationInput);
      } else {
        await this.paidIncludedReservationService.markAmbiguous(
          reservationInput,
        );
      }
      return disposition;
    }

    if (
      input.admission.kind !== "free" &&
      input.admission.kind !== "lifetime-free"
    )
      return disposition;

    const reservationInput = {
      shopId: input.admission.policy.shopId,
      sourceKey: input.admission.sourceKey,
    };

    if (disposition === "definitive") {
      await this.reservationService.release(reservationInput);
      return disposition;
    }

    await this.reservationService.markAmbiguous(reservationInput);
    return disposition;
  }

  async releaseBeforeProvider(
    admission: RecoveryBillingAdmission,
  ): Promise<void> {
    if (admission.kind === "promotional") {
      await this.promotionalReservationService.release({
        shopId: admission.policy.shopId,
        sourceKey: admission.sourceKey,
        planId: admission.policy.planId,
      });
      return;
    }
    if (admission.kind === "purchased") {
      await this.purchasedReservationService.release({
        shopId: admission.policy.shopId,
        sourceKey: admission.sourceKey,
      });
      return;
    }
    if (admission.kind === "paid") {
      await this.paidIncludedReservationService.release({
        shopId: admission.policy.shopId,
        sourceKey: admission.sourceKey,
      });
      return;
    }
    if (admission.kind !== "free" && admission.kind !== "lifetime-free") return;
    await this.reservationService.release({
      shopId: admission.policy.shopId,
      sourceKey: admission.sourceKey,
    });
  }

  private async tryPurchasedAdmission(
    shopId: string,
    sourceKey: string,
    policy: EffectiveBillingPolicy,
  ): Promise<RecoveryBillingAdmissionResult | null> {
    const reservationInput: PurchasedRecoveryReservationInput = {
      shopId,
      sourceKey,
    };
    const reservation =
      await this.purchasedReservationService.reserve(reservationInput);
    if (
      reservation.kind === "reserved" ||
      isOwnedBy(reservation, "PURCHASED_RECOVERY_CREDITS")
    ) {
      if (isAmbiguous(reservation) || isReleased(reservation)) {
        return { kind: "blocked", reason: "reservation-in-flight" };
      }
      return {
        kind: "admitted",
        admission: {
          kind: "purchased",
          sourceKey: reservationInput.sourceKey,
          policy,
        },
      };
    }
    if (reservation.kind === "credits-exhausted") return null;
    if (isOwnedBy(reservation, "LIFETIME_FREE_RECOVERY_CREDITS")) {
      if (isAmbiguous(reservation))
        return { kind: "blocked", reason: "reservation-in-flight" };
      if (isReleased(reservation)) {
        const reactivated = await this.reservationService.reserve({
          shopId,
          sourceKey,
        });
        if (!isAdmittedReplay(reactivated, "LIFETIME_FREE_RECOVERY_CREDITS")) {
          return { kind: "blocked", reason: "reservation-in-flight" };
        }
      }
      return {
        kind: "admitted",
        admission: { kind: "lifetime-free", sourceKey, policy },
      };
    }
    return { kind: "blocked", reason: "reservation-in-flight" };
  }

  private async tryLifetimeFreeAdmission(
    shopId: string,
    sourceKey: string,
    policy: EffectiveBillingPolicy,
  ): Promise<RecoveryBillingAdmissionResult | null> {
    const reservation = await this.reservationService.reserve({
      shopId,
      sourceKey,
    });
    if (
      reservation.kind === "reserved" ||
      isOwnedBy(reservation, "LIFETIME_FREE_RECOVERY_CREDITS")
    ) {
      if (isAmbiguous(reservation) || isReleased(reservation)) {
        return { kind: "blocked", reason: "reservation-in-flight" };
      }
      return {
        kind: "admitted",
        admission: { kind: "lifetime-free", sourceKey, policy },
      };
    }
    if (reservation.kind === "allowance-exhausted") return null;
    if (reservation.kind === "paused")
      return { kind: "blocked", reason: "paused" };
    if (isOwnedBy(reservation, "PURCHASED_RECOVERY_CREDITS")) {
      if (isAmbiguous(reservation))
        return { kind: "blocked", reason: "reservation-in-flight" };
      if (isReleased(reservation)) {
        const reactivated = await this.purchasedReservationService.reserve({
          shopId,
          sourceKey,
        });
        if (!isAdmittedReplay(reactivated, "PURCHASED_RECOVERY_CREDITS")) {
          return { kind: "blocked", reason: "reservation-in-flight" };
        }
      }
      return {
        kind: "admitted",
        admission: { kind: "purchased", sourceKey, policy },
      };
    }
    return { kind: "blocked", reason: "reservation-in-flight" };
  }

  private async createCapacityExhaustedMessage(
    shopId: string,
    policy: EffectiveBillingPolicy,
  ): Promise<void> {
    const systemCode = BILLING_SYSTEM_MESSAGE_CODES.RECOVERY_CAPACITY_EXHAUSTED;
    const purchasedCounter = this.database.shopEntitlementCounter
      ? await this.database.shopEntitlementCounter.findUnique({
          where: {
            shopId_counter: { shopId, counter: "PURCHASED_RECOVERY_CREDITS" },
          },
          select: {
            grantedQuantity: true,
            committedQuantity: true,
            reservedQuantity: true,
            refundingQuantity: true,
          },
        })
      : null;
    const includedCounter =
      policy.billingPeriod && this.database.billingPeriodEntitlementCounter
        ? await this.database.billingPeriodEntitlementCounter.findUnique({
            where: {
              billingPeriodId_counter: {
                billingPeriodId: policy.billingPeriod.id,
                counter: "INCLUDED_RECOVERY_CREDITS",
              },
            },
            select: {
              grantedQuantity: true,
              committedQuantity: true,
              reservedQuantity: true,
              forfeitedQuantity: true,
            },
          })
        : null;
      const selectedPromotion = this.database.merchantPromotionSelection
        ? await this.database.merchantPromotionSelection.findUnique({
            where: { shopId },
            select: {
              promotionalCreditGrant: {
                select: {
                  id: true,
                  version: true,
                  quantity: true,
                  committedQuantity: true,
                  reservedQuantity: true,
                },
              },
            },
          })
        : null;
      const selectedGrant = selectedPromotion?.promotionalCreditGrant;
    const exhaustionLifecycle = [
      policy.planKind,
      policy.subscriptionId,
      policy.billingPeriod?.id ?? "no-period",
      policy.freeAllowance
        ? `${policy.freeAllowance.grant}:${policy.freeAllowance.committed}:${policy.freeAllowance.reserved}`
        : "no-free-allowance",
      includedCounter
        ? `${includedCounter.grantedQuantity}:${includedCounter.committedQuantity}:${includedCounter.reservedQuantity}:${includedCounter.forfeitedQuantity}`
        : "no-included-counter",
      purchasedCounter
        ? `${purchasedCounter.grantedQuantity}:${purchasedCounter.committedQuantity}:${purchasedCounter.reservedQuantity}:${purchasedCounter.refundingQuantity}`
        : "no-purchased-counter",
      selectedGrant
        ? `${selectedGrant.id}:${selectedGrant.version}:${selectedGrant.quantity}:${selectedGrant.committedQuantity}:${selectedGrant.reservedQuantity}`
        : "no-selected-promotion",
      policy.recoveryCreditPack?.shopifyEventHandle ?? "no-pack",
    ].join("|");
    const sourceKey = createMerchantBillingSystemSourceKey(
      shopId,
      systemCode,
      exhaustionLifecycle,
      ARCH007_BILLING_CONTRACT_SCHEMA_VERSION,
    );
    const now = new Date();

    await this.database.$transaction(async (transaction) => {
      const thread = await transaction.merchantSupportThread.upsert({
        where: { shopId },
        create: { shopId },
        update: {},
      });

      await transaction.merchantSupportMessage.upsert({
        where: { sourceKey },
        create: {
          threadId: thread.id,
          kind: MerchantSupportMessageKind.SYSTEM,
          state: MerchantSupportMessageState.AVAILABLE,
          originalBody:
            policy.planKind === "FREE"
              ? "Every applicable Free-plan recovery-capacity source is exhausted: promotional credits, purchased credits and shop-lifetime Free. New abandoned-checkout recoveries are paused. Existing conversations continue. You can manage recovery capacity or change plan."
              : "Every applicable recovery-capacity source is exhausted: Paid monthly included where applicable, promotional credits, purchased credits and shop-lifetime Free. New abandoned-checkout recoveries are paused. Existing conversations continue. Capacity returns when any canonical source becomes available again.",
          sourceLanguageTag: "en-GB",
          systemCode,
          systemVersion: String(ARCH007_BILLING_CONTRACT_SCHEMA_VERSION),
          sourceKey,
          availableAt: now,
        },
        update: {},
      });

      await transaction.merchantSupportThread.update({
        where: { id: thread.id },
        data: { lastMessageAt: now },
      });
    });
  }
}

function isDefinitiveProviderFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "WhatsAppServiceError" &&
    "code" in error &&
    (error.code === "configuration-missing" ||
      error.code === "provider-rejected")
  );
}

function isOwnedBy(
  reservation: { kind: string; counter?: string },
  counter: "PURCHASED_RECOVERY_CREDITS" | "LIFETIME_FREE_RECOVERY_CREDITS",
): boolean {
  return "counter" in reservation && reservation.counter === counter;
}

function isAmbiguous(reservation: { kind: string }): boolean {
  return (
    reservation.kind === "ambiguous" || reservation.kind === "already-ambiguous"
  );
}

function isReleased(reservation: { kind: string }): boolean {
  return (
    reservation.kind === "released" || reservation.kind === "already-released"
  );
}

function isAdmittedReplay(
  reservation: { kind: string; counter?: string },
  counter: "PURCHASED_RECOVERY_CREDITS" | "LIFETIME_FREE_RECOVERY_CREDITS",
): boolean {
  return (
    isOwnedBy(reservation, counter) &&
    (reservation.kind === "reserved" ||
      reservation.kind === "already-reserved" ||
      reservation.kind === "already-committed")
  );
}

function isPaidIncludedAdmission(
  reservation: PaidIncludedReservationOutcome,
): reservation is Extract<
  PaidIncludedReservationOutcome,
  { sourceKey: string }
> {
  return (
    reservation.kind === "reserved" ||
    reservation.kind === "already-reserved" ||
    reservation.kind === "already-committed"
  );
}

function isPromotionalAdmission(
  reservation: PromotionalReservationOutcome,
): reservation is Extract<
  PromotionalReservationOutcome,
  { kind: "reserved" | "already-reserved" | "already-committed" }
> {
  return (
    reservation.kind === "reserved" ||
    reservation.kind === "already-reserved" ||
    reservation.kind === "already-committed"
  );
}

export const recoveryBillingService = new RecoveryBillingService();
