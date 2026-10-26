import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PrismaClient } from "@prisma/client";
import { Queue } from "bullmq";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { connectionRedis } from "../../src/lib/redis.js";
import { PENDING_RECOVERY_CANDIDATE_QUEUE } from "../../src/domain/pending-recovery-candidate.js";
import { PendingRecoveryCandidateIndexStore } from "../../src/services/pending-recovery-candidate/candidate-index.store.js";
import { wooCandidateJobId } from "../../src/services/woocommerce-recovery/woo-candidate-queue.service.js";
import { wooInitialDispatchJobId, WOO_INITIAL_DISPATCH_JOB } from "../../src/services/woocommerce-recovery/woo-initial-dispatch.queue.js";
import { WooRecoveryOrchestratorService } from "../../src/services/woocommerce-recovery/woo-recovery-orchestrator.service.js";
import type { WooAdmissionOutcome } from "../../src/services/woocommerce-recovery/contracts.js";
import { createPendingRecoveryCandidateWorker } from "../../src/workers/pending-recovery-candidate.worker.js";
import { createWooCheckoutCaptureWorker } from "../../src/workers/woo-checkout-capture.worker.js";
import { createWooOrderCaptureWorker } from "../../src/workers/woo-order-capture.worker.js";

vi.mock("../../src/runtime/background-runtime-config.js", () => ({
  backgroundRuntimeConfigService: {
    current: () => ({ version: 1, pendingRecoveryQueueGlobalConcurrency: 1 }),
    subscribe: () => () => undefined,
  },
}));
const integrated = process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

function awaitEvent(worker: EventEmitter, id: string, status: "completed" | "failed") {
  return new Promise<Error | null>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Missing ${status} event for Woo test job`)), 20_000);
    worker.on(status, (job, error) => {
      if (job?.id !== id) return;
      clearTimeout(timeout);
      resolve(status === "failed" ? error : null);
    });
  });
}

function fakes() {
  const log = createLogger({ serviceName: "moda-recovery-worker", environment: "test", sink: () => undefined });
  const checkout = vi.fn(async () => ({ kind: "scheduled" as const, dueAt: new Date().toISOString() }));
  const order = vi.fn(async () => ({ kind: "paid-terminal" as const }));
  const admission = vi.fn(async () => ({ kind: "created" as const, recoveryId: "recovery-test" } as WooAdmissionOutcome));
  const enqueue = vi.fn(async () => ({ kind: "queued" as const, attemptId: "attempt-test" }));
  const dispatch = vi.fn(async () => ({ kind: "sent" as const, attemptId: "attempt-test" }));
  const clear = vi.fn(async () => undefined);
  const orchestrator = new WooRecoveryOrchestratorService({
    checkout: { handleCheckout: checkout }, order: { reconcileOrder: order },
    admission: { evaluateMatured: admission },
    outreach: { enqueueInitial: enqueue, processInitial: dispatch },
    assertWooShop: async () => undefined, assertInitialAttempt: async () => undefined,
    clearMatured: clear, logger: log,
  });
  return { orchestrator, checkout, order, admission, enqueue, dispatch, clear };
}

function checkoutJob(shopId: string) {
  const event = { schemaVersion: "woo.activity.v1", eventId: `evt-${randomUUID()}`,
    eventType: "CHECKOUT_UPDATED", checkoutKey: `checkout-${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    checkout: { currency: "GBP", total: "12.00", items: [{ quantity: 1, title: "Test" }] },
  };
  return {
    id: `woo-checkout-${createHash("sha256").update(shopId).update("\0").update(event.eventId).digest("hex")}`,
    data: { ...event, shopId, contentDigest: createHash("sha256").update(JSON.stringify(event)).digest("hex") },
  };
}
function orderJob(shopId: string) {
  const key = `checkout-${randomUUID()}`;
  const event = { schemaVersion: "woo.activity.v1", eventId: `order-${randomUUID()}`,
    eventType: "ORDER_PAID", checkoutKey: key, occurredAt: new Date().toISOString(),
    order: { orderId: `woo-order-${randomUUID()}`, checkoutKey: key, status: "completed" },
  };
  return {
    id: `woo-order-${createHash("sha256").update(shopId).update("\0").update(event.eventId).digest("hex")}`,
    data: { ...event, shopId, contentDigest: createHash("sha256").update(JSON.stringify(event)).digest("hex") },
  };
}

integrated("ARCH-048-BG005 real BullMQ retry and exception boundaries", () => {
  const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL! });
  afterAll(async () => { await db.$disconnect(); await connectionRedis.quit(); });

  it("BG001 failure becomes a failed attempt, then BullMQ replays the same checkout job successfully", async () => {
    const f = fakes();
    const injected = new Error("BG001 activity lookup failed");
    f.checkout.mockRejectedValueOnce(injected);
    const worker = createWooCheckoutCaptureWorker(f.orchestrator);
    const queue = new Queue("woo-checkout-capture-v1", { connection: connectionRedis });
    const task = checkoutJob(`shop-${randomUUID()}`);
    const errors: Error[] = [];
    worker.on("failed", (_job, error) => { errors.push(error); });
    try {
      await worker.waitUntilReady();
      const done = awaitEvent(worker, task.id, "completed");
      await queue.add("checkout-updated", task.data, { jobId: task.id, attempts: 2,
        backoff: { type: "fixed", delay: 100 }, removeOnComplete: false });
      await done;
      expect(errors).toContain(injected);
      expect(f.checkout).toHaveBeenCalledTimes(2);
      const stored = await queue.getJob(task.id);
      expect(await stored?.getState()).toBe("completed");
      expect(stored?.attemptsMade).toBe(2);
    } finally { await worker.close(); await queue.close(); }
  }, 50_000);

  it("BG002 order failure is an actual failed BullMQ job, not a completed acknowledgement", async () => {
    const f = fakes();
    const injected = new Error("BG002 durable order write failed");
    f.order.mockRejectedValueOnce(injected);
    const worker = createWooOrderCaptureWorker(f.orchestrator);
    const queue = new Queue("woo-order-capture-v1", { connection: connectionRedis });
    const task = orderJob(`shop-${randomUUID()}`);
    try {
      await worker.waitUntilReady();
      const failed = awaitEvent(worker, task.id, "failed");
      await queue.add("order-lifecycle", task.data, { jobId: task.id, attempts: 1, removeOnFail: false });
      expect(await failed).toBe(injected);
      expect(f.order).toHaveBeenCalledOnce();
    } finally { await worker.close(); await queue.close(); }
  }, 45_000);

  it("BG003 (including merchant-notice failure) retains the candidate index after failure", async () => {
    const f = fakes();
    const injected = new Error("consent-denial Support notice persistence rejected");
    f.admission.mockRejectedValueOnce(injected);
    const worker = createPendingRecoveryCandidateWorker(f.orchestrator);
    const queue = new Queue(PENDING_RECOVERY_CANDIDATE_QUEUE, { connection: connectionRedis });
    const index = new PendingRecoveryCandidateIndexStore();
    const candidate = { source: "woocommerce" as const, shopId: `shop-${randomUUID()}`,
      checkoutToken: `checkout-${randomUUID()}`, lastEventId: `evt-${randomUUID()}`,
      lastActivityAt: new Date().toISOString(), basket: { kind: "empty" as const } };
    const id = wooCandidateJobId(candidate);
    try {
      await index.upsert({ candidate, jobId: id, delayMinutes: 1, dueAtMs: Date.now(),
        shouldIndexShop: true, retentionMs: 60_000 });
      await worker.waitUntilReady();
      const failed = awaitEvent(worker, id, "failed");
      await queue.add("evaluate-pending-recovery", candidate, { jobId: id, attempts: 1, removeOnFail: false });
      expect(await failed).toBe(injected);
      expect(f.clear).not.toHaveBeenCalled();
      expect(await index.findByCheckout(candidate)).toBe(id);
    } finally {
      await index.remove(candidate, id);
      await worker.close(); await queue.close();
    }
  }, 45_000);

  it("BG004 queue outage after INSERT retries an already-existing recovery without duplicating the row", async () => {
    const f = fakes();
    const shopId = `shop-${randomUUID()}`;
    const checkoutToken = `checkout-${randomUUID()}`;
    const candidate = { source: "woocommerce" as const, shopId, checkoutToken,
      lastEventId: `evt-${randomUUID()}`, lastActivityAt: new Date().toISOString(),
      basket: { kind: "empty" as const } };
    const recoveryId = randomUUID();
    await db.shop.create({ data: { id: shopId, domain: `${shopId}.example.test`, platform: "WOOCOMMERCE" } });
    f.admission.mockImplementation(async () => {
      const existing = await db.checkoutRecovery.findUnique({ where: { id: recoveryId } });
      if (existing) return { kind: "already-exists", recoveryId, status: existing.status } as WooAdmissionOutcome;
      await db.checkoutRecovery.create({ data: { id: recoveryId, shopId, checkoutToken,
        lastExternalActivityAt: new Date() } });
      return { kind: "created", recoveryId } as WooAdmissionOutcome;
    });
    const injected = new Error("BullMQ enqueue failed after successful INSERT");
    f.enqueue.mockRejectedValueOnce(injected);
    const worker = createPendingRecoveryCandidateWorker(f.orchestrator);
    const queue = new Queue(PENDING_RECOVERY_CANDIDATE_QUEUE, { connection: connectionRedis });
    const id = wooCandidateJobId(candidate);
    let failures = 0;
    worker.on("failed", (job) => { if (job?.id === id) failures++; });
    try {
      await worker.waitUntilReady();
      const done = awaitEvent(worker, id, "completed");
      await queue.add("evaluate-pending-recovery", candidate, { jobId: id, attempts: 2,
        backoff: { type: "fixed", delay: 100 }, removeOnComplete: false });
      await done;
      expect(failures).toBe(1);
      expect(f.admission).toHaveBeenCalledTimes(2);
      expect(f.enqueue).toHaveBeenCalledTimes(2);
      expect(f.clear).toHaveBeenCalledOnce();
      expect(await db.checkoutRecovery.count({ where: { shopId, checkoutToken } })).toBe(1);
    } finally {
      await worker.close(); await queue.close();
      await db.shop.deleteMany({ where: { id: shopId } });
    }
  }, 60_000);

  it("BG004 initial dispatch failure remains failed and never invokes a Shopify materialiser", async () => {
    const f = fakes();
    const injected = new Error("final Woo SQL permit dependency rejected");
    f.dispatch.mockRejectedValueOnce(injected);
    const worker = createPendingRecoveryCandidateWorker(f.orchestrator);
    const queue = new Queue(PENDING_RECOVERY_CANDIDATE_QUEUE, { connection: connectionRedis });
    const data = { source: "woocommerce" as const,
      recoveryId: `recovery-${randomUUID()}`, attemptId: `attempt-${randomUUID()}` };
    const id = wooInitialDispatchJobId(data);
    try {
      await worker.waitUntilReady();
      const failed = awaitEvent(worker, id, "failed");
      await queue.add(WOO_INITIAL_DISPATCH_JOB, data, { jobId: id, attempts: 1, removeOnFail: false });
      expect(await failed).toBe(injected);
      expect(f.dispatch).toHaveBeenCalledOnce();
      expect(f.clear).not.toHaveBeenCalled();
    } finally { await worker.close(); await queue.close(); }
  }, 45_000);
});
