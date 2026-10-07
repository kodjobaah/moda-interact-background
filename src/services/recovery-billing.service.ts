import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";

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
import {
  postContractRecoveryPolicyResolver,
  PostContractRecoveryPolicyError,
  type PostContractRecoveryPolicy,
} from "./post-contract-recovery-policy.service.js";
import {
  RecoveryCapacityExhaustionNotificationService,
  type RecoveryCapacityExhaustionNotificationDatabase,
} from "./recovery-billing/recovery-capacity-exhaustion-notification.service.js";
import { RecoveryReservationLifecycleService } from "./recovery-billing/recovery-reservation-lifecycle.service.js";
import type {
  RecoveryBillingAdmission,
  RecoveryBillingAdmissionResult,
  RecoveryPolicy,
  RecoveryProviderFailureDisposition,
} from "./recovery-billing/recovery-billing.types.js";

export type {
  RecoveryBillingAdmission,
  RecoveryBillingAdmissionResult,
  RecoveryProviderFailureDisposition,
} from "./recovery-billing/recovery-billing.types.js";

const CHECKOUT_RECOVERY_FEATURE_KEY = "checkout_recovery";

type RecoveryBillingDatabase = RecoveryCapacityExhaustionNotificationDatabase;

type RecoveryPolicyResolver = Pick<
  typeof effectiveBillingPolicyResolver,
  "resolve"
>;
type PostContractRecoveryPolicyResolver = Pick<
  typeof postContractRecoveryPolicyResolver,
  "resolve"
>;
type FreeReservationService = Pick<
  typeof freeRecoveryReservationService,
  "reserve" | "reservePostContract" | "commit" | "release" | "markAmbiguous"
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

export class RecoveryBillingService {
  private readonly capacityExhaustionNotification: RecoveryCapacityExhaustionNotificationService;
  private readonly reservationLifecycle: RecoveryReservationLifecycleService;

  constructor(
    database: RecoveryBillingDatabase = prisma,
    private readonly policyResolver: RecoveryPolicyResolver = effectiveBillingPolicyResolver,
    private readonly reservationService: FreeReservationService = freeRecoveryReservationService,
    private readonly purchasedReservationService: PurchasedReservationService = purchasedRecoveryReservationService,
    private readonly paidIncludedReservationService: PaidIncludedReservationService = paidIncludedRecoveryReservationService,
    private readonly promotionalReservationService: PromotionalReservationService = promotionalRecoveryReservationService,
    private readonly postContractPolicyResolver: PostContractRecoveryPolicyResolver = postContractRecoveryPolicyResolver,
  ) {
    this.capacityExhaustionNotification =
      new RecoveryCapacityExhaustionNotificationService(database);
    this.reservationLifecycle = new RecoveryReservationLifecycleService(
      reservationService,
      purchasedReservationService,
      paidIncludedReservationService,
      promotionalReservationService,
    );
  }

  async admit(input: {
    shopId: string;
    recoveryId: string;
    outreachAttemptId?: string;
  }): Promise<RecoveryBillingAdmissionResult> {
    const sourceKey = createRecoveryIdempotencyKey(
      input.shopId,
      input.outreachAttemptId
        ? `recovery-outreach:${input.outreachAttemptId}`
        : input.recoveryId,
    );

    let policy: EffectiveBillingPolicy;
    try {
      policy = await this.policyResolver.resolve(input.shopId);
    } catch (error) {
      if (error instanceof EffectiveBillingPolicyError) {
        if (error.reason === "NO_CONTRACT") {
          try {
            const postContractPolicy =
              await this.postContractPolicyResolver.resolve(input.shopId);
            return this.admitPostContract(
              input.shopId,
              sourceKey,
              postContractPolicy,
            );
          } catch (postContractError) {
            if (
              postContractError instanceof PostContractRecoveryPolicyError &&
              postContractError.reason === "CONTRACT_REQUIRED"
            ) {
              return { kind: "blocked", reason: "contract-required" };
            }
            throw postContractError;
          }
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
        await this.capacityExhaustionNotification.notify(input.shopId, policy);
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

    await this.capacityExhaustionNotification.notify(input.shopId, policy);

    return {
      kind: "blocked",
      reason: "capacity-exhausted",
    };
  }

  private async admitPostContract(
    shopId: string,
    sourceKey: string,
    policy: PostContractRecoveryPolicy,
  ): Promise<RecoveryBillingAdmissionResult> {
    if (policy.newRecoveriesPaused) {
      return { kind: "blocked", reason: "paused" };
    }

    const purchased = await this.tryPurchasedAdmission(shopId, sourceKey, policy);
    if (purchased) return purchased;

    const lifetimeFree = await this.tryLifetimeFreeAdmission(
      shopId,
      sourceKey,
      policy,
      true,
    );
    if (lifetimeFree) return lifetimeFree;

    return { kind: "blocked", reason: "capacity-exhausted" };
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
        if (error.reason === "NO_CONTRACT") {
          if (isDurableCreditAdmission(input.admission)) {
            try {
              const postContractPolicy =
                await this.postContractPolicyResolver.resolve(
                  input.admission.policy.shopId,
                );
              if (postContractPolicy.newRecoveriesPaused) {
                await this.releaseBeforeProvider(input.admission);
                return { kind: "blocked", reason: "paused" };
              }
              return { kind: "admitted", admission: input.admission };
            } catch (postContractError) {
              if (
                postContractError instanceof PostContractRecoveryPolicyError &&
                (postContractError.reason === "CONTRACT_REQUIRED" ||
                  postContractError.reason === "SHOP_UNAVAILABLE")
              ) {
                await this.releaseBeforeProvider(input.admission);
                return { kind: "blocked", reason: "contract-required" };
              }
              throw postContractError;
            }
          }
          await this.releaseBeforeProvider(input.admission);
          return { kind: "blocked", reason: "contract-required" };
        }
        if (error.reason === "SUBSCRIPTION_FROZEN") {
          await this.releaseBeforeProvider(input.admission);
          return { kind: "blocked", reason: "subscription-frozen" };
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

    if (!current.features.has(CHECKOUT_RECOVERY_FEATURE_KEY)) {
      await this.releaseBeforeProvider(input.admission);
      return { kind: "blocked", reason: "feature-unavailable" };
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
    await this.reservationLifecycle.commit({
      admission: input.admission,
      occurredAt: input.occurredAt,
    });
  }

  async handleProviderFailure(input: {
    admission: RecoveryBillingAdmission;
    error: unknown;
  }): Promise<RecoveryProviderFailureDisposition> {
    return this.reservationLifecycle.handleProviderFailure(input);
  }

  async releaseBeforeProvider(
    admission: RecoveryBillingAdmission,
  ): Promise<void> {
    await this.reservationLifecycle.release(admission);
  }

  private async tryPurchasedAdmission(
    shopId: string,
    sourceKey: string,
    policy: RecoveryPolicy,
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
        const reactivated = isPostContractRecoveryPolicy(policy)
          ? await this.reservationService.reservePostContract({ shopId, sourceKey })
          : await this.reservationService.reserve({ shopId, sourceKey });
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
    policy: RecoveryPolicy,
    postContract = false,
  ): Promise<RecoveryBillingAdmissionResult | null> {
    const reservation = postContract
      ? await this.reservationService.reservePostContract({ shopId, sourceKey })
      : await this.reservationService.reserve({ shopId, sourceKey });
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

}

function isDurableCreditAdmission(
  admission: RecoveryBillingAdmission,
): admission is Extract<
  RecoveryBillingAdmission,
  { kind: "purchased" | "lifetime-free" }
> {
  return admission.kind === "purchased" || admission.kind === "lifetime-free";
}

function isPostContractRecoveryPolicy(
  policy: RecoveryPolicy,
): policy is PostContractRecoveryPolicy {
  return "mode" in policy && policy.mode === "POST_CONTRACT_DURABLE_CREDITS";
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
