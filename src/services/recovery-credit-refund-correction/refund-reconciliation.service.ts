import {
  RecoveryCreditRefundStatus,
  ShopifyReportState,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import { RefundCompletionService } from "./refund-completion.service.js";
import type { RefundRow } from "./refund-correction.types.js";
import { RefundProviderStateService } from "./refund-provider-state.service.js";

const MAX_REASON_LENGTH = 1000;

export type RefundReconciliationOutcome =
  | "reconciled"
  | "completed"
  | "needs-attention";

export class RefundReconciliationService {
  constructor(
    private readonly database: PrismaClient,
    private readonly providerState: RefundProviderStateService,
    private readonly completion: RefundCompletionService,
  ) {}

  async reconcile(refund: RefundRow): Promise<RefundReconciliationOutcome> {
    const event = refund.automaticCorrectionUsageEvent;
    if (!event || !validCorrectionEvent(refund, event) || !completeEvidence(refund)) {
      await this.markNeedsAttention(
        refund,
        "automatic-correction-evidence-incomplete",
      );
      return "needs-attention";
    }

    if (event.shopifyReportState === ShopifyReportState.NEEDS_ATTENTION) {
      await this.markNeedsAttention(
        refund,
        "automatic-correction-provider-needs-attention",
      );
      return "needs-attention";
    }

    if (event.shopifyReportState !== ShopifyReportState.REPORTED) {
      return "reconciled";
    }

    const proof = await this.providerState.read(refund);
    if (!proof.safe) {
      await this.markNeedsAttention(refund, proof.reason);
      return "needs-attention";
    }

    const sameCurrency = proof.currency === refund.expectedProviderCurrency;
    const matchesBefore = sameCurrency
      && proof.quantity.equals(refund.providerUsageQuantityBeforeCorrection!)
      && proof.cost.equals(refund.providerUsageCostBeforeCorrection!);
    const matchesExpectedAfter = sameCurrency
      && proof.quantity.equals(refund.expectedProviderUsageQuantityAfterCorrection!)
      && proof.cost.equals(refund.expectedProviderUsageCostAfterCorrection!);

    if (matchesExpectedAfter) {
      const completed = await this.completion.complete(refund, proof.currency);
      return completed ? "completed" : "reconciled";
    }

    if (matchesBefore) return "reconciled";

    await this.markNeedsAttention(
      refund,
      "automatic-correction-provider-state-conflict",
    );
    return "needs-attention";
  }

  private async markNeedsAttention(refund: RefundRow, reason: string): Promise<void> {
    await this.database.recoveryCreditRefund.updateMany({
      where: {
        id: refund.id,
        status: RecoveryCreditRefundStatus.REQUESTED,
        automaticCorrectionUsageEventId: { not: null },
      },
      data: {
        status: RecoveryCreditRefundStatus.NEEDS_ATTENTION,
        reason: boundedReason(reason),
      },
    });
  }
}

function validCorrectionEvent(
  refund: RefundRow,
  event: NonNullable<RefundRow["automaticCorrectionUsageEvent"]>,
): boolean {
  return event.id === refund.automaticCorrectionUsageEventId
    && event.sourceType === "RECOVERY_CREDIT_REFUND"
    && event.sourceId === refund.id
    && event.correctionOfUsageEventId === refund.purchase.usageEventId
    && event.shopifyEventHandle === refund.eventHandleSnapshot
    && event.quantity.isFinite()
    && event.quantity.lt(0)
    && !event.quantity.isZero()
    && Boolean(event.shopifyIdempotencyKey);
}

function completeEvidence(refund: RefundRow): boolean {
  return refund.finalCreditQuantity !== null
    && refund.finalCreditQuantity > 0
    && refund.expectedProviderAmount?.isFinite() === true
    && refund.expectedProviderCurrency !== null
    && refund.providerUsageQuantityBeforeCorrection?.isFinite() === true
    && refund.providerUsageCostBeforeCorrection?.isFinite() === true
    && refund.expectedProviderUsageQuantityAfterCorrection?.isFinite() === true
    && refund.expectedProviderUsageCostAfterCorrection?.isFinite() === true;
}

function boundedReason(reason: string): string {
  return reason.slice(0, MAX_REASON_LENGTH);
}
