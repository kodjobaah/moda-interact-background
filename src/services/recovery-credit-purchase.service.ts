import {
  Prisma,
  RecoveryCreditPurchaseStatus,
  ShopifyReportState,
  UsageMetric,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { createShopifyUsageIdempotencyKey } from "@modainteract/moda-interact-shared/billing";

import prisma from "../lib/db.js";
import { recoveryCapacityResumeService } from "./recovery-capacity-resume.service.js";

const MAX_TRANSACTION_RETRIES = 3;

type PurchaseDatabase = Pick<
  PrismaClient,
  "$transaction" | "recoveryCreditPurchase" | "shopEntitlementCounter" | "usageEvent"
>;

export type ProviderConfirmedPurchaseReconciliationInput = {
  shopId: string;
  billingPeriodId: string;
  providerPlanHandle: string;
  packMeterHandle: string;
  providerSubscriptionId: string | null;
  providerUnits: number;
  providerCostAmount: string | null;
  providerCostCurrency: string | null;
};

export type PurchaseReconciliationDiscrepancy = {
  kind: "under" | "over" | "ambiguous" | "invalid-provider-units" | "invalid-scope";
  shopId: string;
  billingPeriodId: string;
  providerPlanHandle: string;
  packMeterHandle: string;
  providerUnits: number;
  alreadyMatchedUnits: number;
  eligibleCandidateCount: number;
  confirmedDelta: number;
  detail?: string;
};

export type ProviderConfirmedPurchaseReconciliationResult = {
  activatedCount: number;
  alreadyMatchedUnits: number;
  eligibleCandidateCount: number;
  confirmedDelta: number;
  discrepancy: PurchaseReconciliationDiscrepancy | null;
};

export type RecoveryCreditPurchaseInput = {
  id: string;
  shopId: string;
  planId: string;
  billingPeriodId: string;
  providerSubscriptionIdSnapshot: string;
  shopifyPlanHandleSnapshot: string;
  shopifyEventHandleSnapshot: string;
  providerUsageQuantityBeforeSnapshot: number;
  providerUsageCostBeforeSnapshot: string | Prisma.Decimal;
  providerUsageCostCurrencyBeforeSnapshot: string;
  providerPriceSnapshot?: Prisma.InputJsonValue;
  creditsGranted: number;
  occurredAt?: Date;
};

export class RecoveryCreditPurchaseService {
  constructor(
    private readonly database: PurchaseDatabase = prisma,
    private readonly maxRetries = MAX_TRANSACTION_RETRIES,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: RecoveryCreditPurchaseInput) {
    validatePurchaseInput(input);
    return this.withRetry(() =>
      this.database.$transaction(async (transaction) => {
        const existing = await transaction.recoveryCreditPurchase.findUnique({
          where: { id: input.id },
        });
        if (existing) return existing;

        const idempotencyKey = `recovery-credit-pack:${input.shopId}:${input.id}`;
        const usageEvent = await transaction.usageEvent.create({
          data: {
            shopId: input.shopId,
            billingPeriodId: input.billingPeriodId,
            metric: UsageMetric.RECOVERY_CREDIT_PACK_PURCHASE,
            quantity: 1,
            idempotencyKey,
            sourceType: "RECOVERY_CREDIT_PACK_PURCHASE",
            sourceId: input.id,
            occurredAt: input.occurredAt ?? this.now(),
            shopifyReportState: ShopifyReportState.PENDING,
            shopifyEventHandle: input.shopifyEventHandleSnapshot,
            shopifyIdempotencyKey: createShopifyUsageIdempotencyKey(
              input.shopId,
              idempotencyKey,
            ),
          },
        });

        return transaction.recoveryCreditPurchase.create({
          data: {
            id: input.id,
            shopId: input.shopId,
            planId: input.planId,
            billingPeriodId: input.billingPeriodId,
            providerSubscriptionIdSnapshot: input.providerSubscriptionIdSnapshot,
            shopifyPlanHandleSnapshot: input.shopifyPlanHandleSnapshot,
            shopifyEventHandleSnapshot: input.shopifyEventHandleSnapshot,
            providerUsageQuantityBeforeSnapshot: input.providerUsageQuantityBeforeSnapshot,
            providerUsageCostBeforeSnapshot: input.providerUsageCostBeforeSnapshot,
            providerUsageCostCurrencyBeforeSnapshot: input.providerUsageCostCurrencyBeforeSnapshot,
            ...(input.providerPriceSnapshot === undefined ? {} : { providerPriceSnapshot: input.providerPriceSnapshot }),
            creditsGranted: input.creditsGranted,
            usageEventId: usageEvent.id,
          },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
    );
  }

  async reconcileProviderConfirmed(
    input: ProviderConfirmedPurchaseReconciliationInput,
  ): Promise<ProviderConfirmedPurchaseReconciliationResult> {
    const empty = {
      activatedCount: 0,
      alreadyMatchedUnits: 0,
      eligibleCandidateCount: 0,
      confirmedDelta: 0,
      discrepancy: null,
    } satisfies ProviderConfirmedPurchaseReconciliationResult;
    if (!Number.isInteger(input.providerUnits) || input.providerUnits < 0) {
      return {
        ...empty,
        discrepancy: {
          kind: "invalid-provider-units",
          ...input,
          alreadyMatchedUnits: 0,
          eligibleCandidateCount: 0,
          confirmedDelta: 0,
          detail: "Provider pack usage must be a finite non-negative integer",
        },
      };
    }

    const result = await this.withRetry(() =>
      this.database.$transaction(async (transaction) => {
        const scope = {
          shopId: input.shopId,
          shopifyPlanHandleSnapshot: input.providerPlanHandle,
          shopifyEventHandleSnapshot: input.packMeterHandle,
          billingPeriodId: input.billingPeriodId,
          usageEvent: {
            shopId: input.shopId,
            shopifyEventHandle: input.packMeterHandle,
            metric: UsageMetric.RECOVERY_CREDIT_PACK_PURCHASE,
            quantity: 1,
            shopifyReportState: ShopifyReportState.REPORTED,
            billingPeriodId: input.billingPeriodId,
          },
        } satisfies Prisma.RecoveryCreditPurchaseWhereInput;
        const alreadyMatchedUnits = await transaction.recoveryCreditPurchase.count({
          where: { ...scope, status: RecoveryCreditPurchaseStatus.ACTIVE },
        });
        const candidates = await transaction.recoveryCreditPurchase.findMany({
          where: {
            ...scope,
            status: RecoveryCreditPurchaseStatus.REQUESTED,
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            creditsGranted: true,
            version: true,
            currentAmount: true,
            reservedAmount: true,
            providerSubscriptionIdSnapshot: true,
            providerUsageQuantityBeforeSnapshot: true,
            providerUsageCostBeforeSnapshot: true,
            providerUsageCostCurrencyBeforeSnapshot: true,
          },
        });
        const reportedDelta = input.providerUnits - alreadyMatchedUnits;
        const discrepancy = (kind: PurchaseReconciliationDiscrepancy["kind"], detail?: string): PurchaseReconciliationDiscrepancy => ({
          kind,
          ...input,
          alreadyMatchedUnits,
          eligibleCandidateCount: candidates.length,
          confirmedDelta: reportedDelta,
          ...(detail ? { detail } : {}),
        });
        if (reportedDelta <= 0 || candidates.length === 0) {
          return {
            activatedCount: 0,
            alreadyMatchedUnits,
            eligibleCandidateCount: candidates.length,
            confirmedDelta: candidates.length === 0 && alreadyMatchedUnits > 0 ? 0 : reportedDelta,
            discrepancy: reportedDelta < 0
              ? discrepancy("under", "Provider quantity is below already matched local purchases")
              : candidates.length > 0 && reportedDelta === 0
                ? null
                : input.providerUnits > alreadyMatchedUnits && alreadyMatchedUnits === 0
                  ? discrepancy("over", "Provider units have no eligible local purchase")
                  : null,
          };
        }

        const confirmedDelta = 1;
        if (candidates.length !== 1) {
          return {
            activatedCount: 0,
            alreadyMatchedUnits,
            eligibleCandidateCount: candidates.length,
            confirmedDelta,
            discrepancy: discrepancy("ambiguous", "Provider quantity/cost cannot be attributed uniquely to one unresolved purchase"),
          };
        }

        const candidate = candidates[0]!;
        const providerCost = parseProviderCost(input.providerCostAmount);
        const beforeCost = new Prisma.Decimal(candidate.providerUsageCostBeforeSnapshot);
        const providerPurchaseAmount = providerCost?.minus(beforeCost);
        if (
          input.providerSubscriptionId === null
          || candidate.providerSubscriptionIdSnapshot !== input.providerSubscriptionId
          || input.providerCostCurrency === null
          || input.providerCostCurrency !== candidate.providerUsageCostCurrencyBeforeSnapshot
          || providerCost === null
          || providerPurchaseAmount === undefined
          || providerPurchaseAmount.lte(0)
          || input.providerUnits !== candidate.providerUsageQuantityBeforeSnapshot + 1
        ) {
          return {
            activatedCount: 0,
            alreadyMatchedUnits,
            eligibleCandidateCount: candidates.length,
            confirmedDelta,
            discrepancy: discrepancy("ambiguous", "Provider subscription, quantity, cost, or currency does not prove this purchase"),
          };
        }
        const activated = await transaction.recoveryCreditPurchase.updateMany({
          where: {
            id: candidate.id,
            version: candidate.version,
            status: RecoveryCreditPurchaseStatus.REQUESTED,
            currentAmount: 0,
            reservedAmount: 0,
            providerUsageQuantityAfterSnapshot: null,
            providerPurchaseAmount: null,
            providerValuationConfirmedAt: null,
          },
          data: {
            providerUsageQuantityAfterSnapshot: input.providerUnits,
            providerUsageCostAfterSnapshot: providerCost,
            providerUsageCostCurrencyAfterSnapshot: input.providerCostCurrency,
            providerPurchaseAmount,
            providerPurchaseCurrency: input.providerCostCurrency,
            providerValuationConfirmedAt: this.now(),
            currentAmount: candidate.creditsGranted,
            status: RecoveryCreditPurchaseStatus.ACTIVE,
            activatedAt: this.now(),
            version: { increment: 1 },
          },
        });
        if (activated.count !== 1) {
          return {
            activatedCount: 0,
            alreadyMatchedUnits,
            eligibleCandidateCount: candidates.length,
            confirmedDelta,
            discrepancy: discrepancy("ambiguous", "Purchase changed before valuation could commit"),
          };
        }
        await transaction.shopEntitlementCounter.upsert({
          where: { shopId_counter: { shopId: input.shopId, counter: "PURCHASED_RECOVERY_CREDITS" } },
          create: {
            shopId: input.shopId,
            counter: "PURCHASED_RECOVERY_CREDITS",
            grantedQuantity: candidate.creditsGranted,
          },
          update: {
            grantedQuantity: { increment: candidate.creditsGranted },
            version: { increment: 1 },
          },
        });
        return {
          activatedCount: 1,
          alreadyMatchedUnits,
          eligibleCandidateCount: candidates.length,
          confirmedDelta,
          discrepancy: confirmedDelta > candidates.length
            ? discrepancy("over", "Provider units exceed eligible local purchases")
            : null,
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
    );
    if (result.activatedCount > 0) {
      try {
        await recoveryCapacityResumeService.schedule({
          shopId: input.shopId,
          trigger: `purchase-activation-${input.billingPeriodId}`,
        });
      } catch (error) {
        console.error(
          `Failed to schedule capacity resume after purchase activation for shop ${input.shopId}`,
          error,
        );
      }
    }
    return result;
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!isRetryableConflict(error) || attempt === this.maxRetries - 1) throw error;
      }
    }
    throw new Error("Recovery credit purchase retry limit exceeded");
  }
}

function validatePurchaseInput(input: RecoveryCreditPurchaseInput): void {
  if (!input.id || !input.shopId || !input.planId || !input.billingPeriodId || !input.providerSubscriptionIdSnapshot || !input.shopifyPlanHandleSnapshot || !input.shopifyEventHandleSnapshot || !input.providerUsageCostCurrencyBeforeSnapshot) {
    throw new Error("Recovery credit purchase identity and Shopify handles are required");
  }
  if (!Number.isSafeInteger(input.providerUsageQuantityBeforeSnapshot) || input.providerUsageQuantityBeforeSnapshot < 0) {
    throw new Error("Recovery credit purchase provider quantity snapshot must be a non-negative safe integer");
  }
  try {
    if (new Prisma.Decimal(input.providerUsageCostBeforeSnapshot).lt(0)) throw new Error("negative");
  } catch {
    throw new Error("Recovery credit purchase provider cost snapshot must be a valid non-negative amount");
  }
  if (!Number.isSafeInteger(input.creditsGranted) || input.creditsGranted <= 0) {
    throw new Error("Recovery credit purchase creditsGranted must be a positive safe integer");
  }
}

function parseProviderCost(value: string | null): Prisma.Decimal | null {
  if (value === null) return null;
  try {
    const cost = new Prisma.Decimal(value);
    return cost.isFinite() && cost.gte(0) ? cost : null;
  } catch {
    return null;
  }
}

function isRetryableConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2002" || error.code === "P2034");
}

export const recoveryCreditPurchaseService = new RecoveryCreditPurchaseService();
