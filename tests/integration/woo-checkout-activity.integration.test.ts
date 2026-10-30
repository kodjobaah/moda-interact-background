import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { describe, expect, it } from "vitest";

import type { WooCheckoutCapture } from "../../src/events/woo-checkout-capture.js";
import type { WooCheckoutRef } from "../../src/services/woocommerce-recovery/contracts.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const suite = dbUrl && redisUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe : describe.skip;

const minute = 60_000;

/** A disposable real PostgreSQL + Redis/BullMQ regression. No worker is started;
 * BG005 alone owns the capture and maturity worker hookups. */
suite("ARCH-048-BACKGROUND-001 real candidate/row/index lifecycle", () => {
  it("closes the latest recovery once and repairs the next generation after Redis publication failure", async () => {
    const [
      { WooCheckoutActivityService },
      { WooExistingRecoveryRepository },
      { WooPendingCandidateQueueService, wooCandidateJobId },
      { WooActivityWatermarkStore, wooActivityWatermarkKey },
      { PendingRecoveryCandidateIndexStore },
      { PENDING_RECOVERY_CANDIDATE_QUEUE },
      { connectionRedis },
    ] = await Promise.all([
      import("../../src/services/woocommerce-recovery/woo-checkout-activity.service.js"),
      import("../../src/services/woocommerce-recovery/woo-checkout-activity.adapters.js"),
      import("../../src/services/woocommerce-recovery/woo-candidate-queue.service.js"),
      import("../../src/services/woocommerce-recovery/woo-activity-watermark.store.js"),
      import("../../src/services/pending-recovery-candidate/candidate-index.store.js"),
      import("../../src/domain/pending-recovery-candidate.js"),
      import("../../src/lib/redis.js"),
    ]);
    const db = new PrismaClient({ datasourceUrl: dbUrl! });
    const redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const queue = new Queue(PENDING_RECOVERY_CANDIDATE_QUEUE, { connection: redis });
    const shopId = `woo-bg001-${randomUUID()}`;
    const checkout = `basket-${randomUUID()}`;
    const other = `basket-${randomUUID()}`;
    const refs: WooCheckoutRef[] = [
      { shopId, checkoutToken: checkout }, { shopId, checkoutToken: other },
    ];
    const originMs = Math.floor((Date.now() - 2 * minute) / 1000) * 1000;
    const event = (ref: WooCheckoutRef, i: number): WooCheckoutCapture => ({
      schemaVersion: "woo.activity.v1", eventType: "CHECKOUT_UPDATED", eventId: `evt-${randomUUID()}`,
      shopId: ref.shopId, checkoutKey: ref.checkoutToken,
      occurredAt: new Date(originMs + i * 1000).toISOString(),
      checkout: { currency: "GBP", total: `${i + 12}.00`, items: [{ quantity: i + 1 }] },
    });
    const tails = new Map<string, Promise<void>>();
    const coordinator = { withCheckoutLock: async <T>(ref: WooCheckoutRef, action: () => Promise<T>): Promise<T> => {
      const prior = tails.get(ref.checkoutToken) ?? Promise.resolve();
      let done!: () => void;
      tails.set(ref.checkoutToken, new Promise<void>((resolve) => { done = resolve; }));
      await prior;
      try { return await action(); } finally { done(); }
    } };
    const candidates = new WooPendingCandidateQueueService(queue, new PendingRecoveryCandidateIndexStore());
    let failNextSchedule = false;
    const candidatePort = {
      getPending: (...args: Parameters<typeof candidates.getPending>) => candidates.getPending(...args),
      cancelPending: (...args: Parameters<typeof candidates.cancelPending>) => candidates.cancelPending(...args),
      schedulePending: async (...args: Parameters<typeof candidates.schedulePending>) => {
        if (failNextSchedule) { failNextSchedule = false; throw new Error("simulated redis publication failure"); }
        return candidates.schedulePending(...args);
      },
    };
    const watermarks = new WooActivityWatermarkStore(redis);
    const service = new WooCheckoutActivityService({
      coordinator, observedOrders: { read: async () => ({ kind: "none-observed" }) },
      candidates: candidatePort, watermarks, recoveries: new WooExistingRecoveryRepository(db),
      shops: { evaluate: async () => ({ allowed: true, shopDomain: `${shopId}.example.test` }) },
      resolveDelayMinutes: async () => 30,
    });

    try {
      await db.shop.create({ data: {
        id: shopId, domain: `${shopId}.example.test`, platform: "WOOCOMMERCE", status: "ACTIVE",
      } });
      const first = await service.handleCheckout(event(refs[0]!, 0));
      expect(first.kind).toBe("scheduled");
      expect((await queue.getJob(wooCandidateJobId(refs[0]!)))?.data).toMatchObject({
        source: "woocommerce", shopId, checkoutToken: checkout,
      });
      expect((await service.handleCheckout(event(refs[0]!, 1))).kind).toBe("rescheduled");
      const recovery = await db.checkoutRecovery.create({ data: {
        shopId, checkoutToken: checkout, generation: 1, status: "MESSAGE_SENT",
        lastExternalActivityAt: new Date(originMs + 1_000),
      } });
      const later = event(refs[0]!, 4);
      failNextSchedule = true;
      await expect(service.handleCheckout(later)).rejects.toThrow("simulated redis publication failure");
      const closed = await db.checkoutRecovery.findUniqueOrThrow({ where: { id: recovery.id } });
      expect(closed.status).toBe("CANCELLED");
      expect(closed.lastExternalActivityAt).toEqual(new Date(later.occurredAt));
      expect(await db.checkoutRecoveryStatusHistory.count({ where: {
        checkoutRecoveryId: recovery.id, reason: "CHECKOUT_RESUMED", source: "woocommerce.checkout",
      } })).toBe(1);
      expect(await service.handleCheckout(later)).toMatchObject({
        kind: "resumed", previousRecoveryId: recovery.id, nextGeneration: 2,
      });
      expect(await service.handleCheckout(event(refs[0]!, 5))).toMatchObject({ kind: "rescheduled", generation: 2 });
      expect(await db.checkoutRecovery.count({ where: { shopId, checkoutToken: checkout } })).toBe(1);
      expect((await candidates.getPending(refs[0]!, 2))?.generation).toBe(2);
      expect((await queue.getJob(wooCandidateJobId(refs[0]!, 2)))?.data.lastEventId).toBe(
        (await candidates.getPending(refs[0]!, 2))?.lastEventId);
      expect(await db.checkoutRecoveryStatusHistory.count({ where: {
        checkoutRecoveryId: recovery.id, reason: "CHECKOUT_RESUMED",
      } })).toBe(1);

      // Real BullMQ state/index under simultaneous events, serialized at the
      // checkout identity rather than globally or by customer contact.
      const updates = Array.from({ length: 8 }, (_, i) => event(refs[1]!, i));
      await Promise.all(updates.map((update) => service.handleCheckout(update)));
      expect((await candidates.getPending(refs[1]!))?.lastActivityAt).toBe(updates[7]?.occurredAt);
      expect((await queue.getJob(wooCandidateJobId(refs[1]!, 1)))?.data.source).toBe("woocommerce");
      expect(await candidates.cancelPending(refs[1]!)).toBe("cancelled");
    } finally {
      for (const ref of refs) {
        await candidates.cancelPending(ref);
        for (const generation of [1, 2]) {
          const job = await queue.getJob(wooCandidateJobId(ref, generation));
          if (job) await job.remove();
        }
        await redis.del(wooActivityWatermarkKey(ref));
      }
      await db.shop.deleteMany({ where: { id: shopId } });
      await queue.close();
      await redis.quit();
      await connectionRedis.quit();
      await db.$disconnect();
    }
  }, 60_000);
});
