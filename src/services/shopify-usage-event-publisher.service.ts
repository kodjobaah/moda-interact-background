import {
  Prisma,
  ShopifyReportState,
  UsageMetric,
} from "@prisma/client";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import type { PrismaClient } from "@prisma/client";

import prisma from "../lib/db.js";
import type { BackgroundRuntimeConfigSnapshot } from "../runtime/background-runtime-config.js";
import {
  ShopifyAppEventsError,
  ShopifyAppEventsClient,
  readShopifyAppEventsConfig,
} from "../providers/shopify-app-events.provider.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const IN_FLIGHT_RECOVERY_MS = 15 * 60_000;
const MAX_RESPONSE_SUMMARY_LENGTH = 2000;
const logger = createLogger({
  serviceName: "moda-shopify-event-worker",
  environment: resolveDeploymentEnvironmentName(),
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

export type ShopifyUsageEventPublisherResult = {
  selected: number;
  claimed: number;
  reported: number;
  retryable: number;
  needsAttention: number;
};

export type ShopifyUsageEventPublishOptions = {
  billingPeriodId?: string;
  runtimeConfig?: Pick<BackgroundRuntimeConfigSnapshot, "shopifyUsagePublishBatchSize" | "shopifyUsageRetryBaseSeconds" | "shopifyUsageRetryMaxSeconds">;
};

export class ShopifyUsageEventPublisherService {
  private defaultProvider: BillingEventClient | undefined;

  constructor(
    private readonly database: PublisherDatabase = prisma,
    private readonly provider: BillingEventClient | undefined = undefined,
    private readonly now: () => Date = () => new Date(),
    private readonly pageSize = DEFAULT_PAGE_SIZE,
    private readonly createProvider: () => BillingEventClient = createDefaultClient,
  ) {}

  async publishDue(options: ShopifyUsageEventPublishOptions = {}): Promise<ShopifyUsageEventPublisherResult> {
    const now = this.now();
    const pageSize = boundedPageSize(options.runtimeConfig?.shopifyUsagePublishBatchSize ?? this.pageSize);
    const retryBaseMs = (options.runtimeConfig?.shopifyUsageRetryBaseSeconds ?? 60) * 1000;
    const retryMaxMs = (options.runtimeConfig?.shopifyUsageRetryMaxSeconds ?? 3600) * 1000;
    await this.recoverStaleClaims(now, options);

    const dueWhere = {
      ...(options.billingPeriodId ? { billingPeriodId: options.billingPeriodId } : {}),
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
        const quantity = new Prisma.Decimal(row.quantity);
        await provider.createBillingEvent({
          shopId: row.shop.shopifyShopId!,
          eventHandle: row.shopifyEventHandle!,
          occurredAt: row.occurredAt.toISOString(),
          idempotencyKey: row.shopifyIdempotencyKey!,
          value: quantity.isInteger() && quantity.abs().lte(Number.MAX_SAFE_INTEGER)
            ? quantity.toNumber()
            : quantity.toString(),
        });
        await this.markReported(row.id, now);
        result.reported += 1;
      } catch (error) {
        if (isRetryable(error)) {
          await this.markRetryable(row, error, now, retryBaseMs, retryMaxMs);
          result.retryable += 1;
        } else {
          await this.markNeedsAttention(row.id, errorCode(error), errorSummary(error));
          result.needsAttention += 1;
        }
      }
    }

    return result;
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

  private async recoverStaleClaims(now: Date, options: ShopifyUsageEventPublishOptions = {}): Promise<void> {
    await this.database.usageEvent.updateMany({
      where: {
        ...(options.billingPeriodId ? { billingPeriodId: options.billingPeriodId } : {}),
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
        providerResponseSummary: "submitted-to-shopify-app-events",
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
    retryBaseMs = 60_000,
    retryMaxMs = 60 * 60_000,
  ): Promise<void> {
    const delay = Math.min(
      retryMaxMs,
      retryBaseMs * 2 ** row.reportAttemptCount,
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
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new Error("Shopify usage publish batch size is outside the database range.");
  }
  return value;
}

function validateReportableUsage(row: UsageEventRecord): string | null {
  if (row.shop.status !== "ACTIVE" && (!row.shop.uninstalledAt || row.occurredAt > row.shop.uninstalledAt)) {
    return "Usage event is after the shop uninstall cutoff";
  }
  if (!row.shop.shopifyShopId?.trim()) return "Shop has no Shopify shop GID";
  if (!row.shopifyEventHandle?.trim()) return "Usage event handle is missing";
  if (!row.shopifyIdempotencyKey?.trim()) return "Shopify idempotency key is missing";
  const quantity = new Prisma.Decimal(row.quantity);
  if (!quantity.isFinite() || quantity.isZero()) {
    return "Usage quantity must be a finite non-zero decimal";
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