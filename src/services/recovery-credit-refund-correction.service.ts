import {
  Prisma,
  RecoveryCreditPurchaseStatus,
  RecoveryCreditRefundStatus,
  ShopifyReportState,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import {
  ARCH007_BILLING_CONTRACT_SCHEMA_VERSION,
  BILLING_SYSTEM_MESSAGE_CODES,
  createMerchantBillingSystemSourceKey,
} from "@modainteract/moda-interact-shared/billing";
import {
  MerchantSupportMessageKind,
  MerchantSupportMessageState,
} from "@prisma/client";

import prisma from "../lib/db.js";
import {
  shopifyPartnerBillingApi,
  type ShopifyPartnerBillingProvider,
} from "../providers/shopify-partner-billing.provider.js";
import {
  RefundPreparationService,
} from "./recovery-credit-refund-correction/refund-preparation.service.js";
import {
  RefundProviderStateService,
} from "./recovery-credit-refund-correction/refund-provider-state.service.js";
import {
  refundSelect,
  type RefundRow,
} from "./recovery-credit-refund-correction/refund-correction.types.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_REASON_LENGTH = 1000;
const LIVE_RECOVERY_CREDIT_REFUND_STATUSES = [
  RecoveryCreditRefundStatus.REQUESTED,
  RecoveryCreditRefundStatus.PROVIDER_ACTION_REQUIRED,
  RecoveryCreditRefundStatus.NEEDS_ATTENTION,
] as const;

type RefundDatabase = PrismaClient;

export type RecoveryCreditRefundCorrectionResult = {
  selected: number;
  prepared: number;
  reconciled: number;
  completed: number;
  providerActionRequired: number;
  needsAttention: number;
};

export class RecoveryCreditRefundCorrectionService {
  private readonly providerState: RefundProviderStateService;
  private readonly preparation: RefundPreparationService;

  constructor(
    private readonly database: RefundDatabase = prisma,
    partner: ShopifyPartnerBillingProvider = shopifyPartnerBillingApi,
    private readonly now: () => Date = () => new Date(),
    private readonly pageSize = DEFAULT_PAGE_SIZE,
  ) {
    this.providerState = new RefundProviderStateService(database, partner);
    this.preparation = new RefundPreparationService(database, this.providerState, now);
  }

  async processDue(): Promise<RecoveryCreditRefundCorrectionResult> {
    const refunds = await this.database.recoveryCreditRefund.findMany({
      where: { status: RecoveryCreditRefundStatus.REQUESTED },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: boundedPageSize(this.pageSize),
      select: refundSelect,
    });
    const result: RecoveryCreditRefundCorrectionResult = {
      selected: refunds.length,
      prepared: 0,
      reconciled: 0,
      completed: 0,
      providerActionRequired: 0,
      needsAttention: 0,
    };
    const visitedMeters = new Set<string>();
    for (const refund of refunds as unknown as RefundRow[]) {
      const meterKey = refundMeterKey(refund);
      if (visitedMeters.has(meterKey)) continue;
      visitedMeters.add(meterKey);
      let outcome: CorrectionOutcome;
      try {
        outcome = refund.automaticCorrectionUsageEventId
          ? await this.reconcile(refund)
          : await this.prepare(refund);
      } catch (error) {
        outcome = refund.automaticCorrectionUsageEventId
          ? "reconciled"
          : "provider-action-required";
        if (outcome === "provider-action-required") {
          await this.preparation.markProviderActionRequired(
            refund,
            error instanceof Error ? error.message : "provider proof unavailable",
          );
        }
      }
      result.prepared += outcome === "prepared" ? 1 : 0;
      result.reconciled += outcome === "reconciled" ? 1 : 0;
      result.completed += outcome === "completed" ? 1 : 0;
      result.providerActionRequired += outcome === "provider-action-required" ? 1 : 0;
      result.needsAttention += outcome === "needs-attention" ? 1 : 0;
    }
    return result;
  }

  private async prepare(refund: RefundRow): Promise<CorrectionOutcome> {
    if (await this.hasEarlierLiveMeterMutation(refund)) return "reconciled";
    const result = await this.preparation.prepare(refund);
    if (result.kind === "prepared") return "prepared";
    if (result.kind === "provider-action-required") return "provider-action-required";
    return result.refund ? this.reconcile(result.refund) : "reconciled";
  }

  private async reconcile(refund: RefundRow): Promise<CorrectionOutcome> {
    const event = refund.automaticCorrectionUsageEvent;
    if (!event || !validCorrectionEvent(refund, event) || !completeEvidence(refund)) {
      await this.markNeedsAttention(refund, "automatic-correction-evidence-incomplete");
      return "needs-attention";
    }
    if (event.shopifyReportState === ShopifyReportState.NEEDS_ATTENTION) {
      await this.markNeedsAttention(refund, "automatic-correction-provider-needs-attention");
      return "needs-attention";
    }
    if (event.shopifyReportState !== ShopifyReportState.REPORTED) return "reconciled";

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
      const completed = await this.complete(refund, proof.cost, proof.currency);
      return completed ? "completed" : "reconciled";
    }
    if (matchesBefore) return "reconciled";
    await this.markNeedsAttention(refund, "automatic-correction-provider-state-conflict");
    return "needs-attention";
  }

  private async hasEarlierLiveMeterMutation(refund: RefundRow): Promise<boolean> {
    const earlierRefund = await this.database.recoveryCreditRefund.findFirst({
      where: {
        shopId: refund.shopId,
        eventHandleSnapshot: refund.eventHandleSnapshot,
        status: { in: [...LIVE_RECOVERY_CREDIT_REFUND_STATUSES] },
        id: { not: refund.id },
        OR: [
          { createdAt: { lt: refund.createdAt } },
          { createdAt: refund.createdAt, id: { lt: refund.id } },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    if (earlierRefund) return true;
    const unresolvedPurchase = await this.database.recoveryCreditPurchase.findFirst({
      where: {
        shopId: refund.shopId,
        status: RecoveryCreditPurchaseStatus.REQUESTED,
        shopifyEventHandleSnapshot: refund.eventHandleSnapshot,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    return Boolean(unresolvedPurchase);
  }

  private async complete(refund: RefundRow, providerCost: Prisma.Decimal, currency: string): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const purchase = await transaction.recoveryCreditPurchase.findUnique({
        where: { id: refund.purchaseId },
        select: { status: true, currentAmount: true, reservedAmount: true, version: true },
      });
      const counter = await transaction.shopEntitlementCounter.findUnique({
        where: { shopId_counter: { shopId: refund.shopId, counter: "PURCHASED_RECOVERY_CREDITS" } },
        select: { id: true, version: true, refundingQuantity: true, grantedQuantity: true },
      });
      if (!purchase || !counter || purchase.status !== RecoveryCreditPurchaseStatus.WITHDRAWN
        || purchase.reservedAmount !== 0 || purchase.currentAmount !== refund.finalCreditQuantity
        || counter.refundingQuantity < refund.finalCreditQuantity) return false;
      const updatedPurchase = await transaction.recoveryCreditPurchase.updateMany({
        where: { id: refund.purchaseId, status: RecoveryCreditPurchaseStatus.WITHDRAWN, version: purchase.version, reservedAmount: 0, currentAmount: refund.finalCreditQuantity },
        data: { currentAmount: 0, status: RecoveryCreditPurchaseStatus.REFUNDED, version: { increment: 1 } },
      });
      const updatedCounter = await transaction.shopEntitlementCounter.updateMany({
        where: { id: counter.id, version: counter.version, refundingQuantity: { gte: refund.finalCreditQuantity }, grantedQuantity: { gte: refund.finalCreditQuantity } },
        data: { refundingQuantity: { decrement: refund.finalCreditQuantity }, grantedQuantity: { decrement: refund.finalCreditQuantity }, version: { increment: 1 } },
      });
      const updatedRefund = await transaction.recoveryCreditRefund.updateMany({
        where: { id: refund.id, status: RecoveryCreditRefundStatus.REQUESTED, version: refund.version, automaticCorrectionUsageEventId: refund.automaticCorrectionUsageEventId },
        data: { providerAmount: refund.expectedProviderAmount, providerCurrency: currency, providerConfirmedAt: this.now(), providerConfirmedByPlatformAdminId: null, providerActionKind: null, status: RecoveryCreditRefundStatus.COMPLETED, completedAt: this.now(), version: { increment: 1 } },
      });
      if (updatedPurchase.count !== 1 || updatedCounter.count !== 1 || updatedRefund.count !== 1) throw new Error("automatic refund completion CAS failed");
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

  private async markNeedsAttention(refund: RefundRow, reason: string): Promise<void> {
    await this.database.recoveryCreditRefund.updateMany({
      where: { id: refund.id, status: RecoveryCreditRefundStatus.REQUESTED, automaticCorrectionUsageEventId: { not: null } },
      data: { status: RecoveryCreditRefundStatus.NEEDS_ATTENTION, reason: boundedReason(reason) },
    });
  }
}

type CorrectionOutcome = "prepared" | "reconciled" | "completed" | "provider-action-required" | "needs-attention";
function refundMeterKey(refund: Pick<RefundRow, "shopId" | "eventHandleSnapshot">): string {
  return JSON.stringify([refund.shopId, refund.eventHandleSnapshot]);
}

function validCorrectionEvent(refund: RefundRow, event: NonNullable<RefundRow["automaticCorrectionUsageEvent"]>): boolean {
  return event.id === refund.automaticCorrectionUsageEventId && event.sourceType === "RECOVERY_CREDIT_REFUND" && event.sourceId === refund.id && event.correctionOfUsageEventId === refund.purchase.usageEventId && event.shopifyEventHandle === refund.eventHandleSnapshot && event.quantity.isFinite() && event.quantity.lt(0) && !event.quantity.isZero() && Boolean(event.shopifyIdempotencyKey);
}

function completeEvidence(refund: RefundRow): boolean {
  return refund.finalCreditQuantity !== null && refund.finalCreditQuantity > 0 && refund.expectedProviderAmount?.isFinite() === true && refund.expectedProviderCurrency !== null && refund.providerUsageQuantityBeforeCorrection?.isFinite() === true && refund.providerUsageCostBeforeCorrection?.isFinite() === true && refund.expectedProviderUsageQuantityAfterCorrection?.isFinite() === true && refund.expectedProviderUsageCostAfterCorrection?.isFinite() === true;
}

function boundedReason(reason: string): string { return reason.slice(0, MAX_REASON_LENGTH); }
function boundedPageSize(value: number): number { return Number.isInteger(value) && value > 0 ? Math.min(value, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE; }
