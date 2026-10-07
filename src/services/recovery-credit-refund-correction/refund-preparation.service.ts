import {
  Prisma,
  RecoveryCreditPurchaseStatus,
  RecoveryCreditRefundStatus,
  ShopifyReportState,
  UsageMetric,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { createShopifyUsageIdempotencyKey } from "@modainteract/moda-interact-shared/billing";

import type { PartnerUsagePricingSnapshot } from "../../providers/shopify-partner-billing.provider.js";
import type { RefundRow } from "./refund-correction.types.js";
import { refundSelect } from "./refund-correction.types.js";
import type { RefundProviderStateService } from "./refund-provider-state.service.js";

const MAX_REASON_LENGTH = 1000;

type UnsafeProof = { safe: false; reason: string };
type PreparationProof =
  | {
      safe: true;
      finalCreditQuantity: number;
      expectedProviderAmount: Prisma.Decimal;
      currency: string;
      quantityBefore: Prisma.Decimal;
      costBefore: Prisma.Decimal;
      quantityAfter: Prisma.Decimal;
      costAfter: Prisma.Decimal;
      correctionValue: Prisma.Decimal;
    }
  | UnsafeProof;

export type RefundPreparationResult =
  | { kind: "prepared" }
  | { kind: "provider-action-required" }
  | { kind: "reconcile"; refund: RefundRow | null };

export class RefundPreparationService {
  constructor(
    private readonly database: PrismaClient,
    private readonly providerState: RefundProviderStateService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async prepare(refund: RefundRow): Promise<RefundPreparationResult> {
    const proof = await this.readProof(refund);
    if (!proof.safe) {
      await this.markProviderActionRequired(refund, proof.reason);
      return { kind: "provider-action-required" };
    }

    const correctionIdempotencyKey = `recovery-credit-refund:${refund.id}`;
    try {
      await this.database.$transaction(async (transaction) => {
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
        if (linked.count !== 1) throw new PrepareRaceError();
      });
      return { kind: "prepared" };
    } catch (error) {
      if (!(error instanceof PrepareRaceError)) throw error;
    }

    const current = await this.database.recoveryCreditRefund.findUnique({
      where: { id: refund.id },
      select: refundSelect,
    });
    return {
      kind: "reconcile",
      refund: current?.automaticCorrectionUsageEventId
        ? (current as unknown as RefundRow)
        : null,
    };
  }

  async markProviderActionRequired(refund: RefundRow, reason: string): Promise<void> {
    const evidence = localRefundEvidence(refund);
    await this.database.recoveryCreditRefund.updateMany({
      where: {
        id: refund.id,
        status: RecoveryCreditRefundStatus.REQUESTED,
        automaticCorrectionUsageEventId: null,
      },
      data: {
        finalCreditQuantity: evidence?.finalCreditQuantity ?? null,
        expectedProviderAmount: evidence?.expectedProviderAmount ?? null,
        expectedProviderCurrency: evidence?.currency ?? null,
        status: RecoveryCreditRefundStatus.PROVIDER_ACTION_REQUIRED,
        reason: boundedReason(reason),
      },
    });
  }

  private async readProof(refund: RefundRow): Promise<PreparationProof> {
    if (
      refund.status !== RecoveryCreditRefundStatus.REQUESTED
      || refund.purchase.status !== RecoveryCreditPurchaseStatus.WITHDRAWN
      || refund.purchase.currentAmount <= 0
      || refund.purchase.reservedAmount !== 0
      || refund.purchase.creditsGranted <= 0
      || !eligibleProviderAmount(
        refund.purchaseProviderAmountSnapshot,
        refund.shopifyPartnerDevelopmentSnapshot,
      )
    ) {
      return unsafe("refund purchase is not eligible for automatic correction");
    }

    const finalCreditQuantity = refund.purchase.currentAmount;
    const ratio = new Prisma.Decimal(finalCreditQuantity).div(refund.purchase.creditsGranted);
    if (ratio.lte(0) || ratio.gt(1)) return unsafe("refund ratio is outside (0, 1]");

    const provider = await this.providerState.readForPrepare(refund);
    if (!provider.safe) return provider;
    if (provider.currency !== refund.purchaseProviderCurrencySnapshot.toUpperCase()) {
      return unsafe("Shopify provider quantity, cost, or currency is unavailable");
    }

    const quantityBefore = provider.quantity;
    const costBefore = provider.cost;
    const correctionValue = ratio.neg();
    const quantityAfter = quantityBefore.plus(correctionValue);
    if (quantityAfter.lt(0)) return unsafe("provider quantity would become negative");

    const costAfter = calculateTieredCost(provider.pricing, quantityAfter);
    if (!costAfter) return unsafe("live Shopify pricing is unavailable or ambiguous");

    const expectedProviderAmount = refund.purchaseProviderAmountSnapshot
      .mul(ratio)
      .toDecimalPlaces(2);
    const reduction = costBefore.minus(costAfter).toDecimalPlaces(2);
    if (!reduction.equals(expectedProviderAmount)) {
      return unsafe("live Shopify pricing does not prove the refund amount");
    }

    return {
      safe: true,
      finalCreditQuantity,
      expectedProviderAmount,
      currency: provider.currency,
      quantityBefore,
      costBefore,
      quantityAfter,
      costAfter,
      correctionValue,
    };
  }
}

class PrepareRaceError extends Error {
  constructor() {
    super("recovery-credit refund preparation lost its refund-link race");
    this.name = "PrepareRaceError";
  }
}

function calculateTieredCost(
  pricing: PartnerUsagePricingSnapshot,
  quantity: Prisma.Decimal,
): Prisma.Decimal | null {
  if (!quantity.isFinite() || quantity.lt(0) || !pricing.tiers.length) return null;
  const tiers = pricing.tiers.map((tier) => ({
    ...tier,
    upTo: tier.upTo === null ? null : new Prisma.Decimal(tier.upTo),
    unit: parseDecimal(tier.amountPerUnit),
    flat: parseDecimal(tier.amount),
  }));
  if (tiers.some((tier) => !tier.unit || !tier.flat || tier.unit.lt(0) || tier.flat.lt(0))) {
    return null;
  }
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

function parseDecimal(
  value: string | number | Prisma.Decimal | null | undefined,
): Prisma.Decimal | null {
  if (value === null || value === undefined) return null;
  try {
    const decimal = new Prisma.Decimal(value);
    return decimal.isFinite() ? decimal : null;
  } catch {
    return null;
  }
}

function eligibleProviderAmount(
  amount: Prisma.Decimal,
  shopifyPartnerDevelopmentSnapshot: boolean,
): boolean {
  return (
    amount.isFinite()
    && (
      amount.gt(0)
      || (shopifyPartnerDevelopmentSnapshot && amount.isZero())
    )
  );
}

function localRefundEvidence(
  refund: RefundRow,
): { finalCreditQuantity: number; expectedProviderAmount: Prisma.Decimal; currency: string } | null {
  if (
    refund.purchase.currentAmount <= 0
    || refund.purchase.creditsGranted <= 0
    || !eligibleProviderAmount(
      refund.purchaseProviderAmountSnapshot,
      refund.shopifyPartnerDevelopmentSnapshot,
    )
  ) {
    return null;
  }
  const ratio = new Prisma.Decimal(refund.purchase.currentAmount).div(refund.purchase.creditsGranted);
  if (ratio.lte(0) || ratio.gt(1)) return null;
  return {
    finalCreditQuantity: refund.purchase.currentAmount,
    expectedProviderAmount: refund.purchaseProviderAmountSnapshot.mul(ratio).toDecimalPlaces(2),
    currency: refund.purchaseProviderCurrencySnapshot,
  };
}

function unsafe(reason: string): UnsafeProof {
  return { safe: false, reason };
}

function nonNegative(value: Prisma.Decimal): Prisma.Decimal {
  return value.lt(0) ? new Prisma.Decimal(0) : value;
}

function boundedReason(reason: string): string {
  return reason.slice(0, MAX_REASON_LENGTH);
}
