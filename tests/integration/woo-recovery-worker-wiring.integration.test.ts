import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { afterAll, describe, expect, it, vi } from "vitest";

/** The real worker uses the same global concurrency controller as production;
 * only its test control-plane configuration is injected. */
vi.mock("../../src/runtime/background-runtime-config.js", () => ({
  backgroundRuntimeConfigService: {
    current: () => ({ version: 1, pendingRecoveryQueueGlobalConcurrency: 2 }),
    subscribe: () => () => undefined,
  },
}));

const redisUrl = process.env.TEST_REDIS_URL;
const databaseUrl = process.env.TEST_DATABASE_URL;
const integrated = redisUrl && databaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe : describe.skip;

function untilJob(worker: { on: (name: string, callback: (...args: any[]) => void) => unknown },
  jobId: string, eventName: "completed" | "failed", number = 1): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Woo ${eventName} not observed`)), 25_000);
    let count = 0;
    worker.on(eventName, (job: { id?: string } | undefined) => {
      if (job?.id !== jobId || ++count !== number) return;
      clearTimeout(timeout);
      resolve();
    });
  });
}

integrated("ARCH-048-BG005 real BullMQ workers + PostgreSQL source isolation", () => {
  const db = new PrismaClient({ datasourceUrl: databaseUrl! });
  afterAll(async () => {
    await db.$disconnect();
    const { connectionRedis } = await import("../../src/lib/redis.js");
    await connectionRedis.quit();
  });

  it("Woo checkout→maturity→durable recovery→initial, late order and retry stay isolated", async () => {
    const [
      { createPendingRecoveryCandidateWorker },
      { createWooCheckoutCaptureWorker },
      { createWooOrderCaptureWorker },
      { WooRecoveryOrchestratorService },
      { WooInitialDispatchQueue, wooInitialDispatchJobId },
      { wooCandidateJobId },
      { PendingRecoveryCandidateIndexStore },
    ] = await Promise.all([
      import("../../src/workers/pending-recovery-candidate.worker.js"),
      import("../../src/workers/woo-checkout-capture.worker.js"),
      import("../../src/workers/woo-order-capture.worker.js"),
      import("../../src/services/woocommerce-recovery/woo-recovery-orchestrator.service.js"),
      import("../../src/services/woocommerce-recovery/woo-initial-dispatch.queue.js"),
      import("../../src/services/woocommerce-recovery/woo-candidate-queue.service.js"),
      import("../../src/services/pending-recovery-candidate/candidate-index.store.js"),
    ]);
    const connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const maturityQueue = new Queue("pending-recovery-candidates", { connection });
    const checkoutQueue = new Queue("woo-checkout-capture-v1", { connection });
    const orderQueue = new Queue("woo-order-capture-v1", { connection });
    const initialQueue = new WooInitialDispatchQueue();
    const index = new PendingRecoveryCandidateIndexStore();
    const wooShopId = `woo-${randomUUID()}`;
    const shopifyShopId = `shopify-${randomUUID()}`;
    const checkoutToken = `checkout-${randomUUID()}`;
    const recoveryId = `recovery-${randomUUID()}`;
    const attemptId = `attempt-${randomUUID()}`;
    let delivered = 0;
    let enqueueCalls = 0;
    await db.shop.createMany({ data: [
      { id: wooShopId, domain: `${wooShopId}.example.test`, platform: "WOOCOMMERCE", onboardingCompleted: true },
      { id: shopifyShopId, domain: `${shopifyShopId}.example.test`, platform: "SHOPIFY", onboardingCompleted: true },
    ] });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
    const admission = {
      evaluateMatured: vi.fn(async () => {
        const existing = await db.checkoutRecovery.findUnique({ where: { id: recoveryId } });
        if (existing) return { kind: "already-exists" as const, recoveryId, status: existing.status,
          generation: 1, repairInitial: true };
        await db.checkoutRecovery.create({ data: {
          id: recoveryId, shopId: wooShopId, checkoutToken, status: "DETECTED",
          lastExternalActivityAt: new Date("2026-10-24T00:00:00.000Z"),
        } });
        return { kind: "created" as const, recoveryId, generation: 1 };
      }),
    };
    const checkout = { handleCheckout: vi.fn(async () => ({ kind: "resumed" as const,
      previousRecoveryId: recoveryId, nextGeneration: 2, candidateOutcome: "scheduled" as const })) };
    const orders = { reconcileOrder: vi.fn(async () => {
      await db.checkoutRecovery.update({ where: { id: recoveryId }, data: { status: "COMPLETED", completedAt: new Date() } });
      return { kind: "paid-terminal" as const, recoveryId };
    }) };
    const outreach = {
      settleResumed: vi.fn(async () => undefined),
      enqueueInitial: vi.fn(async (id: string) => {
        enqueueCalls++;
        if (delivered > 0) return { kind: "already-initialized" as const, attemptId };
        await initialQueue.initial(id, attemptId);
        return { kind: "queued" as const, attemptId };
      }),
      processInitial: vi.fn(async () => {
        delivered++;
        return { kind: "sent" as const, attemptId };
      }),
    };
    const orchestrator = new WooRecoveryOrchestratorService({
      checkout, order: orders, admission, outreach, logger: log as any,
      async assertWooShop(id) {
        if ((await db.shop.findUnique({ where: { id }, select: { platform: true } }))?.platform !== "WOOCOMMERCE") {
          throw new Error("WOO_RECOVERY_SHOP_PLATFORM_MISMATCH");
        }
      },
      clearMatured: async (candidate, id) => { await index.compareAndRemoveCheckout(candidate, id); },
      async assertInitialAttempt(id, attempted) {
        if (id !== recoveryId || attempted !== attemptId) throw new Error("invalid attempt");
      },
    });
    const maturity = createPendingRecoveryCandidateWorker(orchestrator);
    const checkoutWorker = createWooCheckoutCaptureWorker(orchestrator);
    const orderWorker = createWooOrderCaptureWorker(orchestrator);
    try {
      await Promise.all([maturity.waitUntilReady(), checkoutWorker.waitUntilReady(), orderWorker.waitUntilReady()]);
      const candidate = { source: "woocommerce" as const, shopId: wooShopId, checkoutToken,
        generation: 1,
        lastEventId: `evt-${randomUUID()}`, lastActivityAt: "2026-10-24T00:00:00.000Z",
        basket: { kind: "empty" as const },
      };
      const candidateId = wooCandidateJobId(candidate, candidate.generation);
      const initialId = wooInitialDispatchJobId({ source: "woocommerce", recoveryId, attemptId });
      await index.upsert({ candidate, jobId: candidateId, delayMinutes: 1,
        dueAtMs: Date.now(), shouldIndexShop: true, retentionMs: 60_000 });
      const firstDone = untilJob(maturity, candidateId, "completed");
      const initialDone = untilJob(maturity, initialId, "completed");
      await maturityQueue.add("evaluate-pending-recovery", candidate, {
        jobId: candidateId, removeOnComplete: false,
      });
      await Promise.all([firstDone, initialDone]);
      expect(await db.checkoutRecovery.count({ where: { shopId: wooShopId, checkoutToken } })).toBe(1);
      expect(await index.findByCheckout({ shopId: wooShopId, checkoutToken })).toBeNull();
      expect(delivered).toBe(1);

      // A checkout arriving after the first send may reenter the orchestrator,
      // but the accepted BG004 idempotency port prevents a new initial send.
      const event = { schemaVersion: "woo.activity.v1", eventId: `evt-${randomUUID()}`,
        eventType: "CHECKOUT_UPDATED", checkoutKey: checkoutToken,
        occurredAt: "2026-10-25T12:00:00.000Z",
        checkout: { currency: "GBP", total: "1.00", items: [{ quantity: 1 }] },
      } as const;
      const checkoutJobId = `woo-checkout-${createHash("sha256")
        .update(wooShopId).update("\0").update(event.eventId).digest("hex")}`;
      const checkoutDone = untilJob(checkoutWorker, checkoutJobId, "completed");
      await checkoutQueue.add("checkout-updated", {
        ...event, shopId: wooShopId, contentDigest: createHash("sha256").update(JSON.stringify(event)).digest("hex"),
      }, { jobId: checkoutJobId });
      await checkoutDone;
      expect(enqueueCalls).toBe(1);
      expect(outreach.settleResumed).toHaveBeenCalledOnce();
      expect(delivered).toBe(1);

      // BG002 is always called even when the candidate index is gone.
      const order = { schemaVersion: "woo.activity.v1", eventId: `order-${randomUUID()}`,
        eventType: "ORDER_PAID", checkoutKey: checkoutToken, occurredAt: "2026-10-25T13:00:00.000Z",
        order: { orderId: `order-${randomUUID()}`, checkoutKey: checkoutToken, status: "completed" },
      } as const;
      const orderJobId = `woo-order-${createHash("sha256")
        .update(wooShopId).update("\0").update(order.eventId).digest("hex")}`;
      const orderDone = untilJob(orderWorker, orderJobId, "completed");
      await orderQueue.add("order-lifecycle", {
        ...order, shopId: wooShopId, contentDigest: createHash("sha256").update(JSON.stringify(order)).digest("hex"),
      }, { jobId: orderJobId });
      await orderDone;
      expect((await db.checkoutRecovery.findUniqueOrThrow({ where: { id: recoveryId } })).status).toBe("COMPLETED");

      const badShopEventId = `evt-${randomUUID()}`;
      const badShopEvent = { ...event, eventId: badShopEventId };
      const badShopJobId = `woo-checkout-${createHash("sha256")
        .update(shopifyShopId).update("\0").update(badShopEventId).digest("hex")}`;
      const rejected = untilJob(checkoutWorker, badShopJobId, "failed");
      await checkoutQueue.add("checkout-updated", {
        ...badShopEvent, shopId: shopifyShopId,
        contentDigest: createHash("sha256").update(JSON.stringify(badShopEvent)).digest("hex"),
      }, { jobId: badShopJobId, attempts: 1, removeOnFail: false });
      await rejected;
      expect(await checkoutQueue.getJob(badShopJobId).then((item) => item?.getState())).toBe("failed");
      expect(await db.checkoutRecovery.count({ where: { shopId: shopifyShopId } })).toBe(0);
    } finally {
      await Promise.allSettled([maturity.close(), checkoutWorker.close(), orderWorker.close()]);
      await Promise.allSettled([maturityQueue.close(), checkoutQueue.close(), orderQueue.close(), initialQueue.close()]);
      await connection.quit();
    }
  }, 100_000);
});
