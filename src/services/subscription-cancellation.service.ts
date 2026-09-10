import {
  ARCH007_BILLING_CONTRACT_SCHEMA_VERSION,
  BILLING_SYSTEM_MESSAGE_CODES,
  createMerchantBillingSystemSourceKey,
  SHOPIFY_SUBSCRIPTION_CANCELLATION_ARGS,
  type SubscriptionCancellationMode,
} from "@modainteract/moda-interact-shared/billing";
import {
  MerchantSupportMessageKind,
  MerchantSupportMessageState,
  Prisma,
  SubscriptionCancellationStatus,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import prisma from "../lib/db.js";
import {
  shopifyPartnerBillingApi,
  type PartnerSubscription,
  type ShopifyPartnerBillingProvider,
  ShopifyPartnerBillingError,
} from "../providers/shopify-partner-billing.provider.js";

const DEFAULT_BATCH_SIZE = 25;
const LEASE_MS = 10 * 60_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;
const MAX_SUMMARY_LENGTH = 2000;

type CancellationDatabase = PrismaClient;
type CancellationRequest = Prisma.SubscriptionCancellationRequestGetPayload<{
  include: { shop: { select: { shopifyShopId: true } } };
}>;

export type CancellationRunResult = {
  scanned: number;
  claimed: number;
  completed: number;
  accepted: number;
  retryable: number;
  needsAttention: number;
};

export class SubscriptionCancellationService {
  constructor(
    private readonly database: CancellationDatabase = prisma,
    private readonly provider: ShopifyPartnerBillingProvider = shopifyPartnerBillingApi,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async processDue(limit = DEFAULT_BATCH_SIZE): Promise<CancellationRunResult> {
    const now = this.now();
    await this.recoverStale(now);
    const requests = await this.database.subscriptionCancellationRequest.findMany({
      where: {
        OR: [
          { status: SubscriptionCancellationStatus.APPROVED },
          {
            status: SubscriptionCancellationStatus.RETRYABLE,
            OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
          },
          { status: SubscriptionCancellationStatus.PROVIDER_ACCEPTED },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: boundedLimit(limit),
      include: { shop: { select: { shopifyShopId: true } } },
    });
    const result: CancellationRunResult = {
      scanned: requests.length,
      claimed: 0,
      completed: 0,
      accepted: 0,
      retryable: 0,
      needsAttention: 0,
    };
    for (const request of requests) {
      const claimed = await this.claim(request.id, request.version, request.status, now);
      if (!claimed) continue;
      result.claimed += 1;
      const outcome = await this.processClaimed(request, now);
      result[outcome] += 1;
    }
    return result;
  }

  private async processClaimed(
    request: CancellationRequest,
    now: Date,
  ): Promise<"completed" | "accepted" | "retryable" | "needsAttention"> {
    const shopifyShopId = request.shop.shopifyShopId;
    if (!shopifyShopId) return this.needsAttention(request, now, "SHOPIFY_SHOP_ID_MISSING", "Shop has no Shopify shop ID");
    try {
      const active = await this.provider.getActiveSubscription(shopifyShopId);
      if (request.providerAcceptedAt) {
        return this.confirm(request, active, now);
      }
      if (!active) {
        if (request.mode === "IMMEDIATE_NO_PRORATION" || request.mode === "IMMEDIATE_PRORATED" || request.mode === "IMMEDIATE_SKIP_FINAL_USAGE") {
          return this.complete(request, now);
        }
        return this.needsAttention(request, now, "SUBSCRIPTION_NOT_CONFIRMED", "End-of-cycle cancellation has no active subscription to verify");
      }
      const identityIssue = verifyIdentity(request, active);
      if (identityIssue) return this.needsAttention(request, now, "SUBSCRIPTION_IDENTITY_CHANGED", identityIssue);
      if (request.mode === "END_OF_CYCLE" && active.cancelAtPeriodEnd) {
        return this.complete(request, now);
      }
      const accepted = await this.provider.cancelSubscription({ shopifyShopId, mode: request.mode as SubscriptionCancellationMode });
      const updated = await this.database.subscriptionCancellationRequest.updateMany({
        where: { id: request.id, version: request.version + 1, status: SubscriptionCancellationStatus.PROCESSING },
        data: {
          status: SubscriptionCancellationStatus.PROVIDER_ACCEPTED,
          providerAcceptedAt: now,
          providerErrorCode: null,
          providerResponseSummary: accepted.summary.slice(0, MAX_SUMMARY_LENGTH),
          processingStartedAt: null,
          nextAttemptAt: null,
        },
      });
      return updated.count === 1 ? "accepted" : "retryable";
    } catch (error) {
      if (isRetryable(error)) return this.retry(request, now, error);
      return this.needsAttention(request, now, errorCode(error), errorSummary(error));
    }
  }

  private async confirm(
    request: CancellationRequest,
    active: PartnerSubscription | null,
    now: Date,
  ): Promise<"completed" | "retryable" | "needsAttention"> {
    if (!active && request.mode !== "END_OF_CYCLE") return this.complete(request, now);
    if (active && verifyIdentity(request, active)) {
      return this.needsAttention(request, now, "SUBSCRIPTION_IDENTITY_CHANGED", "Provider confirmation no longer matches the approved subscription");
    }
    if (active && request.mode === "END_OF_CYCLE" && active.cancelAtPeriodEnd) return this.complete(request, now);
    return this.retry(request, now, new Error("Provider cancellation has not reached the required confirmation state"));
  }

  private async claim(
    id: string,
    version: number,
    status: SubscriptionCancellationStatus,
    now: Date,
  ): Promise<boolean> {
    const updated = await this.database.subscriptionCancellationRequest.updateMany({
      where: {
        id,
        version,
        status,
      },
      data: {
        status: SubscriptionCancellationStatus.PROCESSING,
        processingStartedAt: now,
        lastAttemptAt: now,
        attemptCount: { increment: 1 },
        version: { increment: 1 },
      },
    });
    return updated.count === 1;
  }

  private async recoverStale(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - LEASE_MS);
    await this.database.subscriptionCancellationRequest.updateMany({
      where: { status: SubscriptionCancellationStatus.PROCESSING, processingStartedAt: { lte: cutoff }, providerAcceptedAt: null },
      data: { status: SubscriptionCancellationStatus.RETRYABLE, processingStartedAt: null, nextAttemptAt: now, providerErrorCode: "STALE_PROCESSING_LEASE", version: { increment: 1 } },
    });
    await this.database.subscriptionCancellationRequest.updateMany({
      where: { status: SubscriptionCancellationStatus.PROCESSING, processingStartedAt: { lte: cutoff }, providerAcceptedAt: { not: null } },
      data: { status: SubscriptionCancellationStatus.PROVIDER_ACCEPTED, processingStartedAt: null, nextAttemptAt: now, version: { increment: 1 } },
    });
  }

  private async complete(request: CancellationRequest, now: Date): Promise<"completed" | "retryable" | "needsAttention"> {
    return this.database.$transaction(async (transaction) => {
      const updated = await transaction.subscriptionCancellationRequest.updateMany({
        where: { id: request.id, version: request.version + 1, status: SubscriptionCancellationStatus.PROCESSING },
        data: { status: SubscriptionCancellationStatus.COMPLETED, completedAt: now, processingStartedAt: null, nextAttemptAt: null, providerErrorCode: null, providerResponseSummary: null },
      });
      if (updated.count !== 1) return "retryable";
      const thread = await transaction.merchantSupportThread.upsert({ where: { shopId: request.shopId }, create: { shopId: request.shopId }, update: {} });
      const sourceKey = createMerchantBillingSystemSourceKey(request.shopId, BILLING_SYSTEM_MESSAGE_CODES.CANCELLATION_COMPLETED, request.id, ARCH007_BILLING_CONTRACT_SCHEMA_VERSION);
      await transaction.merchantSupportMessage.upsert({
        where: { sourceKey },
        create: {
          threadId: thread.id,
          kind: MerchantSupportMessageKind.SYSTEM,
          state: MerchantSupportMessageState.AVAILABLE,
          originalBody: "Your subscription cancellation is complete.",
          sourceLanguageTag: "en-GB",
          systemCode: BILLING_SYSTEM_MESSAGE_CODES.CANCELLATION_COMPLETED,
          systemVersion: String(ARCH007_BILLING_CONTRACT_SCHEMA_VERSION),
          sourceKey,
          availableAt: now,
        },
        update: {},
      });
      return "completed";
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async retry(request: CancellationRequest, now: Date, error: unknown): Promise<"retryable"> {
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(request.attemptCount - 1, 0));
    await this.database.subscriptionCancellationRequest.updateMany({
      where: { id: request.id, version: request.version + 1, status: SubscriptionCancellationStatus.PROCESSING },
      data: { status: SubscriptionCancellationStatus.RETRYABLE, processingStartedAt: null, nextAttemptAt: new Date(now.getTime() + delay), providerErrorCode: errorCode(error), providerResponseSummary: errorSummary(error) },
    });
    return "retryable";
  }

  private async needsAttention(request: CancellationRequest, now: Date, code: string, summary: string): Promise<"needsAttention"> {
    await this.database.subscriptionCancellationRequest.updateMany({
      where: { id: request.id, version: request.version + 1, status: SubscriptionCancellationStatus.PROCESSING },
      data: { status: SubscriptionCancellationStatus.NEEDS_ATTENTION, processingStartedAt: null, nextAttemptAt: null, providerErrorCode: code, providerResponseSummary: summary.slice(0, MAX_SUMMARY_LENGTH) },
    });
    return "needsAttention";
  }
}

function boundedLimit(value: number): number {
  return Number.isInteger(value) && value > 0 ? Math.min(value, DEFAULT_BATCH_SIZE) : DEFAULT_BATCH_SIZE;
}

function verifyIdentity(request: { providerSubscriptionIdSnapshot: string; planHandleSnapshot: string }, active: PartnerSubscription): string | null {
  if (active.providerSubscriptionId !== request.providerSubscriptionIdSnapshot) return "Provider subscription identity differs from the approved snapshot";
  if (active.planHandle !== request.planHandleSnapshot) return "Provider plan identity differs from the approved snapshot";
  return null;
}

function isRetryable(error: unknown): boolean {
  return error instanceof ShopifyPartnerBillingError ? error.retryable : true;
}

function errorCode(error: unknown): string {
  return error instanceof ShopifyPartnerBillingError ? error.code : "unknown-provider-error";
}

function errorSummary(error: unknown): string {
  const summary = error instanceof Error ? error.message : String(error);
  return summary
    .replace(/((?:access[_ -]?token|authorization|bearer)\s*[:=]?\s*)(\S+)/gi, "$1[REDACTED]")
    .slice(0, MAX_SUMMARY_LENGTH);
}

export const subscriptionCancellationService = new SubscriptionCancellationService();