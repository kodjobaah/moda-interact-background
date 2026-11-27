import type { Prisma } from "@prisma/client";
import { freeRecoveryReservationService } from "../free-recovery-reservation.service.js";
import { purchasedRecoveryReservationService } from "../purchased-recovery-reservation.service.js";
import { paidIncludedRecoveryReservationService } from "../paid-included-recovery-reservation.service.js";
import { promotionalRecoveryReservationService } from "../promotional-recovery-reservation.service.js";
import { EffectiveBillingPolicyError, type EffectiveBillingPolicy, EffectiveBillingPolicyResolver } from "../effective-billing-policy.service.js";
import { PostContractRecoveryPolicyError, PostContractRecoveryPolicyResolver } from "../post-contract-recovery-policy.service.js";
import { RecoveryCapacityAdmissionService } from "./recovery-capacity-admission.service.js";
import type { RecoveryBillingAdmissionResult } from "./recovery-billing.types.js";

const CHECKOUT_RECOVERY_FEATURE_KEY = "checkout_recovery";
export type CapacityPolicyOutcome = { result: RecoveryBillingAdmissionResult; exhaustedPolicy?: EffectiveBillingPolicy };

/** Same capacity policy for original sends and serialized retry funding.
 * Notify after the transaction has committed, never from a reservation callback.
 */
export async function admitRecoveryCapacityWithPolicy(
  input: { shopId: string; recoveryId: string; outreachAttemptId?: string },
  sourceKey: string,
  ports: {
    policyResolver: Pick<EffectiveBillingPolicyResolver, "resolve">;
    postContractPolicyResolver: Pick<PostContractRecoveryPolicyResolver, "resolve">;
    capacityAdmission: Pick<RecoveryCapacityAdmissionService, "admit" | "admitPostContract">;
    retry?: boolean;
  },
): Promise<CapacityPolicyOutcome> {
  let policy: EffectiveBillingPolicy;
  try {
    policy = await ports.policyResolver.resolve(input.shopId);
  } catch (error) {
    if (error instanceof EffectiveBillingPolicyError) {
      if (error.reason === "NO_CONTRACT") {
        try {
          const postContractPolicy =
            await ports.postContractPolicyResolver.resolve(input.shopId);
          if (ports.retry && postContractPolicy.automatedWhatsappPaused) return { result: { kind: "blocked", reason: "paused" } };
          return { result: await ports.capacityAdmission.admitPostContract({
            shopId: input.shopId,
            sourceKey,
            policy: postContractPolicy,
          }) };
        } catch (postContractError) {
          if (
            postContractError instanceof PostContractRecoveryPolicyError &&
            postContractError.reason === "CONTRACT_REQUIRED"
          ) {
            return { result: { kind: "blocked", reason: "contract-required" } };
          }
          throw postContractError;
        }
      }
      if (error.reason === "SUBSCRIPTION_FROZEN") {
        return { result: { kind: "blocked", reason: "subscription-frozen" } };
      }
    }
    throw error;
  }
  if (!policy.features.has(CHECKOUT_RECOVERY_FEATURE_KEY)) {
    return { result: { kind: "blocked", reason: "feature-unavailable" } };
  }

  if (policy.newRecoveriesPaused || (ports.retry && policy.automatedWhatsappPaused)) {
    return { result: { kind: "blocked", reason: "paused" } };
  }

  if (
    policy.planKind === "PAID_METERED" &&
    policy.billingPeriod?.phase === "EXPIRED_RECONCILING" &&
    policy.platform !== "WOOCOMMERCE"
  ) {
    return { result: { kind: "blocked", reason: "billing-period-reconciliation" } };
  }

  const admission = await ports.capacityAdmission.admit({
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
    return { result: admission, exhaustedPolicy: policy };
  }

  return { result: admission };
}

/** Existing billing source owners, bound to the caller's single transaction.
 * Never invokes a nested transaction, provider or notification. */
export function admitRetryCapacityInTransaction(tx: Prisma.TransactionClient,
  input: { shopId: string; recoveryId: string; outreachAttemptId: string }, sourceKey: string): Promise<CapacityPolicyOutcome> {
  return admitRecoveryCapacityWithPolicy(input, sourceKey, {
    policyResolver: new EffectiveBillingPolicyResolver(tx),
    postContractPolicyResolver: new PostContractRecoveryPolicyResolver(tx),
    capacityAdmission: new RecoveryCapacityAdmissionService(
      { reserve: value => freeRecoveryReservationService.reserveInExistingTransaction(tx, value),
        reservePostContract: value => freeRecoveryReservationService.reserveInExistingTransaction(tx, value, true) },
      { reserve: value => purchasedRecoveryReservationService.reserveInExistingTransaction(tx, value) },
      { reserve: value => paidIncludedRecoveryReservationService.reserveInExistingTransaction(tx, value) },
      { reserve: value => promotionalRecoveryReservationService.reserveInExistingTransaction(tx, value) },
    ),
    retry: true,
  });
}
