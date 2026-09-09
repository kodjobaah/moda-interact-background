import {
  Prisma,
  RecoveryCreditPurchaseStatus,
  ShopifyReportState,
  UsageMetric,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { createShopifyUsageIdempotencyKey } from "@modainteract/moda-interact-shared/billing";

import prisma from "../lib/db.js";

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
  providerUnits: number;
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
  planId: string | null;
  shopifyPlanHandleSnapshot: string;
  shopifyEventHandleSnapshot: string;
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
            shopifyPlanHandleSnapshot: input.shopifyPlanHandleSnapshot,
            shopifyEventHandleSnapshot: input.shopifyEventHandleSnapshot,
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

    return this.withRetry(() =>
      this.database.$transaction(async (transaction) => {
        const scope = {
          shopId: input.shopId,
          shopifyPlanHandleSnapshot: input.providerPlanHandle,
          shopifyEventHandleSnapshot: input.packMeterHandle,
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
            status: {
              in: [
                RecoveryCreditPurchaseStatus.PENDING_BILLING,
                RecoveryCreditPurchaseStatus.NEEDS_ATTENTION,
              ],
            },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, creditsGranted: true },
        });
        const confirmedDelta = input.providerUnits - alreadyMatchedUnits;
        const discrepancy = (kind: PurchaseReconciliationDiscrepancy["kind"], detail?: string): PurchaseReconciliationDiscrepancy => ({
          kind,
          ...input,
          alreadyMatchedUnits,
          eligibleCandidateCount: candidates.length,
          confirmedDelta,
          ...(detail ? { detail } : {}),
        });
        if (confirmedDelta <= 0 || candidates.length === 0) {
          return {
            activatedCount: 0,
            alreadyMatchedUnits,
            eligibleCandidateCount: candidates.length,
            confirmedDelta,
            discrepancy: confirmedDelta < 0
              ? discrepancy("under", "Provider quantity is below already matched local purchases")
              : candidates.length > 0 && confirmedDelta === 0
                ? null
                : input.providerUnits > alreadyMatchedUnits
                  ? discrepancy("over", "Provider units have no eligible local purchase")
                  : null,
          };
        }

        const selected = candidates.slice(0, confirmedDelta);
        const boundaryCandidate = candidates[confirmedDelta - 1];
        const nextCandidate = candidates[confirmedDelta];
        if (
          confirmedDelta < candidates.length &&
          (new Set(candidates.map((candidate) => candidate.creditsGranted)).size > 1 ||
            boundaryCandidate?.creditsGranted !== nextCandidate?.creditsGranted)
        ) {
          return {
            activatedCount: 0,
            alreadyMatchedUnits,
            eligibleCandidateCount: candidates.length,
            confirmedDelta,
            discrepancy: discrepancy("ambiguous", "Partial provider confirmation crosses non-equivalent credit packs"),
          };
        }

        let activatedCount = 0;
        for (const candidate of selected) {
          const activated = await transaction.recoveryCreditPurchase.updateMany({
            where: {
              id: candidate.id,
              status: {
                in: [
                  RecoveryCreditPurchaseStatus.PENDING_BILLING,
                  RecoveryCreditPurchaseStatus.NEEDS_ATTENTION,
                ],
              },
            },
            data: { status: RecoveryCreditPurchaseStatus.ACTIVE, activatedAt: this.now() },
          });
          if (activated.count !== 1) continue;
          activatedCount += 1;
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
        }
        return {
          activatedCount,
          alreadyMatchedUnits,
          eligibleCandidateCount: candidates.length,
          confirmedDelta,
          discrepancy: confirmedDelta > candidates.length
            ? discrepancy("over", "Provider units exceed eligible local purchases")
            : null,
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
    );
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
  if (!input.id || !input.shopId || !input.shopifyPlanHandleSnapshot || !input.shopifyEventHandleSnapshot) {
    throw new Error("Recovery credit purchase identity and Shopify handles are required");
  }
  if (!Number.isSafeInteger(input.creditsGranted) || input.creditsGranted <= 0) {
    throw new Error("Recovery credit purchase creditsGranted must be a positive safe integer");
  }
}

function isRetryableConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2002" || error.code === "P2034");
}

export const recoveryCreditPurchaseService = new RecoveryCreditPurchaseService();
