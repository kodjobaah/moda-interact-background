import {
  Prisma,
  RecoveryCreditPurchaseStatus,
  RecoveryCreditRefundStatus,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import type { RefundRow } from "./refund-correction.types.js";

const WOO_ACTION_REASON = "WOO_VENDOR_DASHBOARD_REFUND_REQUIRED";
const NO_CREDITS_REASON = "NO_CREDITS_REMAINING";

export type WooRefundHoldOutcome = "waiting" | "prepared" | "cancelled" | "needs-attention";

export class WooRefundHoldPreparationService {
  constructor(
    private readonly database: PrismaClient,
  ) {}

  async prepare(refund: RefundRow): Promise<WooRefundHoldOutcome> {
    if (refund.provider !== "WOOCOMMERCE" || refund.status !== RecoveryCreditRefundStatus.REQUESTED) {
      return "waiting";
    }
    return this.withSerializationRetry(() => this.database.$transaction(async (transaction) => {
      const current = await transaction.recoveryCreditRefund.findUnique({
        where: { id: refund.id },
        select: {
          status: true,
          provider: true,
          version: true,
          availableAmountAtRequestSnapshot: true,
          finalCreditQuantity: true,
          automaticCorrectionUsageEventId: true,
          purchase: {
            select: { status: true, currentAmount: true, reservedAmount: true, version: true },
          },
        },
      });
      if (!current || current.provider !== "WOOCOMMERCE"
        || current.status !== RecoveryCreditRefundStatus.REQUESTED
        || current.automaticCorrectionUsageEventId !== null
        || current.purchase.status !== RecoveryCreditPurchaseStatus.WITHDRAWN) {
        return "waiting";
      }
      if (current.purchase.reservedAmount > 0) return "waiting";

      const counter = await transaction.shopEntitlementCounter.findUnique({
        where: {
          shopId_counter: {
            shopId: refund.shopId,
            counter: "PURCHASED_RECOVERY_CREDITS",
          },
        },
        select: { id: true, version: true, refundingQuantity: true, grantedQuantity: true },
      });
      if (!counter || !validNonnegativeInteger(current.purchase.currentAmount)
        || !validNonnegativeInteger(current.availableAmountAtRequestSnapshot)
        || !validNonnegativeInteger(counter.refundingQuantity)) {
        return markAttention(transaction, refund.id, current.version, "WOO_REFUND_HOLD_STATE_INVALID");
      }

      if (current.purchase.currentAmount === 0) {
        const held = current.availableAmountAtRequestSnapshot;
        if (counter.refundingQuantity < held) {
          return markAttention(transaction, refund.id, current.version, "WOO_REFUND_HOLD_STATE_INVALID");
        }
        const counterUpdate = await transaction.shopEntitlementCounter.updateMany({
          where: { id: counter.id, version: counter.version, refundingQuantity: { gte: held } },
          data: { refundingQuantity: { decrement: held }, version: { increment: 1 } },
        });
        const refundUpdate = await transaction.recoveryCreditRefund.updateMany({
          where: { id: refund.id, status: RecoveryCreditRefundStatus.REQUESTED, version: current.version },
          data: { status: RecoveryCreditRefundStatus.CANCELLED, reason: NO_CREDITS_REASON, version: { increment: 1 } },
        });
        if (counterUpdate.count !== 1 || refundUpdate.count !== 1) {
          throw new Error("Woo refund no-credits cancellation compare-and-set failed");
        }
        return "cancelled";
      }

      const finalCreditQuantity = current.purchase.currentAmount;
      if (finalCreditQuantity < current.availableAmountAtRequestSnapshot) {
        return markAttention(transaction, refund.id, current.version, "WOO_REFUND_HOLD_STATE_INVALID");
      }
      const activeHolds = await transaction.recoveryCreditRefund.findMany({
        where: {
          shopId: refund.shopId,
          status: { in: [
            RecoveryCreditRefundStatus.REQUESTED,
            RecoveryCreditRefundStatus.PROVIDER_ACTION_REQUIRED,
            RecoveryCreditRefundStatus.NEEDS_ATTENTION,
          ] },
        },
        select: {
          purchaseId: true,
          purchase: { select: { status: true, currentAmount: true, reservedAmount: true } },
        },
      });
      const purchaseHolds = new Map<string, number>();
      for (const hold of activeHolds) {
        if (hold.purchase.status !== RecoveryCreditPurchaseStatus.WITHDRAWN) continue;
        if (purchaseHolds.has(hold.purchaseId)) {
          return markAttention(transaction, refund.id, current.version, "WOO_REFUND_HOLD_STATE_INVALID");
        }
        purchaseHolds.set(hold.purchaseId, hold.purchase.currentAmount - hold.purchase.reservedAmount);
      }
      const expectedAggregateHold = [...purchaseHolds.values()].reduce((sum, held) => sum + held, 0);
      const additionalHold = expectedAggregateHold - counter.refundingQuantity;
      if (additionalHold < 0) {
        return markAttention(transaction, refund.id, current.version, "WOO_REFUND_HOLD_STATE_INVALID");
      }
      const purchaseUpdate = await transaction.recoveryCreditPurchase.updateMany({
        where: {
          id: refund.purchaseId,
          status: RecoveryCreditPurchaseStatus.WITHDRAWN,
          version: current.purchase.version,
          reservedAmount: 0,
          currentAmount: finalCreditQuantity,
        },
        data: { version: { increment: 1 } },
      });
      const counterUpdate = await transaction.shopEntitlementCounter.updateMany({
        where: { id: counter.id, version: counter.version },
        data: {
          ...(additionalHold > 0 ? { refundingQuantity: { increment: additionalHold } } : {}),
          version: { increment: 1 },
        },
      });
      const refundUpdate = await transaction.recoveryCreditRefund.updateMany({
        where: {
          id: refund.id,
          provider: "WOOCOMMERCE",
          status: RecoveryCreditRefundStatus.REQUESTED,
          version: current.version,
          automaticCorrectionUsageEventId: null,
        },
        data: {
          finalCreditQuantity,
          expectedProviderAmount: null,
          expectedProviderCurrency: null,
          status: RecoveryCreditRefundStatus.PROVIDER_ACTION_REQUIRED,
          reason: WOO_ACTION_REASON,
          version: { increment: 1 },
        },
      });
      if (purchaseUpdate.count !== 1 || counterUpdate.count !== 1 || refundUpdate.count !== 1) {
        throw new Error("Woo refund hold preparation compare-and-set failed");
      }
      return "prepared";
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  private async withSerializationRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError)
          || error.code !== "P2034" || attempt === 2) {
          throw error;
        }
      }
    }
    throw new Error("Woo refund hold transaction retry limit exceeded");
  }
}

async function markAttention(
  transaction: Prisma.TransactionClient,
  refundId: string,
  version: number,
  reason: string,
): Promise<"needs-attention"> {
  await transaction.recoveryCreditRefund.updateMany({
    where: { id: refundId, status: RecoveryCreditRefundStatus.REQUESTED, version },
    data: { status: RecoveryCreditRefundStatus.NEEDS_ATTENTION, reason, version: { increment: 1 } },
  });
  return "needs-attention";
}

function validNonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}