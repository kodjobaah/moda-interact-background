import {
  MerchantSupportMessageKind,
  MerchantSupportMessageState,
  RecoveryCreditPurchaseStatus,
  RecoveryCreditRefundStatus,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import {
  ARCH007_BILLING_CONTRACT_SCHEMA_VERSION,
  BILLING_SYSTEM_MESSAGE_CODES,
  createMerchantBillingSystemSourceKey,
} from "@modainteract/moda-interact-shared/billing";

import type { RefundRow } from "./refund-correction.types.js";

export class RefundCompletionService {
  constructor(
    private readonly database: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async complete(refund: RefundRow, currency: string): Promise<boolean> {
    const finalCreditQuantity = refund.finalCreditQuantity;
    if (
      finalCreditQuantity === null
      || finalCreditQuantity <= 0
      || refund.expectedProviderAmount === null
      || refund.automaticCorrectionUsageEventId === null
    ) {
      return false;
    }

    return this.database.$transaction(async (transaction) => {
      const purchase = await transaction.recoveryCreditPurchase.findUnique({
        where: { id: refund.purchaseId },
        select: {
          status: true,
          currentAmount: true,
          reservedAmount: true,
          version: true,
        },
      });
      const counter = await transaction.shopEntitlementCounter.findUnique({
        where: {
          shopId_counter: {
            shopId: refund.shopId,
            counter: "PURCHASED_RECOVERY_CREDITS",
          },
        },
        select: {
          id: true,
          version: true,
          refundingQuantity: true,
          grantedQuantity: true,
        },
      });
      if (
        !purchase
        || !counter
        || purchase.status !== RecoveryCreditPurchaseStatus.WITHDRAWN
        || purchase.reservedAmount !== 0
        || purchase.currentAmount !== finalCreditQuantity
        || counter.refundingQuantity < finalCreditQuantity
      ) {
        return false;
      }

      const updatedPurchase = await transaction.recoveryCreditPurchase.updateMany({
        where: {
          id: refund.purchaseId,
          status: RecoveryCreditPurchaseStatus.WITHDRAWN,
          version: purchase.version,
          reservedAmount: 0,
          currentAmount: finalCreditQuantity,
        },
        data: {
          currentAmount: 0,
          status: RecoveryCreditPurchaseStatus.REFUNDED,
          version: { increment: 1 },
        },
      });
      const updatedCounter = await transaction.shopEntitlementCounter.updateMany({
        where: {
          id: counter.id,
          version: counter.version,
          refundingQuantity: { gte: finalCreditQuantity },
          grantedQuantity: { gte: finalCreditQuantity },
        },
        data: {
          refundingQuantity: { decrement: finalCreditQuantity },
          grantedQuantity: { decrement: finalCreditQuantity },
          version: { increment: 1 },
        },
      });
      const updatedRefund = await transaction.recoveryCreditRefund.updateMany({
        where: {
          id: refund.id,
          status: RecoveryCreditRefundStatus.REQUESTED,
          version: refund.version,
          automaticCorrectionUsageEventId: refund.automaticCorrectionUsageEventId,
        },
        data: {
          providerAmount: refund.expectedProviderAmount,
          providerCurrency: currency,
          providerConfirmedAt: this.now(),
          providerConfirmedByPlatformAdminId: null,
          providerActionKind: null,
          status: RecoveryCreditRefundStatus.COMPLETED,
          completedAt: this.now(),
          version: { increment: 1 },
        },
      });
      if (
        updatedPurchase.count !== 1
        || updatedCounter.count !== 1
        || updatedRefund.count !== 1
      ) {
        throw new Error("automatic refund completion CAS failed");
      }

      const completionTime = this.now();
      const systemCode = BILLING_SYSTEM_MESSAGE_CODES.REFUND_COMPLETED;
      const sourceKey = createMerchantBillingSystemSourceKey(
        refund.shopId,
        systemCode,
        refund.id,
        ARCH007_BILLING_CONTRACT_SCHEMA_VERSION,
      );
      const thread = await transaction.merchantSupportThread.upsert({
        where: { shopId: refund.shopId },
        create: { shopId: refund.shopId },
        update: {},
      });
      await transaction.merchantSupportMessage.upsert({
        where: { sourceKey },
        create: {
          threadId: thread.id,
          kind: MerchantSupportMessageKind.SYSTEM,
          state: MerchantSupportMessageState.AVAILABLE,
          originalBody: "Your recovery-credit refund has completed. The refundable purchased credits have been removed and Shopify provider reconciliation is complete.",
          sourceLanguageTag: "en-GB",
          systemCode,
          systemVersion: String(ARCH007_BILLING_CONTRACT_SCHEMA_VERSION),
          sourceKey,
          availableAt: completionTime,
        },
        update: {},
      });
      await transaction.merchantSupportThread.update({
        where: { id: thread.id },
        data: { lastMessageAt: completionTime },
      });
      return true;
    });
  }
}
