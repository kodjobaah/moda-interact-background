import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";

import prisma from "../lib/db.js";
import {
  effectiveBillingPolicyResolver,
  EffectiveBillingPolicyError,
  type EffectiveBillingPolicy,
} from "./effective-billing-policy.service.js";
import { freeRecoveryReservationService } from "./free-recovery-reservation.service.js";
import { purchasedRecoveryReservationService } from "./purchased-recovery-reservation.service.js";
import { paidIncludedRecoveryReservationService } from "./paid-included-recovery-reservation.service.js";
import { promotionalRecoveryReservationService } from "./promotional-recovery-reservation.service.js";
import {
  postContractRecoveryPolicyResolver,
  PostContractRecoveryPolicyError,
} from "./post-contract-recovery-policy.service.js";
import {
  RecoveryCapacityExhaustionNotificationService,
  type RecoveryCapacityExhaustionNotificationDatabase,
} from "./recovery-billing/recovery-capacity-exhaustion-notification.service.js";
import { RecoveryCapacityAdmissionService } from "./recovery-billing/recovery-capacity-admission.service.js";
import { RecoveryReservationLifecycleService } from "./recovery-billing/recovery-reservation-lifecycle.service.js";
import type {
  RecoveryBillingAdmission,
  RecoveryBillingAdmissionResult,
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
  private readonly capacityAdmission: RecoveryCapacityAdmissionService;
  private readonly reservationLifecycle: RecoveryReservationLifecycleService;

  constructor(
    database: RecoveryBillingDatabase = prisma,
    private readonly policyResolver: RecoveryPolicyResolver = effectiveBillingPolicyResolver,
    reservationService: FreeReservationService = freeRecoveryReservationService,
    purchasedReservationService: PurchasedReservationService = purchasedRecoveryReservationService,
    paidIncludedReservationService: PaidIncludedReservationService = paidIncludedRecoveryReservationService,
    promotionalReservationService: PromotionalReservationService = promotionalRecoveryReservationService,
    private readonly postContractPolicyResolver: PostContractRecoveryPolicyResolver = postContractRecoveryPolicyResolver,
  ) {
    this.capacityExhaustionNotification =
      new RecoveryCapacityExhaustionNotificationService(database);
    this.capacityAdmission = new RecoveryCapacityAdmissionService(
      reservationService,
      purchasedReservationService,
      paidIncludedReservationService,
      promotionalReservationService,
    );
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
            return this.capacityAdmission.admitPostContract({
              shopId: input.shopId,
              sourceKey,
              policy: postContractPolicy,
            });
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
      policy.billingPeriod?.phase === "EXPIRED_RECONCILING" &&
      policy.platform !== "WOOCOMMERCE"
    ) {
      return { kind: "blocked", reason: "billing-period-reconciliation" };
    }

    const admission = await this.capacityAdmission.admit({
      shopId: input.shopId,
      recoveryId: input.recoveryId,
      sourceKey,
      policy,
      ...(input.outreachAttemptId
        ? { outreachAttemptId: input.outreachAttemptId }
        : {}),
    });

    if (
      admission.kind === "blocked" &&
      admission.reason === "capacity-exhausted"
    ) {
      await this.capacityExhaustionNotification.notify(input.shopId, policy);
    }

    return admission;
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
      current.billingPeriod?.phase === "EXPIRED_RECONCILING" &&
      current.platform !== "WOOCOMMERCE"
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
      current.platform === "WOOCOMMERCE" &&
      (current.subscriptionStatus === "FROZEN" ||
        current.billingPeriod?.phase === "EXPIRED_RECONCILING") &&
      (input.admission.kind === "promotional" ||
        input.admission.kind === "purchased" ||
        input.admission.kind === "lifetime-free")
    ) {
      return { kind: "admitted", admission: input.admission };
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
      current.subscriptionStatus !== "FROZEN" &&
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
}

function isDurableCreditAdmission(
  admission: RecoveryBillingAdmission,
): admission is Extract<
  RecoveryBillingAdmission,
  { kind: "purchased" | "lifetime-free" }
> {
  return admission.kind === "purchased" || admission.kind === "lifetime-free";
}

export const recoveryBillingService = new RecoveryBillingService();
