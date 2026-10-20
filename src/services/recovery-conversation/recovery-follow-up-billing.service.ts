import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { freeRecoveryReservationService } from "../free-recovery-reservation.service.js";
import { purchasedRecoveryReservationService } from "../purchased-recovery-reservation.service.js";
import { paidIncludedRecoveryReservationService } from "../paid-included-recovery-reservation.service.js";
import { promotionalRecoveryReservationService } from "../promotional-recovery-reservation.service.js";
import {
  recoveryBillingService,
  type RecoveryBillingService,
  type RecoveryBillingAdmission,
  type RecoveryBillingAdmissionResult,
} from "../recovery-billing.service.js";
import { rows, type SqlTransaction } from "./recovery-conversation.sql.js";

export type PersistedFollowUpReservation = {
  kind: "persisted";
  shopId: string;
  sourceKey: string;
  capacity: "free" | "purchased" | "paid" | "promotional";
  quantity: number;
};
export type FollowUpCreditState =
  | { kind: "clear" }
  | { kind: "reserved"; admission: PersistedFollowUpReservation }
  | { kind: "unsafe" };

/** Read the actual durable credit source; a paid included reservation's source
 * key is period-qualified and cannot be found by the unqualified billing key.
 * Never reconstruct an admission from today's billing policy after a crash.
 */
export async function inspectFollowUpCredit(
  tx: SqlTransaction, input: { shopId: string; attemptId: string },
): Promise<FollowUpCreditState> {
  const logicalSource = createRecoveryIdempotencyKey(input.shopId, `recovery-outreach:${input.attemptId}`);
  const reservations = await rows<{
    id: string; sourceKey: string; status: string; quantity: number;
    counterId: string | null; counterKind: string | null;
    billingPeriodEntitlementCounterId: string | null; periodCounterKind: string | null;
    purchasedCreditPurchaseId: string | null; promotionalCreditGrantId: string | null;
    committedUsageEventId: string | null; compensationUsageEventId: string | null;
  }>(tx, `
    SELECT r."id",r."sourceKey",r."status"::text,r."quantity",
      r."counterId",ec."counter"::text AS "counterKind",
      r."billingPeriodEntitlementCounterId",pc."counter"::text AS "periodCounterKind",
      r."purchasedCreditPurchaseId",
      r."promotionalCreditGrantId",r."committedUsageEventId",r."compensationUsageEventId"
    FROM "billing"."UsageReservation" r
    LEFT JOIN "billing"."ShopEntitlementCounter" ec ON ec."id"=r."counterId"
    LEFT JOIN "billing"."BillingPeriodEntitlementCounter" pc
      ON pc."id"=r."billingPeriodEntitlementCounterId" AND pc."shopId"=r."shopId"
    WHERE r."shopId"=$1 AND (
      r."sourceKey"=$2 OR
      (pc."id" IS NOT NULL AND r."sourceKey"=('paid-included:' || pc."billingPeriodId" || ':' || $2))
    )
    LIMIT 2`, input.shopId, logicalSource);
  if (reservations.length > 1) return { kind: "unsafe" };
  const reservation = reservations[0];
  const sourceKey = reservation?.sourceKey ?? logicalSource;
  // Check both the persisted source's idempotent usage key and historical
  // usage sources. A settled event must not become a free follow-up claim.
  const usage = await rows<{ id: string }>(tx, `
    SELECT "id" FROM "billing"."UsageEvent"
    WHERE "shopId"=$1 AND (
      "idempotencyKey"=$2 OR "idempotencyKey"=$3
      OR "sourceId"=$4
      OR ("sourceId" LIKE 'paid-included:%' AND
          RIGHT("sourceId",LENGTH($4)+1)=(':' || $4))
    ) LIMIT 1`, input.shopId,
    createRecoveryIdempotencyKey(input.shopId, sourceKey),
    createRecoveryIdempotencyKey(input.shopId, logicalSource), logicalSource);
  if (usage.length || reservation?.committedUsageEventId || reservation?.compensationUsageEventId)
    return { kind: "unsafe" };
  if (!reservation) return { kind: "clear" };
  const capacityColumns = [reservation.counterId, reservation.billingPeriodEntitlementCounterId,
    reservation.purchasedCreditPurchaseId, reservation.promotionalCreditGrantId].filter(Boolean);
  if (capacityColumns.length !== 1 || reservation.quantity !== 1) return { kind: "unsafe" };
  if (reservation.status === "RELEASED") return { kind: "clear" };
  if (reservation.status !== "RESERVED") return { kind: "unsafe" };
  const capacity = reservation.counterId
    ? reservation.counterKind === "LIFETIME_FREE_RECOVERY_CREDITS" ? "free" : null
    : reservation.billingPeriodEntitlementCounterId &&
        reservation.periodCounterKind === "INCLUDED_RECOVERY_CREDITS" ? "paid"
    : reservation.purchasedCreditPurchaseId ? "purchased"
    : reservation.promotionalCreditGrantId ? "promotional" : null;
  if (!capacity) return { kind: "unsafe" };
  return { kind: "reserved", admission: {
    kind: "persisted", shopId: input.shopId,
    sourceKey: reservation.sourceKey, capacity, quantity: reservation.quantity,
  } };
}

async function releasePersistedBeforePermit(input: PersistedFollowUpReservation): Promise<void> {
  const values = { shopId: input.shopId, sourceKey: input.sourceKey, quantity: input.quantity };
  const result = input.capacity === "free"
    ? await freeRecoveryReservationService.release(values)
    : input.capacity === "purchased"
      ? await purchasedRecoveryReservationService.release(values)
      : input.capacity === "paid"
        ? await paidIncludedRecoveryReservationService.release(values)
        : await promotionalRecoveryReservationService.release(values);
  if (result.kind !== "released" && result.kind !== "already-released") {
    throw new Error("Provisional follow-up reservation was not released");
  }
}

/** Thin bridge, not a second credit ledger. The shared sequence-two attempt ID
 * remains the credit identity across cancellation and reclaim.
 */
export class RecoveryFollowUpBillingService {
  constructor(private readonly billing: Pick<RecoveryBillingService,
    "admit" | "revalidateBeforeProvider" | "commitSuccessfulInitiation" |
    "handleProviderFailure" | "releaseBeforeProvider"> = recoveryBillingService,
    private readonly persistedRelease: (input: PersistedFollowUpReservation) => Promise<void> =
      releasePersistedBeforePermit,
  ) {}

  async admitAndRevalidate(input: {
    shopId: string; recoveryId: string; sequenceTwoAttemptId: string;
  }): Promise<RecoveryBillingAdmissionResult> {
    const admitted = await this.billing.admit({shopId: input.shopId,
      recoveryId: input.recoveryId, outreachAttemptId: input.sequenceTwoAttemptId});
    if (admitted.kind !== "admitted") return admitted;
    return this.billing.revalidateBeforeProvider({admission: admitted.admission,
      recoveryId: input.recoveryId, outreachAttemptId: input.sequenceTwoAttemptId});
  }

  async onConfirmedProviderSend(input: {admission: RecoveryBillingAdmission; recoveryId: string; occurredAt: Date}) {
    await this.billing.commitSuccessfulInitiation(input);
  }

  async onDefinitiveProviderFailure(input: {admission: RecoveryBillingAdmission; error: unknown}) {
    return this.billing.handleProviderFailure(input);
  }

  inspectBeforePermit(tx: SqlTransaction, input: { shopId: string; attemptId: string }) {
    return inspectFollowUpCredit(tx, input);
  }

  releaseBeforePermit(admission: RecoveryBillingAdmission | PersistedFollowUpReservation) {
    return admission.kind === "persisted"
      ? this.persistedRelease(admission)
      : this.billing.releaseBeforeProvider(admission);
  }
}
