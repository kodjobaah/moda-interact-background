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
});