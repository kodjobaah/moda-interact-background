import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";

import prisma from "../lib/db.js";

/**
 * ARCH-036: a single globally leased dispatcher, not one recurring timer per shop.
 * The dispatcher only reserves shops and publishes jobs; it never calls WooCommerce.
 * It must not be wired into an entrypoint until the consumer is implemented.
 */
export const WOO_COUPON_SYNC_QUEUE_NAME = "woo-coupon-sync";
export const WOO_COUPON_SYNC_JOB_NAME = "sync-woo-coupons";

const MAX_BATCH_SIZE = 500;
const INITIAL_BATCH_SIZE = 500;
const REQUEST_COOLDOWN_MINUTES = 5;
const REFRESH_INTERVAL_MINUTES = 30;
const UNAVAILABLE_RECHECK_MINUTES = 30;
const STALE_SCAN_MINUTES = 15;

type DispatchDatabase = Pick<PrismaClient, "shop" | "shopifyDiscountCatalogue" | "$queryRaw">;
type DispatchQueue = Pick<Queue, "addBulk">;
type ReservedShop = { shopId: string; requestedAt: Date };

export interface WooCouponDispatchResult {
  cataloguesCreated: number;
  shopsReserved: number;
  jobsPublished: number;
}

/** Stable, bounded BullMQ identity. Never place a site URL or credentials in a job ID. */
export function createWooCouponJobId(shopId: string): string {
  return `woo-coupon-${createHash("sha256").update(shopId, "utf8").digest("hex")}`;
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
  ) {}

  async dispatch(batchSize = INITIAL_BATCH_SIZE): Promise<WooCouponDispatchResult> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
      throw new RangeError(`Woo coupon dispatch batchSize must be between 1 and ${MAX_BATCH_SIZE}`);
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
            OR c."lastSuccessfulSyncAt" <= NOW() - (${REFRESH_INTERVAL_MINUTES} * INTERVAL '1 minute'))
          AND (c."syncRequestedAt" IS NULL
            OR c."syncRequestedAt" <= NOW() - (${REQUEST_COOLDOWN_MINUTES} * INTERVAL '1 minute'))
          AND (c."status" <> 'UNAVAILABLE'
            OR c."lastErrorAt" IS NULL
            OR c."lastErrorAt" <= NOW() - (${UNAVAILABLE_RECHECK_MINUTES} * INTERVAL '1 minute'))
          AND (c."status" <> 'SYNCING'
            OR c."syncStartedAt" IS NULL
            OR c."syncStartedAt" <= NOW() - (${STALE_SCAN_MINUTES} * INTERVAL '1 minute'))
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

    if (reserved.length > 0) {
      await this.queue.addBulk(reserved.map(({ shopId, requestedAt }) => ({
        name: WOO_COUPON_SYNC_JOB_NAME,
        data: { shopId, requestedAt: requestedAt.toISOString() },
        opts: {
          jobId: createWooCouponJobId(shopId),
          attempts: 3,
          backoff: { type: "exponential" as const, delay: 30_000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      })));
    }

    return {
      cataloguesCreated: created.count,
      shopsReserved: reserved.length,
      jobsPublished: reserved.length,
    };
  }
}
