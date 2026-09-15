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
  providerUnits: number | string | Prisma.Decimal;
  providerCostAmount: string | null;
  providerCostCurrency: string | null;
  providerUsageSnapshot?: Array<{
    handle: string;
    quantity: number | string | null;
    costAmount: string | null;
    costCurrency: string | null;
  }>;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
};

export type PurchaseReconciliationDiscrepancy = {
  kind: "under" | "over" | "ambiguous" | "invalid-provider-units" | "invalid-scope";
  shopId: string;
  billingPeriodId: string;
  providerPlanHandle: string;
  packMeterHandle: string;
  providerUnits: string;
  alreadyMatchedUnits: string;
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
  providerUsageQuantityBeforeSnapshot: number | string | Prisma.Decimal;
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
    const providerUnits = parseProviderQuantity(input.providerUnits);
    if (input.providerUsageSnapshot === undefined && providerUnits === null) {
      return {
        ...empty,
        discrepancy: {
          kind: "invalid-provider-units",
          ...input,
          providerUnits: String(input.providerUnits),
          alreadyMatchedUnits: "0",
          eligibleCandidateCount: 0,
          confirmedDelta: 0,
          detail: "Provider pack usage must be a finite non-negative integer",
        },
      };
    }

    const result = await this.withRetry(() =>
      this.database.$transaction(async (transaction) => {
        const scopedToCurrentMeter = input.providerUsageSnapshot === undefined;
        const scope = {
          shopId: input.shopId,
          ...(scopedToCurrentMeter ? {
            shopifyPlanHandleSnapshot: input.providerPlanHandle,
            shopifyEventHandleSnapshot: input.packMeterHandle,
            billingPeriodId: input.billingPeriodId,
          } : {}),
          usageEvent: {
            shopId: input.shopId,
            ...(scopedToCurrentMeter ? { shopifyEventHandle: input.packMeterHandle, billingPeriodId: input.billingPeriodId } : {}),
            metric: UsageMetric.RECOVERY_CREDIT_PACK_PURCHASE,
            quantity: 1,
            shopifyReportState: ShopifyReportState.REPORTED,
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
            shopifyPlanHandleSnapshot: true,
            shopifyEventHandleSnapshot: true,
            billingPeriodId: true,
            providerUsageQuantityBeforeSnapshot: true,
            providerUsageCostBeforeSnapshot: true,
            providerUsageCostCurrencyBeforeSnapshot: true,
            billingPeriod: { select: { periodStart: true, periodEnd: true } },
          },
        });
        const discrepancy = (kind: PurchaseReconciliationDiscrepancy["kind"], detail?: string): PurchaseReconciliationDiscrepancy => ({
          kind,
          ...input,
          providerUnits: providerUnits?.toString() ?? String(input.providerUnits),
          alreadyMatchedUnits: String(alreadyMatchedUnits),
          eligibleCandidateCount: candidates.length,
          confirmedDelta: 0,
          ...(detail ? { detail } : {}),
        });
        if (candidates.length === 0) {
          return {
            activatedCount: 0,
            alreadyMatchedUnits,
            eligibleCandidateCount: 0,
            confirmedDelta: 0,
            discrepancy: providerUnits?.gt(0) && alreadyMatchedUnits === 0
              ? discrepancy("over", "Provider units have no eligible local purchase")
              : null,
          };
        }

        const candidatesByHandle = new Map<string, typeof candidates>();
        for (const candidate of candidates) {
          const sameHandle = candidatesByHandle.get(candidate.shopifyEventHandleSnapshot) ?? [];
          sameHandle.push(candidate);
          candidatesByHandle.set(candidate.shopifyEventHandleSnapshot, sameHandle);
        }
        if ([...candidatesByHandle.values()].some((sameHandle) => sameHandle.length > 1)) {
          return {
            activatedCount: 0,
            alreadyMatchedUnits,
            eligibleCandidateCount: candidates.length,
            confirmedDelta: 0,
            discrepancy: discrepancy("ambiguous", "Provider quantity/cost cannot be attributed uniquely to one unresolved purchase"),
          };
        }

        let activatedCount = 0;
        let grantedQuantity = 0;
        let failedProof = false;
        for (const candidate of candidates) {
          const candidateUsage = input.providerUsageSnapshot?.find(
            (usage) => usage.handle === candidate.shopifyEventHandleSnapshot,
          );
          const candidateUnits = candidateUsage
            ? parseProviderQuantity(candidateUsage.quantity as number | string | Prisma.Decimal)
            : providerUnits;
          const hasExactProviderUsage = input.providerUsageSnapshot === undefined
            ? candidate.shopifyEventHandleSnapshot === input.packMeterHandle
            : candidateUsage !== undefined;
          const candidateCostAmount = candidateUsage?.costAmount ?? input.providerCostAmount;
          const candidateCostCurrency = candidateUsage?.costCurrency ?? input.providerCostCurrency;
          const exactProviderCost = parseProviderCost(candidateCostAmount);
          const beforeCost = new Prisma.Decimal(candidate.providerUsageCostBeforeSnapshot);
          const providerPurchaseAmount = exactProviderCost?.minus(beforeCost);
          const expectedQuantity = new Prisma.Decimal(candidate.providerUsageQuantityBeforeSnapshot).plus(1);
          const proven = hasExactProviderUsage
            && candidateUnits !== null
            && input.providerSubscriptionId !== null
            && candidate.providerSubscriptionIdSnapshot === input.providerSubscriptionId
            && candidate.shopifyPlanHandleSnapshot === input.providerPlanHandle
            && candidateCostCurrency !== null
            && candidateCostCurrency === candidate.providerUsageCostCurrencyBeforeSnapshot
            && exactProviderCost !== null
            && providerPurchaseAmount !== undefined
            && providerPurchaseAmount.gte(0)
            && new Prisma.Decimal(candidateUnits).equals(expectedQuantity)
            && (input.currentPeriodStart === undefined || (
              candidate.billingPeriod?.periodStart.getTime() === input.currentPeriodStart?.getTime()
              && candidate.billingPeriod?.periodEnd.getTime() === input.currentPeriodEnd?.getTime()
            ));
          if (!proven) {
            failedProof = true;
            continue;
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
              providerUsageQuantityAfterSnapshot: candidateUnits,
              providerUsageCostAfterSnapshot: exactProviderCost,
              providerUsageCostCurrencyAfterSnapshot: candidateCostCurrency,
              providerPurchaseAmount,
              providerPurchaseCurrency: candidateCostCurrency,
              providerValuationConfirmedAt: this.now(),
              currentAmount: candidate.creditsGranted,
              status: RecoveryCreditPurchaseStatus.ACTIVE,
              activatedAt: this.now(),
              version: { increment: 1 },
            },
          });
          if (activated.count !== 1) {
            failedProof = true;
            continue;
          }
          activatedCount += 1;
          grantedQuantity += candidate.creditsGranted;
        }
        if (grantedQuantity > 0) {
          await transaction.shopEntitlementCounter.upsert({
            where: { shopId_counter: { shopId: input.shopId, counter: "PURCHASED_RECOVERY_CREDITS" } },
            create: {
              shopId: input.shopId,
              counter: "PURCHASED_RECOVERY_CREDITS",
              grantedQuantity,
            },
            update: {
              grantedQuantity: { increment: grantedQuantity },
              version: { increment: 1 },
            },
          });
        }
        return {
          activatedCount,
          alreadyMatchedUnits,
          eligibleCandidateCount: candidates.length,
          confirmedDelta: activatedCount,
          discrepancy: failedProof
            ? discrepancy("ambiguous", "Provider subscription, quantity, cost, or currency does not prove this purchase")
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
  if (parseProviderQuantity(input.providerUsageQuantityBeforeSnapshot) === null) {
    throw new Error("Recovery credit purchase provider quantity snapshot must be a finite non-negative amount");
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

function parseProviderQuantity(value: number | string | Prisma.Decimal): Prisma.Decimal | null {
  try {
    const quantity = new Prisma.Decimal(value);
    return quantity.isFinite() && quantity.gte(0) ? quantity : null;
  } catch {
    return null;
  }
}

function isRetryableConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2002" || error.code === "P2034");
}

export const recoveryCreditPurchaseService = new RecoveryCreditPurchaseService();
