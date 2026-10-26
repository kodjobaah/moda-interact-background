import { createHash, randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { describe, expect, it } from "vitest";

const disposable = process.env.MODA_DISPOSABLE_INTEGRATION === "1"; // replaced below
const redisUrl = process.env.TEST_REDIS_URL;
const integration = redisUrl && disposable ? describe : describe.skip;

const digest = (value: object) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const jobId = (shopId: string, eventId: string) => `woo-checkout-${createHash("sha256")
  .update(shopId).update("\0").update(eventId).digest("hex")}`;
const event = (eventId: string) => ({
  schemaVersion: "woo.activity.v1", eventId, eventType: "CHECKOUT_UPDATED", checkoutKey: "cart-1",
  occurredAt: "2026-10-20T12:00:00.000Z",
  checkout: { currency: "GBP", total: "29.99", items: [{ quantity: 1, productId: "123", total: "29.99" }] },
});

function untilJob(worker: { on: (event: string, handler: (...args: any[]) => void) => unknown },
  id: string, state: "completed" | "failed", count = 1): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Woo capture job ${state} timeout`)), 15_000);
    let seen = 0;
    worker.on(state, (job: { id?: string } | undefined) => {
      if (job?.id !== id || ++seen !== count) return;
      clearTimeout(timeout);
      resolve();
    });
  });
}

integration("ARCH-035 Woo checkout capture with real Redis/BullMQ", () => {
  it("accepts API-shaped jobs once, isolates Shopify queues, and retries invalid jobs without side effects", async () => {
    const [{ createWooCheckoutCaptureWorker }, { connectionRedis }] = await Promise.all([
      import("../../src/workers/woo-checkout-capture.worker.js"),
      import("../../src/lib/redis.js"),
    ]);
    const queueConnection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const queue = new Queue("woo-checkout-capture-v1", { connection: queueConnection });
    const shopifyQueue = new Queue("checkout-events", { connection: queueConnection });
    const worker = createWooCheckoutCaptureWorker({ onCheckout: async () => ({
      kind: "scheduled", dueAt: "2026-10-26T00:00:00.000Z",
    }) });
    try {
      await worker.waitUntilReady();
      const shopId = `woo-${randomUUID()}`;
      const firstEvent = event(`evt-${randomUUID()}`);
      const id = jobId(shopId, firstEvent.eventId);
      const completed = untilJob(worker, id, "completed");
      const payload = { ...firstEvent, shopId, contentDigest: digest(firstEvent) };
      const first = await queue.add("checkout-updated", payload, { jobId: id, removeOnComplete: false });
      const duplicate = await queue.add("checkout-updated", payload, { jobId: id, removeOnComplete: false });
      expect(duplicate.id).toBe(first.id);
      await completed;
      expect(await queue.getJob(id).then((job) => job?.getState())).toBe("completed");

      const badEvent = event(`evt-${randomUUID()}`);
      const badId = jobId(shopId, badEvent.eventId);
      const failed = untilJob(worker, badId, "failed", 2);
      await queue.add("checkout-updated", { ...badEvent, shopId, contentDigest: "0".repeat(64) }, {
        jobId: badId, attempts: 2, backoff: { type: "fixed", delay: 20 }, removeOnFail: false,
      });
      await failed;
      const failedJob = await queue.getJob(badId);
      expect(await failedJob?.getState()).toBe("failed");
      expect(failedJob?.attemptsMade).toBe(2);
      expect(await shopifyQueue.getJobCounts("waiting", "active", "completed", "failed"))
        .toEqual({ waiting: 0, active: 0, completed: 0, failed: 0 });
      // The capture worker now awaits the injected business boundary. This test
      // isolates ingress; orchestration and durable admission have separate suites.
    } finally {
      await worker.close();
      await queue.close();
      await shopifyQueue.close();
      await queueConnection.quit();
      await connectionRedis.quit();
    }
  }, 45_000);
});
