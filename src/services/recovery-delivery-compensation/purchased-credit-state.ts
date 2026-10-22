import {
  RecoveryCreditPurchaseStatus as PurchaseStatus,
  RecoveryCreditRefundStatus as RefundStatus,
  type RecoveryCreditPurchase, type RecoveryCreditRefund,
} from "@prisma/client";
import { requireLineage } from "./types.js";

export type PurchasedCreditDisposition = "restored-spendable" | "held-for-refund" | "historical-only";

/** Provider refund lifecycle is authoritative; do not infer it from a zero balance. */
export function classifyPurchasedCreditState(
  lot: RecoveryCreditPurchase,
  refunds: RecoveryCreditRefund[],
): PurchasedCreditDisposition {
  requireLineage(refunds.length <= 1, "purchased lot has ambiguous refund history");
  const refund = refunds[0];
  requireLineage(!refund || (refund.shopId === lot.shopId && refund.purchaseId === lot.id &&
    refund.provider === lot.provider), "purchased lot/refund owner mismatch");
  requireLineage(Number.isSafeInteger(lot.creditsGranted) && lot.creditsGranted > 0 &&
    Number.isSafeInteger(lot.currentAmount) && lot.currentAmount >= 0 &&
    Number.isSafeInteger(lot.reservedAmount) && lot.reservedAmount >= 0 &&
    lot.currentAmount >= lot.reservedAmount && lot.currentAmount <= lot.creditsGranted,
    "purchased lot has incoherent quantities");
  if (lot.status === PurchaseStatus.REFUNDED) {
    requireLineage(refund?.status === RefundStatus.COMPLETED &&
      refund.completedAt !== null && refund.providerConfirmedAt !== null &&
      refund.finalCreditQuantity !== null && refund.finalCreditQuantity > 0 &&
      lot.currentAmount === 0 && lot.reservedAmount === 0,
      "provider-refunded purchase has no terminal refund evidence");
    return "historical-only";
  }
  if (lot.status === PurchaseStatus.WITHDRAWN) {
    requireLineage(refund && (refund.status === RefundStatus.REQUESTED ||
      refund.status === RefundStatus.PROVIDER_ACTION_REQUIRED ||
      refund.status === RefundStatus.NEEDS_ATTENTION),
    "withdrawn purchased lot has no live refund hold");
    return "held-for-refund";
  }
  requireLineage((lot.status === PurchaseStatus.ACTIVE && lot.currentAmount > 0 ||
    lot.status === PurchaseStatus.COMPLETED && lot.currentAmount === 0 && lot.reservedAmount === 0) &&
    (!refund || refund.status === RefundStatus.REJECTED || refund.status === RefundStatus.CANCELLED),
    "purchased lot has incompatible refund state");
  return "restored-spendable";
}
