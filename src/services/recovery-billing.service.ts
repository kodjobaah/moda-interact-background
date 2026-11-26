import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";

import prisma from "../lib/db.js";
import {
  effectiveBillingPolicyResolver,
  EffectiveBillingPolicyError,
  EffectiveBillingPolicyResolver,
  type EffectiveBillingPolicy,
} from "./effective-billing-policy.service.js";
import { freeRecoveryReservationService } from "./free-recovery-reservation.service.js";
import { purchasedRecoveryReservationService } from "./purchased-recovery-reservation.service.js";
import { paidIncludedRecoveryReservationService } from "./paid-included-recovery-reservation.service.js";
import { promotionalRecoveryReservationService } from "./promotional-recovery-reservation.service.js";
import {
  postContractRecoveryPolicyResolver,
  PostContractRecoveryPolicyError,
  PostContractRecoveryPolicyResolver,
} from "./post-contract-recovery-policy.service.js";
import {
  RecoveryCapacityExhaustionNotificationService,
  type RecoveryCapacityExhaustionNotificationDatabase,
} from "./recovery-billing/recovery-capacity-exhaustion-notification.service.js";
import { RecoveryCapacityAdmissionService } from "./recovery-billing/recovery-capacity-admission.service.js";
import { RecoveryReservationLifecycleService } from "./recovery-billing/recovery-reservation-lifecycle.service.js";
import { admitRecoveryCapacityWithPolicy } from "./recovery-billing/capacity-policy.js";
import { InitialOutreachCreditService } from "./recovery-billing/initial-outreach-credit.service.js";
import type {
  ConfirmedInitialOutreachCreditInput,
  ConfirmedInitialOutreachSettlement,
  ExistingInitialOutreachCredit,
  ExistingInitialOutreachCreditInput,
  RecoveryBillingAdmission,
  RecoveryBillingAdmissionResult,
  RecoveryProviderFailureDisposition,
} from "./recovery-billing/recovery-billing.types.js";

export type {
  ConfirmedInitialOutreachCreditInput,
  ConfirmedInitialOutreachSettlement,
  ExistingInitialOutreachCredit,
  ExistingInitialOutreachCreditInput,
  InitialOutreachCreditIdentity,
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
type PostContractPolicyResolverPort = Pick<
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
  private readonly initialOutreachCredit: InitialOutreachCreditService;

  constructor(
    database: RecoveryBillingDatabase = prisma,
    private readonly policyResolver: RecoveryPolicyResolver = effectiveBillingPolicyResolver,
    reservationService: FreeReservationService = freeRecoveryReservationService,
    purchasedReservationService: PurchasedReservationService = purchasedRecoveryReservationService,
    paidIncludedReservationService: PaidIncludedReservationService = paidIncludedRecoveryReservationService,
    promotionalReservationService: PromotionalReservationService = promotionalRecoveryReservationService,
    private readonly postContractPolicyResolver: PostContractPolicyResolverPort = postContractRecoveryPolicyResolver,
  ) {
    this.initialOutreachCredit = new InitialOutreachCreditService(database);
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

  settleConfirmedInitialOutreach(
    input: ConfirmedInitialOutreachCreditInput,
  ): Promise<ConfirmedInitialOutreachSettlement> {
    return this.initialOutreachCredit.settleConfirmedInitialOutreach(input);
  }

  revalidateExistingInitialOutreach(
    input: ExistingInitialOutreachCreditInput,
  ): Promise<ExistingInitialOutreachCredit> {
    return this.initialOutreachCredit.revalidateExistingInitialOutreach(input);
  }

  async admit(input: {
    shopId: string;
    recoveryId: string;
    outreachAttemptId?: string;
    /** Exact application-owned action identity, including allowance continuation. */
    fundingSourceId?: string;
  }): Promise<RecoveryBillingAdmissionResult> {
    if (input.fundingSourceId?.startsWith("recovery-outreach:retry_") ||
        (input.outreachAttemptId?.startsWith("retry_") && input.fundingSourceId !== undefined)) {
      return { kind: "blocked", reason: "reservation-in-flight" };
    }
    const sourceKey = createRecoveryIdempotencyKey(
      input.shopId,
      input.fundingSourceId ?? (input.outreachAttemptId
        ? `recovery-outreach:${input.outreachAttemptId}`
        : input.recoveryId),
    );

    const outcome = input.outreachAttemptId?.startsWith("retry_")
      ? await this.initialOutreachCredit.admitInitialRetry({ ...input, outreachAttemptId: input.outreachAttemptId }, (tx) =>
          admitRecoveryCapacityWithPolicy(input, sourceKey, {
            policyResolver: new EffectiveBillingPolicyResolver(tx),
            postContractPolicyResolver: new PostContractRecoveryPolicyResolver(tx),
            capacityAdmission: new RecoveryCapacityAdmissionService(
              { reserve: value => freeRecoveryReservationService.reserveInExistingTransaction(tx, value), reservePostContract: value => freeRecoveryReservationService.reserveInExistingTransaction(tx, value, true) },
              { reserve: value => purchasedRecoveryReservationService.reserveInExistingTransaction(tx, value) },
              { reserve: value => paidIncludedRecoveryReservationService.reserveInExistingTransaction(tx, value) },
              { reserve: value => promotionalRecoveryReservationService.reserveInExistingTransaction(tx, value) },
            ),
            retry: true,
          }))
      : await admitRecoveryCapacityWithPolicy(input, sourceKey, {
          policyResolver: this.policyResolver, postContractPolicyResolver: this.postContractPolicyResolver,
          capacityAdmission: this.capacityAdmission,
        });
    if (outcome.exhaustedPolicy) await this.capacityExhaustionNotification.notify(input.shopId, outcome.exhaustedPolicy);
    return outcome.result;
  }

  async revalidateBeforeProvider(input: {
    admission: RecoveryBillingAdmission;
    recoveryId: string;
    outreachAttemptId?: string;
    fundingSourceId?: string;
  }): Promise<RecoveryBillingAdmissionResult> {
    if (input.fundingSourceId?.startsWith("recovery-outreach:retry_")) return { kind: "blocked", reason: "reservation-in-flight" };
    if (input.outreachAttemptId?.startsWith("retry_")) {
      if (input.fundingSourceId !== undefined) return { kind: "blocked", reason: "reservation-in-flight" };
      const checked = await this.revalidateExistingInitialOutreach({
        shopId: input.admission.policy.shopId, recoveryId: input.recoveryId,
        outreachAttemptId: input.outreachAttemptId, outboundMessageId: null,
      });
      return checked.kind === "admitted" && checked.admission.sourceKey === input.admission.sourceKey
        ? { kind: "admitted", admission: checked.admission }
        : { kind: "blocked", reason: "reservation-in-flight" };
    }
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
      ...(input.fundingSourceId ? { fundingSourceId: input.fundingSourceId } : {}),
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
