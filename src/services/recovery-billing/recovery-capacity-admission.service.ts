import type { EffectiveBillingPolicy } from "../effective-billing-policy.service.js";
import { freeRecoveryReservationService } from "../free-recovery-reservation.service.js";
import { purchasedRecoveryReservationService } from "../purchased-recovery-reservation.service.js";
import {
  paidIncludedRecoveryReservationService,
  type PaidIncludedReservationOutcome,
} from "../paid-included-recovery-reservation.service.js";
import {
  promotionalRecoveryReservationService,
  type PromotionalReservationOutcome,
} from "../promotional-recovery-reservation.service.js";
import type { PostContractRecoveryPolicy } from "../post-contract-recovery-policy.service.js";
import type { RecoveryBillingAdmissionResult } from "./recovery-billing.types.js";
import { RecoveryDurableCreditAdmissionService } from "./recovery-durable-credit-admission.service.js";

type FreeCapacityReservationService = Pick<
  typeof freeRecoveryReservationService,
  "reserve" | "reservePostContract"
>;
type PurchasedCapacityReservationService = Pick<
  typeof purchasedRecoveryReservationService,
  "reserve"
>;
type PaidIncludedCapacityReservationService = Pick<
  typeof paidIncludedRecoveryReservationService,
  "reserve"
>;
type PromotionalCapacityReservationService = Pick<
  typeof promotionalRecoveryReservationService,
  "reserve"
>;

export class RecoveryCapacityAdmissionService {
  private readonly durableCredits: RecoveryDurableCreditAdmissionService;

  constructor(
    freeReservationService: FreeCapacityReservationService = freeRecoveryReservationService,
    purchasedReservationService: PurchasedCapacityReservationService = purchasedRecoveryReservationService,
    private readonly paidIncludedReservationService: PaidIncludedCapacityReservationService = paidIncludedRecoveryReservationService,
    private readonly promotionalReservationService: PromotionalCapacityReservationService = promotionalRecoveryReservationService,
  ) {
    this.durableCredits = new RecoveryDurableCreditAdmissionService(
      freeReservationService,
      purchasedReservationService,
    );
  }

  async admit(input: {
    shopId: string;
    recoveryId: string;
    outreachAttemptId?: string;
    sourceKey: string;
    policy: EffectiveBillingPolicy;
  }): Promise<RecoveryBillingAdmissionResult> {
    const { shopId, sourceKey, policy } = input;

    if (policy.planId) {
      const promotional = await this.promotionalReservationService.reserve({
        shopId,
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
      policy.billingPeriod?.phase === "ACTIVE" &&
      policy.subscriptionStatus !== "FROZEN"
    ) {
      const paid = await this.paidIncludedReservationService.reserve(
        input.outreachAttemptId
          ? { shopId, sourceKey }
          : { shopId, recoveryId: input.recoveryId },
      );
      if (isPaidIncludedAdmission(paid)) {
        return {
          kind: "admitted",
          admission: { kind: "paid", sourceKey: paid.sourceKey, policy },
        };
      }
      if (paid.kind === "allowance-exhausted") {
        return this.admitDurableFallbacks(shopId, sourceKey, policy);
      }
      return { kind: "blocked", reason: "reservation-in-flight" };
    }

    const fallback = await this.admitDurableFallbacks(shopId, sourceKey, policy);
    if (fallback.kind === "admitted" || fallback.reason !== "capacity-exhausted") {
      return fallback;
    }

    if (
      policy.planKind === "PAID_METERED" &&
      policy.billingPeriod?.phase === "DRAINING" &&
      policy.subscriptionStatus !== "FROZEN"
    ) {
      return { kind: "blocked", reason: "billing-period-closing" };
    }

    return fallback;
  }

  async admitPostContract(input: {
    shopId: string;
    sourceKey: string;
    policy: PostContractRecoveryPolicy;
  }): Promise<RecoveryBillingAdmissionResult> {
    if (input.policy.newRecoveriesPaused) {
      return { kind: "blocked", reason: "paused" };
    }

    const purchased = await this.durableCredits.admitPurchased(input);
    if (purchased) return purchased;

    const lifetimeFree = await this.durableCredits.admitLifetimeFree({
      ...input,
      postContract: true,
    });
    if (lifetimeFree) return lifetimeFree;

    return { kind: "blocked", reason: "capacity-exhausted" };
  }

  private async admitDurableFallbacks(
    shopId: string,
    sourceKey: string,
    policy: EffectiveBillingPolicy,
  ): Promise<RecoveryBillingAdmissionResult> {
    const purchased = await this.durableCredits.admitPurchased({
      shopId,
      sourceKey,
      policy,
    });
    if (purchased) return purchased;

    const lifetimeFree = await this.durableCredits.admitLifetimeFree({
      shopId,
      sourceKey,
      policy,
    });
    if (lifetimeFree) return lifetimeFree;

    return { kind: "blocked", reason: "capacity-exhausted" };
  }
}

function isPaidIncludedAdmission(
  reservation: PaidIncludedReservationOutcome,
): reservation is Extract<PaidIncludedReservationOutcome, { sourceKey: string }> {
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
