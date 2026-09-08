import {
  Prisma,
  ShopifyReportState,
  UsageMetric,
} from "@prisma/client";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import type { PrismaClient } from "@prisma/client";

import prisma from "../lib/db.js";
import {
  ShopifyAppEventsError,
  ShopifyAppEventsClient,
  readShopifyAppEventsConfig,
} from "../providers/shopify-app-events.provider.js";
import { recoveryCreditPurchaseService } from "./recovery-credit-purchase.service.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;
const IN_FLIGHT_RECOVERY_MS = 15 * 60_000;
const MAX_RESPONSE_SUMMARY_LENGTH = 2000;
const logger = createLogger({
  serviceName: "moda-shopify-event-worker",
  environment: process.env.NODE_ENV ?? "development",
});

type UsageEventRecord = {
  id: string;
  shopId: string;
  quantity: Prisma.Decimal;
  occurredAt: Date;
  shopifyEventHandle: string | null;
  shopifyIdempotencyKey: string | null;
  shopifyReportState: ShopifyReportState;
  metric: UsageMetric;
  reportAttemptCount: number;
  nextReportAt: Date | null;
  lastReportAttemptAt: Date | null;
  shop: { shopifyShopId: string | null; status: "ACTIVE" | "UNINSTALLED" | "SUSPENDED"; uninstalledAt: Date | null };
};

type PublisherDatabase = Pick<PrismaClient, "$transaction" | "usageEvent">;
type BillingEventClient = Pick<ShopifyAppEventsClient, "createBillingEvent">;
type RecoveryCreditPurchaseActivator = Pick<typeof recoveryCreditPurchaseService, "activateForUsageEvent">;

export type ShopifyUsageEventPublisherResult = {
  selected: number;
  claimed: number;
  reported: number;
  retryable: number;
  needsAttention: number;
};

export class ShopifyUsageEventPublisherService {
  private defaultProvider: BillingEventClient | undefined;

  constructor(
    private readonly database: PublisherDatabase = prisma,
    private readonly provider: BillingEventClient | undefined = undefined,
    private readonly now: () => Date = () => new Date(),
    private readonly pageSize = DEFAULT_PAGE_SIZE,
    private readonly createProvider: () => BillingEventClient = createDefaultClient,
    private readonly recoveryCreditPurchaseActivator: RecoveryCreditPurchaseActivator = recoveryCreditPurchaseService,
  ) {}

  async publishDue(): Promise<ShopifyUsageEventPublisherResult> {
    const now = this.now();
    const pageSize = boundedPageSize(this.pageSize);
    await this.recoverStaleClaims(now);

    const dueWhere = {
      shopifyReportState: {
        in: [ShopifyReportState.PENDING, ShopifyReportState.RETRYABLE],
      },
      OR: [
        { nextReportAt: null },
        { nextReportAt: { lte: now } },
      ],
    };
    const select = {
      id: true,
      shopId: true,
      quantity: true,
      occurredAt: true,
      shopifyEventHandle: true,
      shopifyIdempotencyKey: true,
      shopifyReportState: true,
      metric: true,
      reportAttemptCount: true,
      nextReportAt: true,
      lastReportAttemptAt: true,
      shop: { select: { shopifyShopId: true, status: true, uninstalledAt: true } },
    } as const;
    const uninstallRows = await this.database.usageEvent.findMany({
      where: { ...dueWhere, shop: { status: "UNINSTALLED" } },
      orderBy: [
        { nextReportAt: "asc" },
        { occurredAt: "asc" },
        { id: "asc" },
      ],
      take: pageSize,
      select,
    });
    const ordinaryRows = uninstallRows.length >= pageSize
      ? []
      : await this.database.usageEvent.findMany({
      where: { ...dueWhere, shop: { status: { not: "UNINSTALLED" } } },
      orderBy: [
        { nextReportAt: "asc" },
        { occurredAt: "asc" },
        { id: "asc" },
      ],
      take: pageSize - uninstallRows.length,
      select,
    });
    const rows = [...uninstallRows, ...ordinaryRows];

    const result: ShopifyUsageEventPublisherResult = {
      selected: rows.length,
      claimed: 0,
      reported: 0,
      retryable: 0,
      needsAttention: 0,
    };

    for (const row of rows) {
      const claimed = await this.claim(row, now);
      if (!claimed) continue;
      result.claimed += 1;

      const invalidReason = validateReportableUsage(row);
      if (invalidReason) {
        await this.markNeedsAttention(row.id, "invalid-reportable-usage", invalidReason);
        result.needsAttention += 1;
        continue;
      }

      try {
        const provider = this.getProvider();
        await provider.createBillingEvent({
          shopId: row.shop.shopifyShopId!,
          eventHandle: row.shopifyEventHandle!,
          occurredAt: row.occurredAt.toISOString(),
          idempotencyKey: row.shopifyIdempotencyKey!,
          value: Number(row.quantity),
        });
        await this.markReported(row.id, now);
        result.reported += 1;
        try {
          await this.activateRecoveryCreditPurchase(row);
        } catch (activationError) {
          logger.error("billing.recovery_credit.activation_failed", {
            usageEventId: row.id,
            error: activationError,
          });
        }
      } catch (error) {
        if (isRetryable(error)) {
          await this.markRetryable(row, error, now);
          result.retryable += 1;
        } else {
          await this.markNeedsAttention(row.id, errorCode(error), errorSummary(error));
          result.needsAttention += 1;
        }
      }
    }

    return result;
  }

  private async activateRecoveryCreditPurchase(row: UsageEventRecord): Promise<void> {
    if (row.metric !== UsageMetric.RECOVERY_CREDIT_PACK_PURCHASE) return;
    await this.recoveryCreditPurchaseActivator.activateForUsageEvent(row.id);
  }

  private async claim(row: UsageEventRecord, now: Date): Promise<boolean> {
    const updated = await this.database.usageEvent.updateMany({
      where: {
        id: row.id,
        shopifyReportState: {
          in: [ShopifyReportState.PENDING, ShopifyReportState.RETRYABLE],
        },
        OR: [
          { nextReportAt: null },
          { nextReportAt: { lte: now } },
        ],
      },
      data: {
        shopifyReportState: ShopifyReportState.IN_FLIGHT,
        reportAttemptCount: { increment: 1 },
        lastReportAttemptAt: now,
        providerErrorCode: null,
        providerResponseSummary: null,
      },
    });
    return updated.count === 1;
  }

  private getProvider(): BillingEventClient {
    if (this.provider) return this.provider;
    this.defaultProvider ??= this.createProvider();
    return this.defaultProvider;
  }

  private async recoverStaleClaims(now: Date): Promise<void> {
    await this.database.usageEvent.updateMany({
      where: {
        shopifyReportState: ShopifyReportState.IN_FLIGHT,
        lastReportAttemptAt: {
          lte: new Date(now.getTime() - IN_FLIGHT_RECOVERY_MS),
        },
      },
      data: {
        shopifyReportState: ShopifyReportState.RETRYABLE,
        nextReportAt: now,
        providerErrorCode: "stale-in-flight-recovered",
        providerResponseSummary: "Recovered an unfinished publisher claim",
      },
    });
  }

  private async markReported(id: string, now: Date): Promise<void> {
    const updated = await this.database.usageEvent.updateMany({
      where: { id, shopifyReportState: ShopifyReportState.IN_FLIGHT },
      data: {
        shopifyReportState: ShopifyReportState.REPORTED,
        reportedAt: now,
        nextReportAt: null,
        providerErrorCode: null,
        providerResponseSummary: "reported",
      },
    });
    if (updated.count !== 1) {
      throw new Error("UsageEvent report state changed before it was marked reported");
    }
  }

  private async markRetryable(
    row: UsageEventRecord,
    error: unknown,
    now: Date,
  ): Promise<void> {
    const delay = Math.min(
      RETRY_MAX_MS,
      RETRY_BASE_MS * 2 ** row.reportAttemptCount,
    );
    await this.database.usageEvent.updateMany({
      where: { id: row.id, shopifyReportState: ShopifyReportState.IN_FLIGHT },
      data: {
        shopifyReportState: ShopifyReportState.RETRYABLE,
        nextReportAt: new Date(now.getTime() + delay),
        providerErrorCode: errorCode(error),
        providerResponseSummary: errorSummary(error),
      },
    });
  }
  private async markNeedsAttention(
    id: string,
    code: string,
    summary: string,
  ): Promise<void> {
    await this.database.usageEvent.updateMany({
      where: { id, shopifyReportState: ShopifyReportState.IN_FLIGHT },
      data: {
        shopifyReportState: ShopifyReportState.NEEDS_ATTENTION,
        nextReportAt: null,
        providerErrorCode: code,
        providerResponseSummary: summary,
      },
    });
  }
}

function createDefaultClient(): BillingEventClient {
  return new ShopifyAppEventsClient(readShopifyAppEventsConfig());
}

function boundedPageSize(value: number): number {
  if (!Number.isInteger(value) || value < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(value, MAX_PAGE_SIZE);
}

function validateReportableUsage(row: UsageEventRecord): string | null {
  if (row.shop.status !== "ACTIVE" && (!row.shop.uninstalledAt || row.occurredAt > row.shop.uninstalledAt)) {
    return "Usage event is after the shop uninstall cutoff";
  }
  if (!row.shop.shopifyShopId?.trim()) return "Shop has no Shopify shop GID";
  if (!row.shopifyEventHandle?.trim()) return "Usage event handle is missing";
  if (!row.shopifyIdempotencyKey?.trim()) return "Shopify idempotency key is missing";
  const quantity = Number(row.quantity);
  if (!Number.isInteger(quantity) || quantity === 0) {
    return "Usage quantity must be a non-zero integer";
  }
  return null;
}

function isRetryable(error: unknown): boolean {
  return error instanceof ShopifyAppEventsError
    ? error.retryable
    : true;
}

function errorCode(error: unknown): string {
  if (error instanceof ShopifyAppEventsError) return error.kind;
  return "unknown-provider-error";
}

function errorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_RESPONSE_SUMMARY_LENGTH);
}

export const shopifyUsageEventPublisherService =
  new ShopifyUsageEventPublisherService();