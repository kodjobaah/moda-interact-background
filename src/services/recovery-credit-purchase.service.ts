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
const DEFAULT_RECONCILIATION_LIMIT = 50;
const MAX_RECONCILIATION_LIMIT = 200;

type PurchaseDatabase = Pick<
  PrismaClient,
  "$transaction" | "recoveryCreditPurchase" | "shopEntitlementCounter" | "usageEvent"
>;

type PurchaseActivationResult =
  | { kind: "activated"; creditsGranted: number }
  | { kind: "already-active"; creditsGranted: number }
  | { kind: "pending" }
  | { kind: "needs-attention" }
  | { kind: "not-found" }
  | { kind: "cancelled" };

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

  async activateFromUsageEvent(purchaseId: string): Promise<PurchaseActivationResult> {
    return this.withRetry(() =>
      this.database.$transaction(async (transaction) => {
        const purchase = await transaction.recoveryCreditPurchase.findUnique({
          where: { id: purchaseId },
          select: {
            shopId: true,
            creditsGranted: true,
            status: true,
            usageEvent: { select: { shopifyReportState: true } },
          },
        });
        if (!purchase) return { kind: "not-found" };
        if (purchase.status === RecoveryCreditPurchaseStatus.CANCELLED) return { kind: "cancelled" };
        if (purchase.status === RecoveryCreditPurchaseStatus.ACTIVE) {
          return { kind: "already-active", creditsGranted: purchase.creditsGranted };
        }

        if (purchase.usageEvent.shopifyReportState === ShopifyReportState.NEEDS_ATTENTION) {
          await transaction.recoveryCreditPurchase.updateMany({
            where: {
              id: purchaseId,
              status: {
                in: [
                  RecoveryCreditPurchaseStatus.PENDING_BILLING,
                  RecoveryCreditPurchaseStatus.NEEDS_ATTENTION,
                ],
              },
            },
            data: { status: RecoveryCreditPurchaseStatus.NEEDS_ATTENTION },
          });
          return { kind: "needs-attention" };
        }

        if (purchase.usageEvent.shopifyReportState !== ShopifyReportState.REPORTED) {
          if (purchase.status === RecoveryCreditPurchaseStatus.NEEDS_ATTENTION) {
            await transaction.recoveryCreditPurchase.updateMany({
              where: { id: purchaseId, status: RecoveryCreditPurchaseStatus.NEEDS_ATTENTION },
              data: { status: RecoveryCreditPurchaseStatus.PENDING_BILLING },
            });
          }
          return { kind: "pending" };
        }

        const activated = await transaction.recoveryCreditPurchase.updateMany({
          where: {
            id: purchaseId,
            status: {
              in: [
                RecoveryCreditPurchaseStatus.PENDING_BILLING,
                RecoveryCreditPurchaseStatus.NEEDS_ATTENTION,
              ],
            },
          },
          data: {
            status: RecoveryCreditPurchaseStatus.ACTIVE,
            activatedAt: this.now(),
          },
        });
        if (activated.count !== 1) {
          const current = await transaction.recoveryCreditPurchase.findUnique({
            where: { id: purchaseId },
            select: { status: true, creditsGranted: true },
          });
          return current?.status === RecoveryCreditPurchaseStatus.ACTIVE
            ? { kind: "already-active", creditsGranted: current.creditsGranted }
            : { kind: "pending" };
        }

        const counter = await transaction.shopEntitlementCounter.upsert({
          where: {
            shopId_counter: {
              shopId: purchase.shopId,
              counter: "PURCHASED_RECOVERY_CREDITS",
            },
          },
          create: {
            shopId: purchase.shopId,
            counter: "PURCHASED_RECOVERY_CREDITS",
            grantedQuantity: purchase.creditsGranted,
          },
          update: {
            grantedQuantity: { increment: purchase.creditsGranted },
            version: { increment: 1 },
          },
        });
        void counter;
        return { kind: "activated", creditsGranted: purchase.creditsGranted };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
    );
  }

  async activateForUsageEvent(usageEventId: string): Promise<PurchaseActivationResult> {
    const purchase = await this.database.recoveryCreditPurchase.findUnique({
      where: { usageEventId },
      select: { id: true },
    });
    if (!purchase) return { kind: "not-found" };
    return this.activateFromUsageEvent(purchase.id);
  }

  async reconcilePending(limit = DEFAULT_RECONCILIATION_LIMIT) {
    const boundedLimit = Math.min(
      Math.max(Number.isInteger(limit) ? limit : DEFAULT_RECONCILIATION_LIMIT, 1),
      MAX_RECONCILIATION_LIMIT,
    );
    const baseWhere: Prisma.RecoveryCreditPurchaseWhereInput = {
      status: {
        in: [
          RecoveryCreditPurchaseStatus.PENDING_BILLING,
          RecoveryCreditPurchaseStatus.NEEDS_ATTENTION,
        ],
      },
    };
    const orderBy: Prisma.RecoveryCreditPurchaseOrderByWithRelationInput[] = [
      { createdAt: "asc" },
      { id: "asc" },
    ];
    const select = { id: true } as const;
    const terminalStates = [
      ShopifyReportState.REPORTED,
      ShopifyReportState.NEEDS_ATTENTION,
    ];
    const nonTerminalStates = [
      ShopifyReportState.PENDING,
      ShopifyReportState.IN_FLIGHT,
      ShopifyReportState.RETRYABLE,
    ];
    const terminalPurchases = await this.database.recoveryCreditPurchase.findMany({
      where: {
        ...baseWhere,
        usageEvent: { shopifyReportState: { in: terminalStates } },
      },
      orderBy,
      take: boundedLimit,
      select,
    });
    const remaining = boundedLimit - terminalPurchases.length;
    const purchases = remaining > 0
      ? [
          ...terminalPurchases,
          ...(await this.database.recoveryCreditPurchase.findMany({
            where: {
              ...baseWhere,
              usageEvent: { shopifyReportState: { in: nonTerminalStates } },
            },
            orderBy,
            take: remaining,
            select,
          })),
        ]
      : terminalPurchases;

    const results = [];
    for (const purchase of purchases) {
      results.push({ id: purchase.id, result: await this.activateFromUsageEvent(purchase.id) });
    }
    return results;
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
