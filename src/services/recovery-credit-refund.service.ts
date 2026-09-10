import {
  ARCH007_BILLING_CONTRACT_SCHEMA_VERSION,
  BILLING_SYSTEM_MESSAGE_CODES,
  availablePurchasedRecoveryCredits,
  createMerchantBillingSystemSourceKey,
  createShopifyUsageIdempotencyKey,
} from "@modainteract/moda-interact-shared/billing";
import {
  MerchantSupportMessageKind,
  MerchantSupportMessageState,
  Prisma,
  RecoveryCreditRefundSettlementMode,
  RecoveryCreditRefundStatus,
  RecoveryCreditPurchaseStatus,
  ShopifyReportState,
  UsageMetric,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import prisma from "../lib/db.js";

const DEFAULT_BATCH_SIZE = 25;
const LEASE_MS = 10 * 60_000;
const MAX_SUMMARY_LENGTH = 2000;

type RefundDatabase = PrismaClient;
type RefundTransaction = Prisma.TransactionClient;

export type RefundRunResult = {
  scanned: number;
  held: number;
  pending: number;
  actionRequired: number;
  attention: number;
  completed: number;
};

type RefundWithRelations = Prisma.RecoveryCreditRefundGetPayload<{
  include: {
    purchase: { include: { usageEvent: true } };
  };
}>;

export class RecoveryCreditRefundService {
  constructor(
    private readonly database: RefundDatabase = prisma,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async processDue(limit = DEFAULT_BATCH_SIZE): Promise<RefundRunResult> {
    const now = this.now();
    await this.recoverStale(now);
    const refunds = await this.database.recoveryCreditRefund.findMany({
      where: {
        OR: [
          { status: RecoveryCreditRefundStatus.APPROVED },
          { status: RecoveryCreditRefundStatus.PROCESSING },
          { status: RecoveryCreditRefundStatus.PROVIDER_PENDING },
          { status: RecoveryCreditRefundStatus.PROVIDER_CONFIRMED },
          { status: RecoveryCreditRefundStatus.REJECTED, holdAppliedAt: { not: null }, providerConfirmedAt: null, correctionUsageEventId: null },
          { status: RecoveryCreditRefundStatus.WITHDRAWN, holdAppliedAt: { not: null }, providerConfirmedAt: null, correctionUsageEventId: null },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: boundedLimit(limit),
      include: { purchase: { include: { usageEvent: true } } },
    });
    const result: RefundRunResult = {
      scanned: refunds.length,
      held: 0,
      pending: 0,
      actionRequired: 0,
      attention: 0,
      completed: 0,
    };
    for (const refund of refunds) {
      if (refund.status === RecoveryCreditRefundStatus.PROVIDER_CONFIRMED) {
        if (await this.finalize(refund.id, now)) result.completed += 1;
        continue;
      }
      if (refund.status === RecoveryCreditRefundStatus.REJECTED || refund.status === RecoveryCreditRefundStatus.WITHDRAWN) {
        if (await this.releaseTerminalHold(refund.id)) result.held += 1;
        continue;
      }
      if (refund.status === RecoveryCreditRefundStatus.APPROVED) {
        const held = await this.applyHold(refund.id, now);
        if (!held) {
          await this.markNeedsAttention(refund.id, now);
          result.attention += 1;
          continue;
        }
        result.held += 1;
      }
      const outcome = await this.advance(refund.id, now);
      if (outcome !== "none") result[outcome] += 1;
    }
    return result;
  }

  private async releaseTerminalHold(refundId: string): Promise<boolean> {
    return this.withConflictRetry(() => this.database.$transaction(async (transaction) => {
      const refund = await transaction.recoveryCreditRefund.findUnique({
        where: { id: refundId },
      });
      if (!refund || refund.providerConfirmedAt || refund.correctionUsageEventId) return false;
      if (!refund.holdAppliedAt || (refund.status !== RecoveryCreditRefundStatus.REJECTED && refund.status !== RecoveryCreditRefundStatus.WITHDRAWN)) return false;
      const counter = await transaction.shopEntitlementCounter.findUnique({
        where: { shopId_counter: { shopId: refund.shopId, counter: "PURCHASED_RECOVERY_CREDITS" } },
      });
      if (!counter) return false;
      const updatedCounter = await transaction.shopEntitlementCounter.updateMany({
        where: { id: counter.id, version: counter.version, refundingQuantity: { gte: refund.creditsSnapshot } },
        data: { refundingQuantity: { decrement: refund.creditsSnapshot }, version: { increment: 1 } },
      });
      if (updatedCounter.count !== 1) return false;
      const updatedRefund = await transaction.recoveryCreditRefund.updateMany({
        where: { id: refund.id, version: refund.version, status: refund.status },
        data: { holdAppliedAt: null, processingStartedAt: null, nextAttemptAt: null, version: { increment: 1 } },
      });
      if (updatedRefund.count !== 1) throw new RefundConcurrencyConflict();
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  private async applyHold(refundId: string, now: Date): Promise<boolean> {
    try {
      return await this.database.$transaction(async (transaction) => {
        const refund = await transaction.recoveryCreditRefund.findUnique({
          where: { id: refundId },
          include: { purchase: { include: { usageEvent: true } } },
        });
        if (!refund || refund.status !== RecoveryCreditRefundStatus.APPROVED) return false;
        const purchase = refund.purchase;
        const original = purchase.usageEvent;
        if (
          refund.shopId !== purchase.shopId ||
          refund.originalUsageEventIdSnapshot !== original.id ||
          refund.billingPeriodIdSnapshot !== original.billingPeriodId ||
          refund.planHandleSnapshot !== purchase.shopifyPlanHandleSnapshot ||
          refund.eventHandleSnapshot !== purchase.shopifyEventHandleSnapshot ||
          purchase.status !== RecoveryCreditPurchaseStatus.ACTIVE ||
          original.shopId !== refund.shopId ||
          original.shopifyEventHandle !== refund.eventHandleSnapshot ||
          original.metric !== UsageMetric.RECOVERY_CREDIT_PACK_PURCHASE ||
          Number(original.quantity) !== 1 ||
          refund.creditsSnapshot !== purchase.creditsGranted ||
          !Number.isSafeInteger(refund.creditsSnapshot) ||
          refund.creditsSnapshot <= 0
        ) return false;

        const counter = await transaction.shopEntitlementCounter.findUnique({
          where: { shopId_counter: { shopId: refund.shopId, counter: "PURCHASED_RECOVERY_CREDITS" } },
        });
        if (!counter || availablePurchasedRecoveryCredits({
          grantedQuantity: counter.grantedQuantity,
          committedQuantity: counter.committedQuantity,
          reservedQuantity: counter.reservedQuantity,
          refundingQuantity: counter.refundingQuantity,
        }) < refund.creditsSnapshot) return false;
        const updatedCounter = await transaction.shopEntitlementCounter.updateMany({
          where: { id: counter.id, version: counter.version },
          data: { refundingQuantity: { increment: refund.creditsSnapshot }, version: { increment: 1 } },
        });
        if (updatedCounter.count !== 1) return false;
        const updatedRefund = await transaction.recoveryCreditRefund.updateMany({
          where: { id: refund.id, version: refund.version, status: RecoveryCreditRefundStatus.APPROVED },
          data: { status: RecoveryCreditRefundStatus.PROCESSING, holdAppliedAt: now, processingStartedAt: now, lastAttemptAt: now, attemptCount: { increment: 1 }, version: { increment: 1 } },
        });
        if (updatedRefund.count !== 1) throw new Error("Refund changed while applying hold");
        return true;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isConflict(error)) return false;
      throw error;
    }
  }

  private async advance(refundId: string, now: Date): Promise<"pending" | "actionRequired" | "attention" | "none"> {
    return this.withConflictRetry(() => this.database.$transaction(async (transaction) => {
      const refund = await transaction.recoveryCreditRefund.findUnique({
        where: { id: refundId },
        include: { purchase: { include: { usageEvent: true } } },
      });
      if (!refund || !refund.holdAppliedAt) return "none";
      if (
        refund.status !== RecoveryCreditRefundStatus.PROCESSING &&
        refund.status !== RecoveryCreditRefundStatus.PROVIDER_PENDING
      ) return "none";
      if (refund.settlementMode === RecoveryCreditRefundSettlementMode.PARTNER_DASHBOARD_REFUND) {
        await transition(transaction, refund, RecoveryCreditRefundStatus.PROVIDER_ACTION_REQUIRED, now);
        return "actionRequired";
      }
      if (refund.settlementMode !== RecoveryCreditRefundSettlementMode.CURRENT_CYCLE_APP_EVENT_CORRECTION) return "attention";

      const correction = refund.correctionUsageEventId
        ? await transaction.usageEvent.findUnique({ where: { id: refund.correctionUsageEventId } })
        : await this.createCorrection(transaction, refund, now);
      if (!correction) {
        await transition(transaction, refund, RecoveryCreditRefundStatus.NEEDS_ATTENTION, now);
        return "attention";
      }
      if (!isMatchingCorrection(refund, correction)) {
        await transition(transaction, refund, RecoveryCreditRefundStatus.NEEDS_ATTENTION, now);
        return "attention";
      }
      const nextStatus = correctionState(correction.shopifyReportState);
      await transition(transaction, refund, nextStatus, now);
      return nextStatus === RecoveryCreditRefundStatus.PROVIDER_PENDING
        ? "pending"
        : nextStatus === RecoveryCreditRefundStatus.PROVIDER_ACTION_REQUIRED ? "actionRequired" : "attention";
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  private async createCorrection(transaction: RefundTransaction, refund: RefundWithRelations, now: Date) {
    const original = refund.purchase.usageEvent;
    if (
      original.metric !== UsageMetric.RECOVERY_CREDIT_PACK_PURCHASE ||
      Number(original.quantity) !== 1 ||
      original.shopifyReportState !== ShopifyReportState.REPORTED ||
      original.shopifyEventHandle !== refund.eventHandleSnapshot ||
      !original.billingPeriodId ||
      original.billingPeriodId !== refund.billingPeriodIdSnapshot ||
      refund.purchase.status !== RecoveryCreditPurchaseStatus.ACTIVE
    ) return null;
    const subscription = await transaction.subscription.findUnique({
      where: { shopId: refund.shopId },
      include: { plan: true },
    });
    if (
      !subscription ||
      subscription.billingPeriodId !== original.billingPeriodId ||
      subscription.observedShopifyPlanHandle !== refund.planHandleSnapshot ||
      subscription.plan?.shopifyRecoveryCreditPackEventHandle !== refund.eventHandleSnapshot
    ) return null;
    const idempotencyKey = `recovery-credit-refund:${refund.id}`;
    const correction = await transaction.usageEvent.upsert({
      where: { idempotencyKey },
      create: {
        shopId: refund.shopId,
        billingPeriodId: refund.billingPeriodIdSnapshot,
        metric: UsageMetric.RECOVERY_CREDIT_PACK_PURCHASE,
        quantity: -1,
        idempotencyKey,
        correctionOfUsageEventId: original.id,
        sourceType: "RECOVERY_CREDIT_REFUND",
        sourceId: refund.id,
        occurredAt: now,
        shopifyReportState: ShopifyReportState.PENDING,
        shopifyEventHandle: refund.eventHandleSnapshot,
        shopifyIdempotencyKey: createShopifyUsageIdempotencyKey(refund.shopId, idempotencyKey),
      },
      update: {},
    });
    const linked = await transaction.recoveryCreditRefund.updateMany({
      where: {
        id: refund.id,
        version: refund.version,
        status: refund.status,
        correctionUsageEventId: null,
      },
      data: { correctionUsageEventId: correction.id, version: { increment: 1 } },
    });
    if (linked.count !== 1) throw new RefundConcurrencyConflict();
    refund.correctionUsageEventId = correction.id;
    refund.version += 1;
    return correction;
  }

  private async finalize(refundId: string, now: Date): Promise<boolean> {
    return this.withConflictRetry(() => this.database.$transaction(async (transaction) => {
      const refund = await transaction.recoveryCreditRefund.findUnique({ where: { id: refundId } });
      if (
        !refund ||
        refund.status !== RecoveryCreditRefundStatus.PROVIDER_CONFIRMED ||
        !refund.holdAppliedAt ||
        !refund.providerConfirmedAt ||
        !refund.providerConfirmedByPlatformAdminId ||
        !refund.providerReference?.trim()
      ) return false;
      const purchase = await transaction.recoveryCreditPurchase.findUnique({ where: { id: refund.purchaseId } });
      if (!purchase || purchase.status !== RecoveryCreditPurchaseStatus.ACTIVE) return false;
      const counter = await transaction.shopEntitlementCounter.findUnique({
        where: { shopId_counter: { shopId: refund.shopId, counter: "PURCHASED_RECOVERY_CREDITS" } },
      });
      if (!counter) return false;
      const updatedCounter = await transaction.shopEntitlementCounter.updateMany({
        where: { id: counter.id, version: counter.version, grantedQuantity: { gte: refund.creditsSnapshot }, refundingQuantity: { gte: refund.creditsSnapshot } },
        data: { grantedQuantity: { decrement: refund.creditsSnapshot }, refundingQuantity: { decrement: refund.creditsSnapshot }, version: { increment: 1 } },
      });
      if (updatedCounter.count !== 1) throw new RefundConcurrencyConflict();
      const updatedPurchase = await transaction.recoveryCreditPurchase.updateMany({
        where: { id: purchase.id, status: RecoveryCreditPurchaseStatus.ACTIVE },
        data: { status: RecoveryCreditPurchaseStatus.REFUNDED },
      });
      if (updatedPurchase.count !== 1) throw new RefundConcurrencyConflict();
      const updatedRefund = await transaction.recoveryCreditRefund.updateMany({
        where: { id: refund.id, version: refund.version, status: RecoveryCreditRefundStatus.PROVIDER_CONFIRMED },
        data: { status: RecoveryCreditRefundStatus.COMPLETED, completedAt: now, processingStartedAt: null, nextAttemptAt: null, version: { increment: 1 } },
      });
      if (updatedRefund.count !== 1) throw new RefundConcurrencyConflict();
      const thread = await transaction.merchantSupportThread.upsert({ where: { shopId: refund.shopId }, create: { shopId: refund.shopId }, update: {} });
      const sourceKey = createMerchantBillingSystemSourceKey(refund.shopId, BILLING_SYSTEM_MESSAGE_CODES.REFUND_COMPLETED, refund.id, ARCH007_BILLING_CONTRACT_SCHEMA_VERSION);
      await transaction.merchantSupportMessage.upsert({
        where: { sourceKey },
        create: {
          threadId: thread.id,
          kind: MerchantSupportMessageKind.SYSTEM,
          state: MerchantSupportMessageState.AVAILABLE,
          originalBody: "Your recovery-credit refund is complete.",
          sourceLanguageTag: "en-GB",
          systemCode: BILLING_SYSTEM_MESSAGE_CODES.REFUND_COMPLETED,
          systemVersion: String(ARCH007_BILLING_CONTRACT_SCHEMA_VERSION),
          sourceKey,
          availableAt: now,
        },
        update: {},
      });
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  private async withConflictRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!isConflict(error) || attempt === 2) throw error;
      }
    }
    throw new RefundConcurrencyConflict();
  }

  private async recoverStale(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - LEASE_MS);
    await this.database.recoveryCreditRefund.updateMany({
      where: { status: RecoveryCreditRefundStatus.PROCESSING, processingStartedAt: { lte: cutoff }, holdAppliedAt: null },
      data: { status: RecoveryCreditRefundStatus.APPROVED, processingStartedAt: null, nextAttemptAt: now, version: { increment: 1 } },
    });
    await this.database.recoveryCreditRefund.updateMany({
      where: { status: RecoveryCreditRefundStatus.PROCESSING, processingStartedAt: { lte: cutoff }, holdAppliedAt: { not: null } },
      data: { status: RecoveryCreditRefundStatus.PROCESSING, processingStartedAt: null, nextAttemptAt: now, version: { increment: 1 } },
    });
  }

  private async markNeedsAttention(refundId: string, now: Date): Promise<void> {
    await this.database.recoveryCreditRefund.updateMany({
      where: { id: refundId, status: RecoveryCreditRefundStatus.APPROVED },
      data: {
        status: RecoveryCreditRefundStatus.NEEDS_ATTENTION,
        providerErrorCode: "REFUND_HOLD_NOT_APPLIED",
        providerResponseSummary: "Refund approval could not be safely held",
        nextAttemptAt: null,
        processingStartedAt: null,
        updatedAt: now,
        version: { increment: 1 },
      },
    });
  }
}

async function transition(transaction: RefundTransaction, refund: RefundWithRelations, status: RecoveryCreditRefundStatus, now: Date): Promise<void> {
  const updated = await transaction.recoveryCreditRefund.updateMany({
    where: { id: refund.id, version: refund.version, status: refund.status },
    data: { status, processingStartedAt: null, nextAttemptAt: null, version: { increment: 1 }, ...(status === RecoveryCreditRefundStatus.NEEDS_ATTENTION ? { providerErrorCode: "REFUND_REQUIRES_ATTENTION" } : {}) },
  });
  if (updated.count !== 1) throw new RefundConcurrencyConflict();
}

function boundedLimit(value: number): number {
  return Number.isInteger(value) && value > 0 ? Math.min(value, DEFAULT_BATCH_SIZE) : DEFAULT_BATCH_SIZE;
}

function isConflict(error: unknown): boolean {
  return error instanceof RefundConcurrencyConflict ||
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

class RefundConcurrencyConflict extends Error {}

function correctionState(state: ShopifyReportState): RecoveryCreditRefundStatus {
  switch (state) {
    case ShopifyReportState.PENDING:
    case ShopifyReportState.IN_FLIGHT:
    case ShopifyReportState.RETRYABLE:
      return RecoveryCreditRefundStatus.PROVIDER_PENDING;
    case ShopifyReportState.REPORTED:
      return RecoveryCreditRefundStatus.PROVIDER_ACTION_REQUIRED;
    case ShopifyReportState.NEEDS_ATTENTION:
    case ShopifyReportState.NOT_APPLICABLE:
      return RecoveryCreditRefundStatus.NEEDS_ATTENTION;
  }
}

function isMatchingCorrection(refund: RefundWithRelations, correction: {
  shopId: string;
  metric: UsageMetric;
  quantity: Prisma.Decimal | number;
  billingPeriodId: string | null;
  correctionOfUsageEventId: string | null;
  sourceType: string | null;
  sourceId: string | null;
  shopifyEventHandle: string | null;
  idempotencyKey: string;
  shopifyIdempotencyKey: string | null;
}): boolean {
  const idempotencyKey = `recovery-credit-refund:${refund.id}`;
  return correction.shopId === refund.shopId &&
    correction.metric === UsageMetric.RECOVERY_CREDIT_PACK_PURCHASE &&
    Number(correction.quantity) === -1 &&
    correction.billingPeriodId === refund.billingPeriodIdSnapshot &&
    correction.correctionOfUsageEventId === refund.originalUsageEventIdSnapshot &&
    correction.sourceType === "RECOVERY_CREDIT_REFUND" &&
    correction.sourceId === refund.id &&
    correction.shopifyEventHandle === refund.eventHandleSnapshot &&
    correction.idempotencyKey === idempotencyKey &&
    correction.shopifyIdempotencyKey === createShopifyUsageIdempotencyKey(refund.shopId, idempotencyKey);
}

export const recoveryCreditRefundService = new RecoveryCreditRefundService();