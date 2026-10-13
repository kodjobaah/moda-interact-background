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

  it("allows only one global owner, fences a stale owner and recovers an expired lease", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const name = "WOO_COUPON_SYNC_DISPATCH" as const;
    const first = new BackgroundRuntimeLeaseService(db, `woo-lease-a-${randomUUID()}`);
    const second = new BackgroundRuntimeLeaseService(db, `woo-lease-b-${randomUUID()}`);
    const { connectionRedis } = await import("../../src/lib/redis.js");
    const queue = new Queue(WOO_COUPON_SYNC_QUEUE_NAME, { connection: connectionRedis });
    const shopId = `arch036-overlap-${randomUUID()}`;
    try {
      // Two replicas competing for the same lease must have one winner.
      const [a, b] = await Promise.all([first.tryAcquire(name), second.tryAcquire(name)]);
      expect([a, b].filter((value) => value !== null)).toHaveLength(1);
      const original = a ?? b;
      expect(original).not.toBeNull();
      const winner = a ? first : second;
      const successorService = a ? second : first;
      expect(await successorService.tryAcquire(name)).toBeNull();
      expect(await winner.heartbeat(original!)).toBe(true);

      // Simulate a crashed/stalled instance: expired ownership is taken over,
      // and the old generation can neither heartbeat nor release its successor.
      await db.backgroundRuntimeLease.update({
        where: { name }, data: { leaseUntil: new Date(Date.now() - 1000) },
      });
      const successor = await successorService.tryAcquire(name);
      expect(successor).not.toBeNull();
      expect(successor!.generation).toBe(original!.generation + 1);
      expect(await winner.heartbeat(original!)).toBe(false);
      expect(await winner.release(original!)).toBe(false);
      expect(await successorService.heartbeat(successor!)).toBe(true);

      // Even if the expired owner is still executing its callback, both
      // dispatch attempts share the same atomic per-shop reservation.
      const canonicalSiteUrl = `https://${randomUUID()}.example.test`;
      await db.shop.create({ data: { id: shopId, domain: canonicalSiteUrl, platform: "WOOCOMMERCE", status: "ACTIVE" } });
      await db.wooCommerceInstallation.create({
        data: { shopId, canonicalSiteUrl, credentialDigest: randomBytes(32) },
      });
      const staleDispatcher = new WooCouponDispatcherService(db, queue);
      const currentDispatcher = new WooCouponDispatcherService(db, queue);
      const [staleRun, currentRun] = await Promise.all([
        staleDispatcher.dispatch(1), currentDispatcher.dispatch(1),
      ]);
      expect(staleRun.jobsPublished + currentRun.jobsPublished).toBe(1);
      const queued = await queue.getJob(createWooCouponJobId(shopId));
      expect(queued?.data.shopId).toBe(shopId);
      await queued?.remove();

      expect(await successorService.release(successor!)).toBe(true);
      expect(await winner.tryAcquire(name)).toBeNull(); // 60-second completion cadence

      // A callback failure is also released with lastFinishedAt populated.
      await db.backgroundRuntimeLease.update({
        where: { name }, data: { leaseUntil: new Date(Date.now() - 1000), lastFinishedAt: null },
      });
      await expect(winner.runWithLease(name, async () => {
        throw new Error("dispatcher unavailable");
      })).rejects.toThrow("dispatcher unavailable");
      const released = await db.backgroundRuntimeLease.findUniqueOrThrow({ where: { name } });
      expect(released.lastFinishedAt).not.toBeNull();
      expect(released.leaseUntil.getTime()).toBeLessThanOrEqual(Date.now());
    } finally {
      await queue.close();
      await db.shop.deleteMany({ where: { id: shopId } });
      await db.backgroundRuntimeLease.deleteMany({ where: { name } });
      await db.$disconnect();
    }
  }, 40_000);

  it("recovers a PostgreSQL dispatch reservation after Redis publication failure and cooldown", async () => {
    const [{ connectionRedis }] = await Promise.all([import("../../src/lib/redis.js")]);
    const db = new PrismaClient({ datasourceUrl: url! });
    const queue = new Queue(WOO_COUPON_SYNC_QUEUE_NAME, { connection: connectionRedis });
    const shopId = `arch036-retry-${randomUUID()}`;
    const canonicalSiteUrl = `https://${randomUUID()}.example.test`;
    try {
      await db.shop.create({ data: { id: shopId, domain: canonicalSiteUrl, platform: "WOOCOMMERCE", status: "ACTIVE" } });
      await db.wooCommerceInstallation.create({
        data: { shopId, canonicalSiteUrl, credentialDigest: randomBytes(32) },
      });
      const failedPublisher = new WooCouponDispatcherService(db, {
        addBulk: async () => { throw new Error("redis publication unavailable"); },
      } as unknown as Queue);
      await expect(failedPublisher.dispatch(1)).rejects.toThrow("redis publication unavailable");
      const catalogue = await db.shopifyDiscountCatalogue.findUniqueOrThrow({ where: { shopId } });
      expect(catalogue.status).toBe("SYNC_REQUIRED");
      expect(catalogue.syncRequestedAt).not.toBeNull();
      expect(await queue.getJob(createWooCouponJobId(shopId))).toBeFalsy();
      const healthyDispatcher = new WooCouponDispatcherService(db, queue);
      expect((await healthyDispatcher.dispatch(1)).jobsPublished).toBe(0); // cooldown prevents a spin

      // The publisher crashed after the DB reservation: after the bounded
      // cooldown the next tick must enqueue a valid shop job without a grant.
      await db.shopifyDiscountCatalogue.update({
        where: { shopId }, data: { syncRequestedAt: new Date(Date.now() - 6 * 60_000) },
      });
      expect((await healthyDispatcher.dispatch(1)).jobsPublished).toBe(1);
      const job = await queue.getJob(createWooCouponJobId(shopId));
      expect(job?.data.shopId).toBe(shopId);
      expect(job?.data).not.toHaveProperty("credentials");
      await job?.remove();
    } finally {
      await queue.close();
      await db.shop.deleteMany({ where: { id: shopId } });
      await db.$disconnect();
    }
  }, 40_000);
});
