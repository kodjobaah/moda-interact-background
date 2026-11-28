import {
  BillingPeriodStatus,
  UsageReservationStatus,
  type Prisma,
} from "@prisma/client";
import {
  EffectiveBillingPolicyResolver,
  EffectiveBillingPolicyError,
} from "../effective-billing-policy.service.js";
import {
  PostContractRecoveryPolicyResolver,
  PostContractRecoveryPolicyError,
} from "../post-contract-recovery-policy.service.js";
import { promotionalRecoveryReservationService } from "../promotional-recovery-reservation.service.js";
import { findExactRecoveryReservationSource } from "../recovery-delivery-compensation/lineage.js";
import type {
  ExistingInitialOutreachCredit,
  ExistingInitialOutreachCreditInput,
  RecoveryBillingAdmission,
} from "./recovery-billing.types.js";

type Tx = Prisma.TransactionClient;
type Stage = (stage: string, sourceKind?: string) => void;
type ExistingHoldReason = Extract<
  ExistingInitialOutreachCredit,
  { kind: "held" }
>["reason"];
export class ExistingHoldSignal extends Error {
  constructor(
    readonly reason: ExistingHoldReason,
    readonly source?: { reservationId: string; sourceKey: string },
    readonly original?: unknown,
  ) {
    super(reason);
  }
}

export async function paidPeriodId(
  tx: Tx,
  reservation: { billingPeriodEntitlementCounterId: string | null },
): Promise<string | null> {
  if (!reservation.billingPeriodEntitlementCounterId) return null;
  return (
    (
      await tx.billingPeriodEntitlementCounter.findUnique({
        where: { id: reservation.billingPeriodEntitlementCounterId },
        select: { billingPeriodId: true },
      })
    )?.billingPeriodId ?? null
  );
}

/** Shared reserved-source proof. The caller must hold the owner locks and
 * prove the exact action before using the result. This is not a claim or a
 * dispatch permit. */
export async function readReservedRecoveryFunding(
  tx: Tx,
  input: ExistingInitialOutreachCreditInput,
  retry: boolean,
  now: Date,
  setStage: Stage,
): Promise<ExistingInitialOutreachCredit> {
  setStage("source_lookup");
  const source = await findExactRecoveryReservationSource(
    tx,
    input.shopId,
    input.outreachAttemptId,
  );
  if (!source)
    return input.outboundMessageId === null
      ? { kind: "absent" }
      : { kind: "held", reason: "lineage-conflict" };
  setStage("source_lookup", source.kind);
  const reservation = source.reservation;
  if (reservation.status !== UsageReservationStatus.RESERVED)
    return {
      kind: "held",
      reason: "reservation-not-reserved",
      reservationId: reservation.id,
      sourceKey: reservation.sourceKey,
    };
  if (reservation.expiresAt && reservation.expiresAt <= now)
    return {
      kind: "held",
      reason: "reservation-expired",
      reservationId: reservation.id,
      sourceKey: reservation.sourceKey,
    };
  if (
    reservation.committedUsageEventId ||
    reservation.compensationUsageEventId ||
    reservation.compensationReason ||
    reservation.compensationDisposition ||
    reservation.compensatedAt
  )
    return {
      kind: "held",
      reason: "lineage-conflict",
      reservationId: reservation.id,
      sourceKey: reservation.sourceKey,
    };
  setStage("policy");
  let policy;
  try {
    policy = await new EffectiveBillingPolicyResolver(tx).resolve(input.shopId);
  } catch (error) {
    if (
      error instanceof EffectiveBillingPolicyError &&
      error.reason === "NO_CONTRACT"
    ) {
      try {
        policy = await new PostContractRecoveryPolicyResolver(tx).resolve(
          input.shopId,
        );
      } catch (postError) {
        if (
          postError instanceof PostContractRecoveryPolicyError &&
          (postError.reason === "CONTRACT_REQUIRED" ||
            postError.reason === "SHOP_UNAVAILABLE")
        )
          throw new ExistingHoldSignal(
            "contract-required",
            { reservationId: reservation.id, sourceKey: reservation.sourceKey },
            postError,
          );
        throw postError;
      }
    } else if (
      error instanceof EffectiveBillingPolicyError &&
      error.reason === "SUBSCRIPTION_FROZEN"
    )
      throw new ExistingHoldSignal(
        "subscription-frozen",
        { reservationId: reservation.id, sourceKey: reservation.sourceKey },
        error,
      );
    else if (
      error instanceof EffectiveBillingPolicyError &&
      (error.reason === "SHOP_UNAVAILABLE" || error.reason === "UNMAPPED_PLAN")
    )
      throw new ExistingHoldSignal(
        "contract-required",
        { reservationId: reservation.id, sourceKey: reservation.sourceKey },
        error,
      );
    else throw error;
  }
  if ("features" in policy && !policy.features.has("checkout_recovery"))
    return {
      kind: "held",
      reason: "feature-unavailable",
      reservationId: reservation.id,
      sourceKey: reservation.sourceKey,
    };
  if (policy.newRecoveriesPaused || (retry && policy.automatedWhatsappPaused))
    return {
      kind: "held",
      reason: "paused",
      reservationId: reservation.id,
      sourceKey: reservation.sourceKey,
    };
  if (
    source.kind === "paid" &&
    (!("planKind" in policy) ||
      policy.planKind !== "PAID_METERED" ||
      policy.subscriptionStatus === "FROZEN" ||
      policy.billingPeriod?.phase !== "ACTIVE" ||
      policy.billingPeriod.status !== BillingPeriodStatus.OPEN ||
      policy.billingPeriod.id !== (await paidPeriodId(tx, reservation)))
  )
    return {
      kind: "held",
      reason: "paid-period-not-current",
      reservationId: reservation.id,
      sourceKey: reservation.sourceKey,
    };
  if (
    source.kind === "promotional" &&
    !(await promotionalRecoveryReservationService.isReservedSourceEligibleInExistingTransaction(
      tx,
      {
        shopId: input.shopId,
        reservationId: reservation.id,
        sourceKey: reservation.sourceKey,
        now,
      },
    ))
  )
    return {
      kind: "held",
      reason: "source-policy-mismatch",
      reservationId: reservation.id,
      sourceKey: reservation.sourceKey,
    };
  if (source.kind === "purchased") {
    const [counter, lot] = await Promise.all([
      tx.shopEntitlementCounter.findUnique({
        where: { id: reservation.counterId! },
        select: { reservedQuantity: true },
      }),
      tx.recoveryCreditPurchase.findUnique({
        where: { id: reservation.purchasedCreditPurchaseId! },
        select: { status: true, reservedAmount: true },
      }),
    ]);
    if (
      !counter ||
      counter.reservedQuantity < reservation.quantity ||
      !lot ||
      (lot.status !== "ACTIVE" && lot.status !== "WITHDRAWN") ||
      lot.reservedAmount < reservation.quantity
    )
      return {
        kind: "held",
        reason: "source-policy-mismatch",
        reservationId: reservation.id,
        sourceKey: reservation.sourceKey,
      };
  }
  if (source.kind === "free") {
    const counter = await tx.shopEntitlementCounter.findUnique({
      where: { id: reservation.counterId! },
      select: { reservedQuantity: true },
    });
    if (!counter || counter.reservedQuantity < reservation.quantity)
      return {
        kind: "held",
        reason: "source-policy-mismatch",
        reservationId: reservation.id,
        sourceKey: reservation.sourceKey,
      };
  }
  const kind = source.kind === "free" ? "lifetime-free" : source.kind;
  const admission: RecoveryBillingAdmission = {
    kind,
    sourceKey: reservation.sourceKey,
    policy,
  } as RecoveryBillingAdmission;
  return { kind: "admitted", admission, reservationId: reservation.id };
}
