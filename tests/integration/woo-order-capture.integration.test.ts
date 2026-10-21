import { createHash, randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { afterAll, describe, expect, it } from "vitest";

const redisUrl = process.env.TEST_REDIS_URL;
const integration = redisUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;
const digest = (value: object) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const jobId = (shopId: string, eventId: string) => `woo-order-${createHash("sha256")
  .update(shopId).update("\0").update(eventId).digest("hex")}`;
const event = (eventId: string, kind: "ORDER_PLACED" | "ORDER_PAID" | "ORDER_CANCELLED") => ({
  schemaVersion: "woo.activity.v1", eventId, eventType: kind,
  checkoutKey: "cart-1", occurredAt: "2026-10-20T12:00:00.000Z",
  order: { orderId: "order-1", checkoutKey: "cart-1", status: "processing" },
});
const payload = (shopId: string, value: ReturnType<typeof event>) => ({
  ...value, shopId, contentDigest: digest(value),
});

/** Wait for the real worker's job-specific event instead of sleeping. */
function untilJob(worker: { on: (event: string, handler: (...args: any[]) => void) => unknown },
  id: string, state: "completed" | "failed", count = 1): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Woo order ${state} timeout`)), 20_000);
    let seen = 0;
    worker.on(state, (job: { id?: string } | undefined) => {
      if (job?.id !== id || ++seen !== count) return;
      clearTimeout(timeout);
      resolve();
    });
  });
}

integration("ARCH-035 Woo order capture with disposable Redis/BullMQ", () => {
  // The worker reuses Background's module-level Redis connection across tests.
  // Close it only once, after both real-BullMQ scenarios have finished.
  afterAll(async () => {
    const { connectionRedis } = await import("../../src/lib/redis.js");
    await connectionRedis.quit();
  });
  it("accepts PAID before PLACED, then CANCELLED, with shop isolation and retained-event replay", async () => {
    const [{ createWooOrderCaptureWorker }] = await Promise.all([
      import("../../src/workers/woo-order-capture.worker.js"),
    ]);
    const connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const queue = new Queue("woo-order-capture-v1", { connection });
    const checkoutQueue = new Queue("woo-checkout-capture-v1", { connection });
    const shopifyOrderQueue = new Queue("order-events", { connection });
    const worker = createWooOrderCaptureWorker();
    try {
      await worker.waitUntilReady();
      const shopId = `woo-${randomUUID()}`;
      const otherShop = `woo-${randomUUID()}`;
      // The first order event is independent of checkout capture and payment state.
      for (const kind of ["ORDER_PAID", "ORDER_PLACED", "ORDER_CANCELLED"] as const) {
        const value = event(`event-${randomUUID()}`, kind);
        const id = jobId(shopId, value.eventId);
        const completed = untilJob(worker, id, "completed");
        const first = await queue.add("order-lifecycle", payload(shopId, value), {
          jobId: id, removeOnComplete: false,
        });
        await completed;
        expect(await queue.getJob(id).then((job) => job?.getState())).toBe("completed");
        const duplicate = await queue.add("order-lifecycle", payload(shopId, value), {
          jobId: id, removeOnComplete: false,
        });
        expect(duplicate.id).toBe(first.id);
      }
      const crossTenantEvent = event(`event-${randomUUID()}`, "ORDER_PAID");
      for (const shop of [shopId, otherShop]) {
        const id = jobId(shop, crossTenantEvent.eventId);
        const done = untilJob(worker, id, "completed");
        await queue.add("order-lifecycle", payload(shop, crossTenantEvent), {
          jobId: id, removeOnComplete: false,
        });
        await done;
        expect(await queue.getJob(id).then((job) => job?.getState())).toBe("completed");
      }
      expect(jobId(shopId, crossTenantEvent.eventId)).not.toBe(jobId(otherShop, crossTenantEvent.eventId));
      expect(await checkoutQueue.getJobCounts("waiting", "active", "completed", "failed"))
        .toEqual({ waiting: 0, active: 0, completed: 0, failed: 0 });
      expect(await shopifyOrderQueue.getJobCounts("waiting", "active", "completed", "failed"))
        .toEqual({ waiting: 0, active: 0, completed: 0, failed: 0 });
    } finally {
      await worker.close();
      await queue.close();
      await checkoutQueue.close();
      await shopifyOrderQueue.close();
      await connection.quit();
    }
  }, 60_000);

  it("fails malformed and tampered order jobs using configured BullMQ retries", async () => {
    const [{ createWooOrderCaptureWorker }] = await Promise.all([
      import("../../src/workers/woo-order-capture.worker.js"),
    ]);
    const connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const queue = new Queue("woo-order-capture-v1", { connection });
    const worker = createWooOrderCaptureWorker();
    try {
      await worker.waitUntilReady();
      const shopId = `woo-${randomUUID()}`;
      for (const invalidData of [
        (source: ReturnType<typeof event>) => ({ ...payload(shopId, source), contentDigest: "0".repeat(64) }),
        (source: ReturnType<typeof event>) => ({ ...payload(shopId, source), order: { ...source.order, checkoutKey: "different" } }),
      ]) {
        const source = event(`event-${randomUUID()}`, "ORDER_PAID");
        const id = jobId(shopId, source.eventId);
        const failed = untilJob(worker, id, "failed", 2);
        await queue.add("order-lifecycle", invalidData(source), {
          jobId: id, attempts: 2, backoff: { type: "fixed", delay: 20 }, removeOnFail: false,
        });
        await failed;
        const stored = await queue.getJob(id);
        expect(await stored?.getState()).toBe("failed");
        expect(stored?.attemptsMade).toBe(2);
      }
    } finally {
      await worker.close();
      await queue.close();
      await connection.quit();
    }
  }, 60_000);
});
