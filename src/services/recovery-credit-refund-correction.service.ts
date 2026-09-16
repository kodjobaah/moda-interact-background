import {
  Prisma,
  RecoveryCreditPurchaseStatus,
  RecoveryCreditRefundStatus,
  ShopifyReportState,
  UsageMetric,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import {
  createShopifyUsageIdempotencyKey,
  deriveShopifyProviderContextIdentity,
} from "@modainteract/moda-interact-shared/billing";

import prisma from "../lib/db.js";
import {
  getSubscriptionReconciliationSnapshot,
  shopifyPartnerBillingApi,
  type PartnerSubscription,
  type PartnerUsagePricingSnapshot,
  type ShopifyPartnerBillingProvider,
} from "../providers/shopify-partner-billing.provider.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_REASON_LENGTH = 1000;

type RefundDatabase = PrismaClient;

type RefundRow = {
  id: string;
  shopId: string;
  status: RecoveryCreditRefundStatus;
  reason: string | null;
  purchaseId: string;
  billingPeriodIdSnapshot: string;
  providerSubscriptionIdSnapshot: string;
  planHandleSnapshot: string;
  eventHandleSnapshot: string;
  purchaseProviderAmountSnapshot: Prisma.Decimal;
  purchaseProviderCurrencySnapshot: string;
  finalCreditQuantity: number | null;
  expectedProviderAmount: Prisma.Decimal | null;
  expectedProviderCurrency: string | null;
  automaticCorrectionUsageEventId: string | null;
  providerUsageQuantityBeforeCorrection: Prisma.Decimal | null;
  providerUsageCostBeforeCorrection: Prisma.Decimal | null;
  expectedProviderUsageQuantityAfterCorrection: Prisma.Decimal | null;
  expectedProviderUsageCostAfterCorrection: Prisma.Decimal | null;
  version: number;
  purchase: {
    usageEventId: string;
    status: RecoveryCreditPurchaseStatus;
    currentAmount: number;
    reservedAmount: number;
    creditsGranted: number;
  };
  shop: { shopifyShopId: string | null };
  automaticCorrectionUsageEvent: {
    id: string;
    quantity: Prisma.Decimal;
    correctionOfUsageEventId: string | null;
    sourceType: string | null;
    sourceId: string | null;
    shopifyEventHandle: string | null;
    shopifyIdempotencyKey: string | null;
    shopifyReportState: ShopifyReportState;
  } | null;
};

export type RecoveryCreditRefundCorrectionResult = {
  selected: number;
  prepared: number;
  reconciled: number;
  completed: number;
  providerActionRequired: number;
  needsAttention: number;
};

export class RecoveryCreditRefundCorrectionService {
  constructor(
    private readonly database: RefundDatabase = prisma,
    private readonly partner: ShopifyPartnerBillingProvider = shopifyPartnerBillingApi,
    private readonly now: () => Date = () => new Date(),
    private readonly pageSize = DEFAULT_PAGE_SIZE,
  ) {}

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
    for (const refund of refunds as unknown as RefundRow[]) {
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
          await this.markProviderActionRequired(refund, error instanceof Error ? error.message : "provider proof unavailable");
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
    const proof = await this.readProof(refund);
    if (!proof.safe) {
      await this.markProviderActionRequired(refund, proof.reason);
      return "provider-action-required";
    }

    const correctionIdempotencyKey = `recovery-credit-refund:${refund.id}`;
    const prepared = await this.database.$transaction(async (transaction) => {
      const correction = await transaction.usageEvent.upsert({
        where: { idempotencyKey: correctionIdempotencyKey },
        update: {},
        create: {
          shopId: refund.shopId,
          billingPeriodId: refund.billingPeriodIdSnapshot,
          metric: UsageMetric.RECOVERY_CREDIT_PACK_PURCHASE,
          quantity: proof.correctionValue,
          correctionOfUsageEventId: refund.purchase.usageEventId,
          sourceType: "RECOVERY_CREDIT_REFUND",
          sourceId: refund.id,
          shopifyEventHandle: refund.eventHandleSnapshot,
          shopifyIdempotencyKey: createShopifyUsageIdempotencyKey(
            refund.shopId,
            correctionIdempotencyKey,
          ),
          idempotencyKey: correctionIdempotencyKey,
          occurredAt: this.now(),
          shopifyReportState: ShopifyReportState.PENDING,
        },
      });
      const linked = await transaction.recoveryCreditRefund.updateMany({
        where: {
          id: refund.id,
          status: RecoveryCreditRefundStatus.REQUESTED,
          automaticCorrectionUsageEventId: null,
        },
        data: {
          finalCreditQuantity: proof.finalCreditQuantity,
          expectedProviderAmount: proof.expectedProviderAmount,
          expectedProviderCurrency: proof.currency,
          providerUsageQuantityBeforeCorrection: proof.quantityBefore,
          providerUsageCostBeforeCorrection: proof.costBefore,
          expectedProviderUsageQuantityAfterCorrection: proof.quantityAfter,
          expectedProviderUsageCostAfterCorrection: proof.costAfter,
          automaticCorrectionUsageEventId: correction.id,
        },
      });
      return { correction, linked: linked.count === 1 };
    });
    if (prepared.linked) return "prepared";

    const current = await this.database.recoveryCreditRefund.findUnique({
      where: { id: refund.id },
      select: refundSelect,
    });
    if (current?.automaticCorrectionUsageEventId) {
      return this.reconcile(current as unknown as RefundRow);
    }
    return "reconciled";
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

    const proof = await this.readProviderState(refund);
    if (!proof.safe) {
      await this.markNeedsAttention(refund, proof.reason);
      return "needs-attention";
    }
    if (
      !proof.quantity.equals(refund.expectedProviderUsageQuantityAfterCorrection!)
      || !proof.cost.equals(refund.expectedProviderUsageCostAfterCorrection!)
      || proof.currency !== refund.expectedProviderCurrency
    ) return "reconciled";

    const completed = await this.complete(refund, proof.cost, proof.currency!);
    return completed ? "completed" : "reconciled";
  }

  private async readProof(refund: RefundRow): Promise<PreparationProof> {
    if (
      refund.status !== RecoveryCreditRefundStatus.REQUESTED
      || refund.purchase.status !== RecoveryCreditPurchaseStatus.WITHDRAWN
      || refund.purchase.currentAmount <= 0
      || refund.purchase.reservedAmount !== 0
      || refund.purchase.creditsGranted <= 0
      || !refund.purchaseProviderAmountSnapshot.gt(0)
    ) return unsafe("refund purchase is not eligible for automatic correction");
    const finalCreditQuantity = refund.purchase.currentAmount;
    const ratio = new Prisma.Decimal(finalCreditQuantity).div(refund.purchase.creditsGranted);
    if (ratio.lte(0) || ratio.gt(1)) return unsafe("refund ratio is outside (0, 1]");
    const provider = await this.readProvider(refund);
    if (!provider.safe) return provider;
    const quantityBefore = provider.quantity;
    const costBefore = provider.cost;
    const correctionValue = ratio.neg();
    const quantityAfter = quantityBefore.plus(correctionValue);
    if (quantityAfter.lt(0)) return unsafe("provider quantity would become negative");
    const costAfter = calculateTieredCost(provider.pricing!, quantityAfter);
    if (!costAfter) return unsafe("live Shopify pricing is unavailable or ambiguous");
    const expectedProviderAmount = refund.purchaseProviderAmountSnapshot.mul(ratio).toDecimalPlaces(2);
    const reduction = costBefore.minus(costAfter).toDecimalPlaces(2);
    if (!reduction.equals(expectedProviderAmount)) return unsafe("live Shopify pricing does not prove the refund amount");
    return {
      safe: true,
      finalCreditQuantity,
      expectedProviderAmount,
      currency: provider.currency!,
      quantityBefore,
      costBefore,
      quantityAfter,
      costAfter,
      correctionValue,
    };
  }

  private async readProvider(refund: RefundRow): Promise<ProviderProof> {
    const shopifyShopId = refund.shop.shopifyShopId;
    if (!shopifyShopId) return unsafe("shop has no Shopify identifier");
    const snapshot = await getSubscriptionReconciliationSnapshot(this.partner, shopifyShopId);
    const provider = snapshot.activeSubscription;
    if (!provider) return unsafe("Shopify subscription is unavailable");
    const period = await this.database.billingPeriod.findUnique({
      where: { id: refund.billingPeriodIdSnapshot },
      select: { periodStart: true, periodEnd: true },
    });
    const context = provider.providerSubscriptionId && provider.currentPeriodStart && provider.currentPeriodEnd
      ? deriveShopifyProviderContextIdentity({
          providerSubscriptionId: provider.providerSubscriptionId,
          planHandle: provider.planHandle,
          currentPeriodStart: provider.currentPeriodStart,
          currentPeriodEnd: provider.currentPeriodEnd,
        })
      : null;
    if (
      context !== refund.providerSubscriptionIdSnapshot
      || provider.planHandle !== refund.planHandleSnapshot
      || !period
      || provider.currentPeriodStart?.getTime() !== period.periodStart.getTime()
      || provider.currentPeriodEnd?.getTime() !== period.periodEnd.getTime()
      || !provider.usageEventHandles.includes(refund.eventHandleSnapshot)
    ) return unsafe("Shopify provider context does not match frozen refund provenance");
    const usage = provider.providerUsageSnapshot.find((item) => item.handle === refund.eventHandleSnapshot);
    const pricing = provider.providerUsagePricingSnapshot?.find((item) => item.handle === refund.eventHandleSnapshot);
    const quantity = parseDecimal(usage?.quantity);
    const cost = parseDecimal(usage?.costAmount);
    const currency = usage?.costCurrency?.trim().toUpperCase();
    if (!quantity || !cost || cost.lt(0) || !currency || currency !== refund.purchaseProviderCurrencySnapshot.toUpperCase() || !pricing || pricing.currency?.toUpperCase() !== currency) {
      return unsafe("Shopify provider quantity, cost, currency, or pricing is unavailable");
    }
    return { safe: true, quantity, cost, currency, pricing };
  }

  private async readProviderState(refund: RefundRow): Promise<ProviderProof> {
    return this.readProvider(refund);
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
      return true;
    });
  }

  private async markProviderActionRequired(refund: RefundRow, reason: string): Promise<void> {
    await this.database.recoveryCreditRefund.updateMany({
      where: { id: refund.id, status: RecoveryCreditRefundStatus.REQUESTED, automaticCorrectionUsageEventId: null },
      data: { finalCreditQuantity: refund.purchase.currentAmount > 0 ? refund.purchase.currentAmount : null, expectedProviderAmount: refund.purchaseProviderAmountSnapshot, expectedProviderCurrency: refund.purchaseProviderCurrencySnapshot, status: RecoveryCreditRefundStatus.PROVIDER_ACTION_REQUIRED, reason: boundedReason(reason) },
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
type UnsafeProof = { safe: false; reason: string };
type ProviderProof = { safe: true; quantity: Prisma.Decimal; cost: Prisma.Decimal; currency: string; pricing: PartnerUsagePricingSnapshot } | UnsafeProof;
type PreparationProof = { safe: true; finalCreditQuantity: number; expectedProviderAmount: Prisma.Decimal; currency: string; quantityBefore: Prisma.Decimal; costBefore: Prisma.Decimal; quantityAfter: Prisma.Decimal; costAfter: Prisma.Decimal; correctionValue: Prisma.Decimal } | UnsafeProof;

const refundSelect = {
  id: true, shopId: true, status: true, reason: true, purchaseId: true,
  billingPeriodIdSnapshot: true, providerSubscriptionIdSnapshot: true, planHandleSnapshot: true,
  eventHandleSnapshot: true, purchaseProviderAmountSnapshot: true, purchaseProviderCurrencySnapshot: true,
  finalCreditQuantity: true, expectedProviderAmount: true, expectedProviderCurrency: true,
  automaticCorrectionUsageEventId: true, providerUsageQuantityBeforeCorrection: true,
  providerUsageCostBeforeCorrection: true, expectedProviderUsageQuantityAfterCorrection: true,
  expectedProviderUsageCostAfterCorrection: true,
  version: true,
  purchase: { select: { usageEventId: true, status: true, currentAmount: true, reservedAmount: true, creditsGranted: true } },
  shop: { select: { shopifyShopId: true } },
  automaticCorrectionUsageEvent: { select: { id: true, quantity: true, correctionOfUsageEventId: true, sourceType: true, sourceId: true, shopifyEventHandle: true, shopifyIdempotencyKey: true, shopifyReportState: true } },
} as const;

function calculateTieredCost(pricing: PartnerUsagePricingSnapshot, quantity: Prisma.Decimal): Prisma.Decimal | null {
  if (!quantity.isFinite() || quantity.lt(0) || !pricing.tiers.length) return null;
  const tiers = pricing.tiers.map((tier) => ({ ...tier, upTo: tier.upTo === null ? null : new Prisma.Decimal(tier.upTo), unit: parseDecimal(tier.amountPerUnit), flat: parseDecimal(tier.amount) }));
  if (tiers.some((tier) => !tier.unit || !tier.flat || tier.unit.lt(0) || tier.flat.lt(0))) return null;
  if (pricing.tiersMode.toUpperCase() === "VOLUME") {
    const tier = tiers.find((candidate) => candidate.upTo === null || quantity.lte(candidate.upTo));
    return tier ? tier.flat!.plus(quantity.mul(tier.unit!)) : null;
  }
  if (pricing.tiersMode.toUpperCase() !== "GRADUATED") return null;
  let total = new Prisma.Decimal(0);
  let lower = new Prisma.Decimal(0);
  for (const tier of tiers) {
    const upper = tier.upTo ?? quantity;
    const segment = nonNegative(quantity.lt(upper) ? quantity.minus(lower) : upper.minus(lower));
    total = total.plus(segment.mul(tier.unit!).plus(tier.flat!));
    if (quantity.lte(upper)) return total;
    lower = upper;
  }
  return null;
}

function validCorrectionEvent(refund: RefundRow, event: NonNullable<RefundRow["automaticCorrectionUsageEvent"]>): boolean {
  return event.id === refund.automaticCorrectionUsageEventId && event.sourceType === "RECOVERY_CREDIT_REFUND" && event.sourceId === refund.id && event.correctionOfUsageEventId === refund.purchase.usageEventId && event.shopifyEventHandle === refund.eventHandleSnapshot && event.quantity.isFinite() && event.quantity.lt(0) && !event.quantity.isZero() && Boolean(event.shopifyIdempotencyKey);
}

function completeEvidence(refund: RefundRow): boolean {
  return refund.finalCreditQuantity !== null && refund.finalCreditQuantity > 0 && refund.expectedProviderAmount?.isFinite() === true && refund.expectedProviderCurrency !== null && refund.providerUsageQuantityBeforeCorrection?.isFinite() === true && refund.providerUsageCostBeforeCorrection?.isFinite() === true && refund.expectedProviderUsageQuantityAfterCorrection?.isFinite() === true && refund.expectedProviderUsageCostAfterCorrection?.isFinite() === true;
}

function parseDecimal(value: string | number | Prisma.Decimal | null | undefined): Prisma.Decimal | null {
  if (value === null || value === undefined) return null;
  try {
    const decimal = new Prisma.Decimal(value);
    return decimal.isFinite() ? decimal : null;
  } catch { return null; }
}

function unsafe(reason: string): { safe: false; reason: string } { return { safe: false, reason }; }
function nonNegative(value: Prisma.Decimal): Prisma.Decimal { return value.lt(0) ? new Prisma.Decimal(0) : value; }
function boundedReason(reason: string): string { return reason.slice(0, MAX_REASON_LENGTH); }
function boundedPageSize(value: number): number { return Number.isInteger(value) && value > 0 ? Math.min(value, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE; }