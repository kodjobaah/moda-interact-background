import "dotenv/config";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/runtime/background-runtime-config.js", () => ({
  backgroundRuntimeConfigService: {
    current: () => ({ version: 1, pendingRecoveryQueueGlobalConcurrency: 1 }),
    subscribe: () => () => undefined,
  },
}));

const suite = process.env.TEST_DATABASE_URL && process.env.REDIS_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

suite("initial outreach progress candidate worker (PostgreSQL and Redis)", () => {
  async function createWorkerJob() {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL!;
    const [{ Queue, QueueEvents }, { connectionRedis }, domain, workerModule, fixtureModule] = await Promise.all([
      import("bullmq"),
      import("../../src/lib/redis.js"),
      import("../../src/domain/pending-recovery-candidate.js"),
      import("../../src/workers/pending-recovery-candidate.worker.js"),
      import("./fixtures/initial-outreach-progress.fixture.js"),
    ]);
    const f = await fixtureModule.createInitialOutreachProgressFixture();
    const suffix = randomUUID();
    const jobId = `initial-progress-${suffix}`;
    const queue = new Queue(domain.PENDING_RECOVERY_CANDIDATE_QUEUE, { connection: connectionRedis });
    const events = new QueueEvents(domain.PENDING_RECOVERY_CANDIDATE_QUEUE, { connection: connectionRedis });
    const worker = workerModule.createPendingRecoveryCandidateWorker();
    const shop = await f.db.shop.findUniqueOrThrow({ where: { id: f.shopId }, select: { domain: true } });
    const candidate = {
      shopId: f.shopId,
      shopDomain: shop.domain,
      checkoutToken: (await f.recovery()).checkoutToken,
      cartToken: null,
      abandonedCheckoutUrl: "https://example.test/checkout",
      checkoutCreatedAt: new Date().toISOString(),
    };
    const job = await queue.add(domain.EVALUATE_PENDING_RECOVERY_JOB, candidate, {
      jobId, attempts: 3, backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: false, removeOnFail: false,
    });
    await Promise.all([worker.waitUntilReady(), events.waitUntilReady()]);
    return { f, queue, events, worker, job, candidate, jobId, jobName: domain.EVALUATE_PENDING_RECOVERY_JOB };
  }

  it("reconciles one confirmed generation through the real candidate queue and worker", async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL!;
    const [{ Queue, QueueEvents }, { connectionRedis }, domain, workerModule, fixtureModule] = await Promise.all([
      import("bullmq"),
      import("../../src/lib/redis.js"),
      import("../../src/domain/pending-recovery-candidate.js"),
      import("../../src/workers/pending-recovery-candidate.worker.js"),
      import("./fixtures/initial-outreach-progress.fixture.js"),
    ]);
    const f = await fixtureModule.createInitialOutreachProgressFixture();
    const suffix = randomUUID();
    const jobId = `initial-progress-${suffix}`;
    const queue = new Queue(domain.PENDING_RECOVERY_CANDIDATE_QUEUE, { connection: connectionRedis });
    const events = new QueueEvents(domain.PENDING_RECOVERY_CANDIDATE_QUEUE, { connection: connectionRedis });
    const worker = workerModule.createPendingRecoveryCandidateWorker();
    try {
      const shop = await f.db.shop.findUniqueOrThrow({ where: { id: f.shopId }, select: { domain: true } });
      const candidate = {
        shopId: f.shopId,
        shopDomain: shop.domain,
        checkoutToken: (await f.recovery()).checkoutToken,
        cartToken: null,
        abandonedCheckoutUrl: "https://example.test/checkout",
        checkoutCreatedAt: new Date().toISOString(),
      };
      const job = await queue.add(domain.EVALUATE_PENDING_RECOVERY_JOB, candidate, {
        jobId, attempts: 1, removeOnComplete: false, removeOnFail: false,
      });
      await Promise.all([worker.waitUntilReady(), events.waitUntilReady()]);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Candidate job did not finish: ${jobId}`)), 25_000);
        worker.on("completed", (completed) => {
          if (completed.id !== jobId) return;
          clearTimeout(timer);
          resolve();
        });
        worker.on("failed", (failed, error) => {
          if (failed?.id !== jobId) return;
          clearTimeout(timer);
          reject(error);
        });
      });

      expect((await f.recovery()).status).toBe("MESSAGE_SENT");
      expect(await f.attempt()).toMatchObject({
        status: "WAITING_FOR_RESPONSE", outboundMessageId: f.messageId, sentAt: f.sentAt,
      });
      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId! } }))
        .toMatchObject({ status: "COMMITTED", sourceKey: f.sourceKey });
      expect(await f.db.merchantSupportMessage.count({
        where: { sourceKey: `recovery-initial-outreach:v1:${f.attemptId}` },
      })).toBe(1);
      expect(await f.db.conversationMessage.count({ where: { id: f.messageId } })).toBe(1);
      await job.remove();
    } finally {
      await worker.close();
      await events.close();
      await queue.close();
      await f.db.shop.deleteMany({ where: { id: f.shopId } });
      await f.close();
    }
  }, 60_000);

  it("keeps bounded exhausted work failed, then explicitly retries the same job through the real handler", async () => {
    const [{ checkoutRecoveryService }, { pendingRecoveryCandidateService }] = await Promise.all([
      import("../../src/services/checkout-recovery.service.js"),
      import("../../src/services/pending-recovery-candidate.service.js"),
    ]);
    const materializationError = new Error("temporary materialization outage");
    const cleanupError = new Error("temporary candidate cleanup outage");
    const materialize = vi.spyOn(checkoutRecoveryService, "materializeMaturedCandidate")
      .mockRejectedValue(materializationError);
    const cleanup = vi.spyOn(pendingRecoveryCandidateService, "handleCandidateMatured")
      .mockRejectedValue(cleanupError);
    const output: string[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation((...args) => {
      for (const arg of args) if (typeof arg === "string") output.push(arg);
    });
    const context = await createWorkerJob();
    try {
      await expect(context.job.waitUntilFinished(context.events)).rejects.toThrow();
      expect(await context.job.getState()).toBe("failed");
      expect((await context.queue.getJob(context.jobId))?.attemptsMade).toBe(3);
      expect(materialize).toHaveBeenCalledTimes(3);
      expect(cleanup).toHaveBeenCalledTimes(3);
      const compound = output.map((record) => {
        try { return JSON.parse(record) as Record<string, unknown>; } catch { return null; }
      }).find((record) => record?.event === "recovery.pending_candidate.processing_cleanup_failed");
      expect(compound).toMatchObject({
        level: "error",
        data: expect.objectContaining({
          attempt: 1,
          shopId: context.f.shopId,
          materializationError: expect.objectContaining({ message: materializationError.message }),
          cleanupError: expect.objectContaining({ message: cleanupError.message }),
        }),
      });

      materialize.mockRestore();
      cleanup.mockRestore();
      await context.events.close();
      await (await context.queue.getJob(context.jobId))!.remove();
      await context.queue.add(context.jobName, context.candidate, {
        jobId: context.jobId, attempts: 3, backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: false, removeOnFail: false,
      });
      const { QueueEvents } = await import("bullmq");
      const retryEvents = new QueueEvents(context.queue.name, { connection: context.queue.opts.connection });
      await retryEvents.waitUntilReady();
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Explicit retry did not finish: ${context.jobId}`)), 25_000);
          retryEvents.on("completed", ({ jobId }) => {
            if (jobId !== context.jobId) return;
            clearTimeout(timer);
            resolve();
          });
          retryEvents.on("failed", async ({ jobId }) => {
            if (jobId !== context.jobId) return;
            const failedJob = await context.queue.getJob(context.jobId);
            if (!failedJob || await failedJob.getState() !== "failed") return;
            clearTimeout(timer);
            reject(new Error(failedJob.failedReason || "Explicit retry failed without a reason"));
          });
        });
      } finally {
        await retryEvents.close();
      }
      expect(await context.job.getState()).toBe("completed");
      expect((await context.f.recovery()).status).toBe("MESSAGE_SENT");
      expect(await context.f.attempt()).toMatchObject({
        status: "WAITING_FOR_RESPONSE", outboundMessageId: context.f.messageId,
      });
    } finally {
      materialize.mockRestore();
      cleanup.mockRestore();
      consoleError.mockRestore();
      await context.worker.close();
      await context.events.close();
      await context.queue.close();
      await context.f.db.shop.deleteMany({ where: { id: context.f.shopId } });
      await context.f.close();
    }
  }, 90_000);

  it("logs a real confirmed-finalization interruption and converges on worker retry", async () => {
    const { checkoutRecoveryService } = await import("../../src/services/checkout-recovery.service.js");
    const output: string[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation((...args) => {
      for (const arg of args) if (typeof arg === "string") output.push(arg);
    });
    const context = await createWorkerJob();
    const finalization = (checkoutRecoveryService as unknown as {
      finalizationService: { initialOutreachFinalizer: { finalizeConfirmedInitial: (...args: never[]) => Promise<unknown> } };
    }).finalizationService.initialOutreachFinalizer;
    const persistenceError = new Error("Support notice database unavailable");
    const support = vi.spyOn(finalization, "finalizeConfirmedInitial").mockRejectedValueOnce(persistenceError);
    try {
      await expect(context.job.waitUntilFinished(context.events)).resolves.toBeDefined();
      expect(support).toHaveBeenCalledTimes(2);
      const records = output.flatMap((record) => {
        try { return [JSON.parse(record) as Record<string, unknown>]; } catch { return []; }
      });
      expect(records).toContainEqual(expect.objectContaining({
        event: "recovery.initial_outreach_support_notice.shopify_finalization_failed",
        level: "error",
        data: expect.objectContaining({
          stage: "support_notice",
          shopId: context.f.shopId,
          checkoutRecoveryId: context.f.recoveryId,
          outreachAttemptId: context.f.attemptId,
          outboundMessageId: context.f.messageId,
          sourceError: expect.objectContaining({ message: persistenceError.message }),
        }),
      }));
      expect(await context.f.db.usageReservation.findUniqueOrThrow({ where: { id: context.f.reservationId! } }))
        .toMatchObject({ status: "COMMITTED" });
      expect(await context.f.db.merchantSupportMessage.count({
        where: { sourceKey: `recovery-initial-outreach:v1:${context.f.attemptId}` },
      })).toBe(1);
      expect((await context.f.recovery()).status).toBe("MESSAGE_SENT");
    } finally {
      support.mockRestore();
      consoleError.mockRestore();
      await context.worker.close();
      await context.events.close();
      await context.queue.close();
      await context.f.db.shop.deleteMany({ where: { id: context.f.shopId } });
      await context.f.close();
    }
  }, 90_000);
});