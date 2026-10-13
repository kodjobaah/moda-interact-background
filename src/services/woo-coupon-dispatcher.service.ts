import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import { loadWooCouponSyncConfig, type WooCouponSyncConfig } from "./woo-coupon-sync-config.js";

import prisma from "../lib/db.js";

/**
 * ARCH-036: a single globally leased dispatcher, not one recurring timer per shop.
 * The dispatcher only reserves shops and publishes jobs; it never calls WooCommerce.
 * It must not be wired into an entrypoint until the consumer is implemented.
 */
export const WOO_COUPON_SYNC_QUEUE_NAME = "woo-coupon-sync";
export const WOO_COUPON_SYNC_JOB_NAME = "sync-woo-coupons";

const logger = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});

type DispatchDatabase = Pick<PrismaClient, "shop" | "shopifyDiscountCatalogue" | "$queryRaw">;
type DispatchQueue = Pick<Queue, "addBulk">;
type ReservedShop = { shopId: string; requestedAt: Date };

export interface WooCouponDispatchResult {
  cataloguesCreated: number;
  shopsReserved: number;
  jobsPublished: number;
}
type DueBacklog = { backlog: number; oldestDueSeconds: number | null };

/**
 * Deterministic identity for ONE PostgreSQL dispatch reservation. A later
 * reservation for the same shop must have a different BullMQ ID even if an
 * older job is still waiting; retries of the same reservation keep the ID.
 * Only internal shop identity and the canonical reservation timestamp are hashed.
 */
export function createWooCouponJobId(shopId: string, requestedAt: string): string {
  return `woo-coupon-${createHash("sha256")
    .update(JSON.stringify([shopId, requestedAt]), "utf8").digest("hex")}`;
}

/**
 * Redis publication deliberately happens after the DB claim commits.
 * If Redis fails, syncRequestedAt gates immediate redispatch and permits recovery
 * when REQUEST_COOLDOWN_MINUTES has elapsed. The consumer also fences its own
 * scan with activeSyncToken + syncGeneration; this reservation is not that lease.
 */
export class WooCouponDispatcherService {
  constructor(
    private readonly database: DispatchDatabase = prisma,
    private readonly queue?: DispatchQueue,
    private readonly settings: WooCouponSyncConfig = loadWooCouponSyncConfig(),
    private readonly reporting: Pick<StructuredLogger, "info" | "warn"> = logger,
  ) {}

  async dispatch(batchSize = this.settings.dispatchBatchSize): Promise<WooCouponDispatchResult> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > this.settings.dispatchBatchSize) {
      throw new RangeError(`Woo coupon dispatch batchSize must be between 1 and ${this.settings.dispatchBatchSize}`);
    }
    if (!this.queue) throw new Error("Woo coupon sync queue has not been configured");

    // Installation discovery does NOT require an ACTIVE read grant. The future
    // worker checks the grant each time it processes the shop.
    const missing = await this.database.shop.findMany({
      where: {
        platform: "WOOCOMMERCE",
        status: "ACTIVE",
        wooCommerceInstallation: { is: { status: "ACTIVE", revokedAt: null } },
        discountCatalogue: { is: null },
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: batchSize,
    });
    const created = missing.length > 0
      ? await this.database.shopifyDiscountCatalogue.createMany({
          data: missing.map((shop) => ({ shopId: shop.id, status: "SYNC_REQUIRED" as const })),
          skipDuplicates: true,
        })
      : { count: 0 };

    // Claim a bounded, fair batch atomically. A competing dispatcher, a retry,
    // or a superseded global lease holder cannot reserve the same rows at once.
    // PostgreSQL uses its own NOW(), avoiding clock skew between instances.
    const reserved = await this.database.$queryRaw<ReservedShop[]>(Prisma.sql`
      WITH due AS (
        SELECT c."shopId"
        FROM "shopify"."ShopifyDiscountCatalogue" AS c
        JOIN "commerce"."Shop" AS s ON s."id" = c."shopId"
        JOIN "woocommerce"."WooCommerceInstallation" AS i ON i."shopId" = c."shopId"
        WHERE s."platform" = 'WOOCOMMERCE'
          AND s."status" = 'ACTIVE'
          AND i."status" = 'ACTIVE'
          AND i."revokedAt" IS NULL
          AND (c."lastSuccessfulSyncAt" IS NULL
            OR c."lastSuccessfulSyncAt" <= NOW() - (${this.settings.refreshIntervalMinutes} * INTERVAL '1 minute'))
          AND (c."syncRequestedAt" IS NULL
            OR c."syncRequestedAt" <= NOW() - (${this.settings.dispatchCooldownMinutes} * INTERVAL '1 minute'))
          AND (c."status" <> 'UNAVAILABLE'
            OR c."lastErrorAt" IS NULL
            OR c."lastErrorAt" <= NOW() - (${this.settings.unavailableRecheckMinutes} * INTERVAL '1 minute'))
          AND (c."status" <> 'SYNCING'
            OR c."syncStartedAt" IS NULL
            OR c."syncStartedAt" <= NOW() - (${this.settings.staleScanMinutes} * INTERVAL '1 minute'))
        ORDER BY c."lastSuccessfulSyncAt" ASC NULLS FIRST,
          c."syncRequestedAt" ASC NULLS FIRST, c."shopId" ASC
        LIMIT ${batchSize}
        FOR UPDATE OF c SKIP LOCKED
      )
      UPDATE "shopify"."ShopifyDiscountCatalogue" AS c
      SET "syncRequestedAt" = NOW(), "updatedAt" = NOW()
      FROM due
      WHERE c."shopId" = due."shopId"
      RETURNING c."shopId", c."syncRequestedAt" AS "requestedAt"
    `);

    let jobsPublished = 0;
    try {
      if (reserved.length > 0) {
        await this.queue.addBulk(reserved.map(({ shopId, requestedAt }) => ({
        name: WOO_COUPON_SYNC_JOB_NAME,
        data: { shopId, requestedAt: requestedAt.toISOString() },
        opts: {
          jobId: createWooCouponJobId(shopId, requestedAt.toISOString()),
          attempts: 3,
          backoff: { type: "exponential" as const, delay: 30_000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      })));
        jobsPublished = reserved.length;
      }
    } finally {
      // Operational reporting must never become a database/queue correctness dependency.
      await this.reportCycle(created.count, missing.length, reserved.length, jobsPublished);
    }

    return { cataloguesCreated: created.count, shopsReserved: reserved.length, jobsPublished };
  }

  private async reportCycle(created: number, discovered: number, reserved: number, published: number): Promise<void> {
    let backlog: number | null = null;
    let oldestDueSeconds: number | null = null;
    try {
      const rows = await this.database.$queryRaw<DueBacklog[]>(Prisma.sql`
        SELECT COUNT(*)::integer AS "backlog",
          EXTRACT(EPOCH FROM (NOW() - MIN(COALESCE(c."lastSuccessfulSyncAt", c."createdAt"))))::double precision AS "oldestDueSeconds"
        FROM "shopify"."ShopifyDiscountCatalogue" c
        JOIN "commerce"."Shop" s ON s."id" = c."shopId"
        JOIN "woocommerce"."WooCommerceInstallation" i ON i."shopId" = c."shopId"
        WHERE s."platform" = 'WOOCOMMERCE' AND s."status" = 'ACTIVE'
          AND i."status" = 'ACTIVE' AND i."revokedAt" IS NULL
          AND (c."lastSuccessfulSyncAt" IS NULL OR
            c."lastSuccessfulSyncAt" <= NOW() - (${this.settings.refreshIntervalMinutes} * INTERVAL '1 minute'))
          AND (c."syncRequestedAt" IS NULL OR
            c."syncRequestedAt" <= NOW() - (${this.settings.dispatchCooldownMinutes} * INTERVAL '1 minute'))
          AND (c."status" <> 'UNAVAILABLE' OR c."lastErrorAt" IS NULL OR
            c."lastErrorAt" <= NOW() - (${this.settings.unavailableRecheckMinutes} * INTERVAL '1 minute'))
          AND (c."status" <> 'SYNCING' OR c."syncStartedAt" IS NULL OR
            c."syncStartedAt" <= NOW() - (${this.settings.staleScanMinutes} * INTERVAL '1 minute'))
      `);
      const value = rows[0];
      if (value && Number.isSafeInteger(value.backlog) && value.backlog >= 0) {
        backlog = value.backlog;
        oldestDueSeconds = value.oldestDueSeconds === null ? null :
          Number.isFinite(value.oldestDueSeconds) ? Math.max(0, Math.round(value.oldestDueSeconds)) : null;
      }
    } catch { /* Telemetry queries must not interrupt dispatch. */ }
    try {
      this.reporting.info("woo.coupon_sync.dispatch_cycle", {
        cataloguesCreated: created, discovered, scanned: reserved + (backlog ?? 0),
        due: reserved + (backlog ?? 0), reserved, published,
        skipped: backlog, backlog, oldestDueSeconds,
      });
    } catch { /* Logging failures are isolated from the business workflow. */ }
  }
}
