import {
  RecoveryCreditPurchaseStatus, RecoveryCreditRefundStatus,
  UsageReservationCompensationDisposition,
} from "@prisma/client";
import { readCommittedRecoveryUsage, recordCommittedRecoveryCorrection } from "./committed-usage.js";
import { classifyPurchasedCreditState, type PurchasedCreditDisposition } from "./purchased-credit-state.js";
import { requireLineage, type CompensationTransaction, type RecoverySource } from "./types.js";

const LIVE_REFUND = ["REQUESTED", "PROVIDER_ACTION_REQUIRED", "NEEDS_ATTENTION"] as const;
const FROZEN_REFUND_REASON = "ARCH028_DELIVERY_CORRECTION_REQUIRES_REFUND_REVIEW";

/** One serializable, exact-lot purchased correction. Never initiates a provider refund. */
export async function compensatePurchasedSource(
  tx: CompensationTransaction, source: RecoverySource, now: Date,
): Promise<PurchasedCreditDisposition> {
  const { reservation } = source;
  requireLineage(source.kind === "purchased" && !!reservation.counterId &&
    !!reservation.purchasedCreditPurchaseId, "purchased compensation lacks source identity");
  const original = await readCommittedRecoveryUsage(tx, source);
  const [lot, refunds, counter] = await Promise.all([
    tx.recoveryCreditPurchase.findUnique({ where: { id: reservation.purchasedCreditPurchaseId! } }),
    tx.recoveryCreditRefund.findMany({ where: { purchaseId: reservation.purchasedCreditPurchaseId! }, take: 2 }),
    tx.shopEntitlementCounter.findUnique({ where: { id: reservation.counterId! } }),
  ]);
  requireLineage(lot && counter && lot.shopId === reservation.shopId &&
    counter.shopId === reservation.shopId && counter.counter === "PURCHASED_RECOVERY_CREDITS" &&
    lot.provider === original.provider &&
    Number.isSafeInteger(counter.committedQuantity) &&
    counter.committedQuantity >= reservation.quantity &&
    lot.currentAmount + reservation.quantity <= lot.creditsGranted,
    "purchased usage/lot/counter lineage mismatch");
  const disposition = classifyPurchasedCreditState(lot, refunds);
  const refund = refunds[0];
  if (disposition === "held-for-refund") {
    requireLineage(!!refund && LIVE_REFUND.includes(refund.status as typeof LIVE_REFUND[number]) &&
      counter.refundingQuantity >= lot.currentAmount - lot.reservedAmount,
      "purchased refund hold does not cover the current lot");
  }
  if (disposition !== "historical-only") {
    const updated = await tx.recoveryCreditPurchase.updateMany({
      where: { id: lot.id, shopId: reservation.shopId, version: lot.version,
        status: disposition === "held-for-refund"
          ? RecoveryCreditPurchaseStatus.WITHDRAWN
          : { in: [RecoveryCreditPurchaseStatus.ACTIVE, RecoveryCreditPurchaseStatus.COMPLETED] },
        currentAmount: lot.currentAmount, reservedAmount: lot.reservedAmount },
      data: { currentAmount: { increment: reservation.quantity },
        ...(disposition === "restored-spendable" ? { status: RecoveryCreditPurchaseStatus.ACTIVE } : {}),
        version: { increment: 1 } },
    });
    requireLineage(updated.count === 1, "purchased lot correction conflict");
  }
  const corrected = await tx.shopEntitlementCounter.updateMany({
    where: { id: counter.id, shopId: reservation.shopId, version: counter.version,
      committedQuantity: { gte: reservation.quantity },
      ...(disposition === "historical-only"
        ? { grantedQuantity: { gte: reservation.quantity } } : {}) },
    data: { committedQuantity: { decrement: reservation.quantity },
      // Refunded lots have no spendable allocation. Decrease the aggregate
      // grant alongside historical committed usage to prevent phantom credits.
      ...(disposition === "historical-only"
        ? { grantedQuantity: { decrement: reservation.quantity } } : {}),
      ...(disposition === "held-for-refund"
        ? { refundingQuantity: { increment: reservation.quantity } } : {}),
      version: { increment: 1 } },
  });
  requireLineage(corrected.count === 1, "purchased counter correction conflict");
  // A prepared/externally-actionable refund has frozen monetary evidence. Preserve
  // its original provider amount, freeze the workflow and require operator review;
  // restored credits stay in the *same* existing refund hold.
  if (disposition === "held-for-refund" && refund &&
    (refund.status === RecoveryCreditRefundStatus.PROVIDER_ACTION_REQUIRED ||
      (refund.status === RecoveryCreditRefundStatus.REQUESTED &&
        (refund.finalCreditQuantity !== null || refund.automaticCorrectionUsageEventId !== null)))) {
    const attention = await tx.recoveryCreditRefund.updateMany({
      where: { id: refund.id, shopId: reservation.shopId, version: refund.version,
        status: refund.status },
      data: { status: RecoveryCreditRefundStatus.NEEDS_ATTENTION,
        reason: FROZEN_REFUND_REASON, version: { increment: 1 } },
    });
    requireLineage(attention.count === 1, "purchased refund review fence conflict");
  }
  const recorded = {
    "restored-spendable": UsageReservationCompensationDisposition.RESTORED_SPENDABLE,
    "held-for-refund": UsageReservationCompensationDisposition.HELD_FOR_REFUND,
    "historical-only": UsageReservationCompensationDisposition.HISTORICAL_ONLY,
  }[disposition];
  await recordCommittedRecoveryCorrection(tx, source, original, recorded, now);
  return disposition;
}
