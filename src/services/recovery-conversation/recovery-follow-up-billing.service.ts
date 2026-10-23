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

type ReservationSourceRow = {
  id: string; shopId: string; sourceKey: string; status: string; quantity: number;
  counterId: string | null; counterKind: string | null; counterShopId: string | null;
  billingPeriodEntitlementCounterId: string | null; periodCounterKind: string | null;
  periodCounterShopId: string | null; billingPeriodId: string | null;
  purchasedCreditPurchaseId: string | null; purchaseShopId: string | null;
  promotionalCreditGrantId: string | null; promotionalShopId: string | null;
  committedUsageEventId: string | null; compensationUsageEventId: string | null;
  expired: boolean;
};

/** The purchased source legitimately has two FKs: its Shop aggregate and exact
 * purchase lot. All other capacities have one source FK, never a purchase lot.
 * Use the persisted source/tenant, not the merchant's current plan, to decide.
 */
function classifySource(
  reservation: ReservationSourceRow, shopId: string, logicalSource: string,
): PersistedFollowUpReservation["capacity"] | null {
  if (reservation.shopId !== shopId || reservation.quantity !== 1) return null;
  const noPeriod = !reservation.billingPeriodEntitlementCounterId;
  const noPromotion = !reservation.promotionalCreditGrantId;
  const noCounter = !reservation.counterId;
  const noPurchase = !reservation.purchasedCreditPurchaseId;
  const exactSource = reservation.sourceKey === logicalSource;

  if (reservation.counterId && noPeriod && noPromotion && exactSource &&
      reservation.counterShopId === shopId) {
    if (noPurchase && reservation.counterKind === "LIFETIME_FREE_RECOVERY_CREDITS")
      return "free";
    if (reservation.purchasedCreditPurchaseId &&
        reservation.counterKind === "PURCHASED_RECOVERY_CREDITS" &&
        reservation.purchaseShopId === shopId)
      return "purchased";
  }
  if (noCounter && noPurchase && noPromotion &&
      reservation.billingPeriodEntitlementCounterId &&
      reservation.periodCounterKind === "INCLUDED_RECOVERY_CREDITS" &&
      reservation.periodCounterShopId === shopId && reservation.billingPeriodId &&
      reservation.sourceKey === `paid-included:${reservation.billingPeriodId}:${logicalSource}`)
    return "paid";
  if (noCounter && noPurchase && noPeriod && exactSource &&
      reservation.promotionalCreditGrantId && reservation.promotionalShopId === shopId)
    return "promotional";
  return null;
}

/** Read the actual durable credit source; a paid included reservation's source
 * key is period-qualified and cannot be found by the unqualified billing key.
 * Never reconstruct an admission from today's billing policy after a crash.
 */
export async function inspectFollowUpCredit(
  tx: SqlTransaction, input: { shopId: string; attemptId: string },
): Promise<FollowUpCreditState> {
  const logicalSource = createRecoveryIdempotencyKey(input.shopId, `recovery-outreach:${input.attemptId}`);
  const reservations = await rows<ReservationSourceRow>(tx, `
    SELECT r."id",r."shopId",r."sourceKey",r."status"::text,r."quantity",
      r."counterId",ec."counter"::text AS "counterKind",ec."shopId" AS "counterShopId",
      r."billingPeriodEntitlementCounterId",pc."counter"::text AS "periodCounterKind",
      pc."shopId" AS "periodCounterShopId",pc."billingPeriodId",
      r."purchasedCreditPurchaseId",purchase."shopId" AS "purchaseShopId",
      r."promotionalCreditGrantId",promo."shopId" AS "promotionalShopId",
      r."committedUsageEventId",r."compensationUsageEventId",
      (r."expiresAt" IS NOT NULL AND r."expiresAt"<=statement_timestamp()) AS "expired"
    FROM "billing"."UsageReservation" r
    LEFT JOIN "billing"."ShopEntitlementCounter" ec ON ec."id"=r."counterId"
    LEFT JOIN "billing"."BillingPeriodEntitlementCounter" pc
      ON pc."id"=r."billingPeriodEntitlementCounterId"
    LEFT JOIN "billing"."RecoveryCreditPurchase" purchase
      ON purchase."id"=r."purchasedCreditPurchaseId"
    LEFT JOIN "billing"."PromotionalCreditGrant" promo
      ON promo."id"=r."promotionalCreditGrantId"
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
      OR "sourceId"=$4 OR "sourceId"=$5
      OR ("sourceId" LIKE 'paid-included:%' AND
          RIGHT("sourceId",LENGTH($4)+1)=(':' || $4))
    ) LIMIT 1`, input.shopId,
    createRecoveryIdempotencyKey(input.shopId, sourceKey),
    createRecoveryIdempotencyKey(input.shopId, logicalSource), logicalSource,
    reservation?.id ?? "");
  if (usage.length || reservation?.committedUsageEventId || reservation?.compensationUsageEventId)
    return { kind: "unsafe" };
  if (!reservation) return { kind: "clear" };
  // Validate the shape even for RELEASED: a foreign-Shop lot or an orphaned
  // purchased FK is not proof that a follow-up's credit was durably released.
  const capacity = classifySource(reservation, input.shopId, logicalSource);
  if (!capacity) return { kind: "unsafe" };
  if (reservation.status === "RELEASED") return { kind: "clear" };
  if (reservation.status !== "RESERVED" || reservation.expired) return { kind: "unsafe" };
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
