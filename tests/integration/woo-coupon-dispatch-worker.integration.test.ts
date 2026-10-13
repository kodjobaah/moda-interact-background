import "dotenv/config";

import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { Queue, Worker } from "bullmq";
import { describe, expect, it } from "vitest";

import { BackgroundRuntimeLeaseService } from "../../src/runtime/background-runtime-lease.js";
import { WooCouponCatalogueService } from "../../src/services/woo-coupon-catalogue.service.js";
import {
  WooCouponDispatcherService, WOO_COUPON_SYNC_QUEUE_NAME, createWooCouponJobId,
} from "../../src/services/woo-coupon-dispatcher.service.js";

const url = process.env.TEST_DATABASE_URL;
const databaseTests = url && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

/** Exercise the real PostgreSQL lease + dispatcher + BullMQ + fenced write path. */
databaseTests("ARCH-036 Woo coupon leased dispatch to BullMQ and PostgreSQL", () => {
  it("discovers a new shop, queues one job and commits its initially unselected coupon", async () => {
    // Only import Redis-connected worker modules once the disposable harness
    // has injected its ephemeral REDIS_URL; ordinary unit runs remain safe.
    const [{ connectionRedis }, { createWooCouponSyncWorker }] = await Promise.all([
      import("../../src/lib/redis.js"),
      import("../../src/workers/woo-coupon-sync.worker.js"),
    ]);
    const db = new PrismaClient({ datasourceUrl: url! });
    const shopId = `arch036-sync-${randomUUID()}`;
    const domain = `https://${randomUUID()}.example.test`;
    const queue = new Queue(WOO_COUPON_SYNC_QUEUE_NAME, { connection: connectionRedis });
    let worker: Worker | undefined;
    try {
      await db.shop.create({ data: { id: shopId, domain, platform: "WOOCOMMERCE", status: "ACTIVE" } });
      const installation = await db.wooCommerceInstallation.create({
        data: { shopId, canonicalSiteUrl: domain, credentialDigest: randomBytes(32) },
      });
      await db.$transaction(async (tx) => {
        const attempt = await tx.wooCommerceRestReadAttempt.create({
          data: {
            installationId: installation.id, shopId, tokenDigest: randomBytes(32),
            credentialVersionSnapshot: installation.credentialVersion,
            expiresAt: new Date(Date.now() + 10 * 60_000),
          },
        });
        const consumed = await tx.wooCommerceRestReadAttempt.update({
          where: { id: attempt.id }, data: { status: "SUCCEEDED", consumedAt: new Date() },
        });
        await tx.wooCommerceRestReadGrant.create({
          data: {
            installationId: installation.id, shopId, authorizationAttemptId: attempt.id,
            authorizationAttemptSequence: consumed.attemptSequence,
            credentialVersionSnapshot: installation.credentialVersion,
            credentialCiphertext: randomBytes(64), credentialNonce: randomBytes(12),
            credentialAuthTag: randomBytes(16), encryptionKeyId: "arch036-fixture",
            providerKeyId: "arch036-fixture", authorizedScope: "read", verifiedAt: new Date(),
          },
        });
      });
      // No catalogue record exists yet: dispatcher must bootstrap it.
      expect(await db.shopifyDiscountCatalogue.findUnique({ where: { shopId } })).toBeNull();
      const reader = async () => [{ id: 99, code: "NEW10", discount_type: "percent", amount: "10.00",
        usage_limit: null, usage_count: 0, date_expires_gmt: null }];
      worker = createWooCouponSyncWorker(new WooCouponCatalogueService(db, reader), 1);
      await worker.waitUntilReady();
      const finished = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Woo coupon job did not finish")), 15_000);
        worker!.on("completed", (job, result) => {
          if (job.id !== createWooCouponJobId(shopId)) return;
          clearTimeout(timeout);
          if (result === "current") resolve();
          else reject(new Error(`Unexpected Woo sync result: ${String(result)}`));
        });
        worker!.on("failed", (job, error) => {
          if (job?.id === createWooCouponJobId(shopId)) {
            clearTimeout(timeout); reject(error);
          }
        });
      });
      const lease = new BackgroundRuntimeLeaseService(db, `woo-dispatch-test-${randomUUID()}`);
      const dispatcher = new WooCouponDispatcherService(db, queue);
      const first = await lease.runWithLease("WOO_COUPON_SYNC_DISPATCH", async () => dispatcher.dispatch(5));
      expect(first.kind).toBe("completed");
      if (first.kind === "completed") {
        expect(first.value.cataloguesCreated).toBeGreaterThanOrEqual(1);
        expect(first.value.jobsPublished).toBeGreaterThanOrEqual(1);
      }
      await finished;
      expect(await db.shopifyDiscountCatalogue.findUniqueOrThrow({ where: { shopId } }))
        .toMatchObject({ status: "CURRENT", activeSyncToken: null });
      const rows = await db.shopifyDiscount.findMany({ where: { shopId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ shopifyDiscountNodeId: "woo:coupon:99", isAvailable: false });
      const second = await lease.runWithLease("WOO_COUPON_SYNC_DISPATCH", async () => dispatcher.dispatch(5));
      expect(second.kind).toBe("skipped"); // persisted global 60-second cadence
    } finally {
      if (worker) await worker.close();
      await queue.close();
      await db.shop.deleteMany({ where: { id: shopId } });
      await db.backgroundRuntimeLease.deleteMany({ where: { name: "WOO_COUPON_SYNC_DISPATCH" } });
      await db.$disconnect();
    }
  }, 60_000);
});
