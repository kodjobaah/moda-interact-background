import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import prisma from "../../src/lib/db.js";
import type { ConversationTurnJob } from "../../src/services/conversation-turn-processor.service.js";
import { PendingTurnRepairService } from "../../src/services/conversation-ai-delay/pending-turn-repair.js";

const redisUrl = process.env.TEST_REDIS_URL;
const integrationIt = process.env.TEST_DATABASE_URL && redisUrl &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? it : it.skip;
const resources: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  await Promise.allSettled(resources.splice(0).reverse().map((close) => close()));
}, 30_000);

const runtimeConfig = {
  current: () => ({ conversationQuietWindowMs: 250, conversationMaxSettleWindowMs: 30_000 }),
};

async function createFixture(count: number, clock: Date) {
  const suffix = randomUUID().replaceAll("-", "");
  const shopId = `arch054repair-${suffix}`;
  const idPrefix = `arch054repair-${suffix}-`;
  await prisma.shop.create({
    data: { id: shopId, domain: `${shopId}.example.test`, status: "ACTIVE" },
  });
  resources.push(() => prisma.shop.delete({ where: { id: shopId } }));

  const deadline = new Date(clock.getTime() - 60_000);
  const startedAt = new Date(clock.getTime() - 120_000);
  const lastInboundAt = new Date(clock.getTime() - 60_000);
  await prisma.checkoutRecovery.createMany({
    data: Array.from({ length: count }, (_, index) => ({
      id: `${idPrefix}r${String(index).padStart(5, "0")}`,
      shopId,
      checkoutToken: `${suffix}-${index}`,
      lastExternalActivityAt: startedAt,
    })),
  });
  await prisma.conversation.createMany({
    data: Array.from({ length: count }, (_, index) => {
      return {
        id: `${idPrefix}${String(index).padStart(5, "0")}`,
        type: "RECOVERY" as const,
        checkoutRecoveryId: `${idPrefix}r${String(index).padStart(5, "0")}`,
        controlMode: index === 0 ? "HUMAN" as const : "AI" as const,
        controlRevision: 4,
        controlChangedAt: startedAt,
        inboundVersion: index === 3 ? 9 : 7,
        lastProcessedVersion: 2,
        pendingTurnStartedAt: startedAt,
        pendingAiNotBeforeAt: deadline,
        pendingAiControlRevision: index === 1 ? 3 : 4,
        pendingAiDelayMinutes: 1,
        lastInboundAt,
        processingInboundVersion: index === 2 || index === 4 ? 7 : null,
        processingStartedAt: index === 2 ? clock : null,
      };
    }),
  });

  const connection = new IORedis(redisUrl!, { maxRetriesPerRequest: null });
  const queue = new Queue<ConversationTurnJob>("whatsapp-events", { connection });
  resources.push(
    () => connection.quit(),
    () => queue.close(),
    async () => {
      const jobs = await queue.getJobs(["waiting", "delayed", "failed"], 0, -1);
      await Promise.all(jobs.filter((job) => job.data.conversationId.startsWith(idPrefix))
        .map((job) => job.remove()));
    },
  );
  await queue.waitUntilReady();
  return { idPrefix, queue };
}

function repairService(
  queue: Pick<Queue<ConversationTurnJob>, "add"> & Partial<Pick<Queue<ConversationTurnJob>, "getJob">>,
  now: () => Date,
) {
  return new PendingTurnRepairService(prisma, {
    add: queue.add.bind(queue),
    getJob: queue.getJob?.bind(queue) ?? (async () => null),
  } as never, runtimeConfig, now, {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  });
}

async function waitForJobState(queue: Queue<ConversationTurnJob>, jobId: string, state: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = await queue.getJob(jobId);
    if (current && await current.getState() === state) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for job ${jobId} to enter ${state}`);
}

describe("ARCH-054 pending delayed AI turn repair", () => {
  integrationIt("bounds a 10,000-row scan and excludes stale ownership and active leases", async () => {
    const clock = new Date();
    const { idPrefix } = await createFixture(10_000, clock);
    const add = vi.fn(async () => undefined);
    const service = repairService({ add } as never, () => clock);
    const result = await service.runPass();
    expect(result.scanned).toBe(1_000);
    expect(result.requeued).toBe(1_000);
    const conversationIds = add.mock.calls.map(([, data]) => (data as ConversationTurnJob).conversationId);
    expect(conversationIds).not.toContain(`${idPrefix}00000`);
    expect(conversationIds).not.toContain(`${idPrefix}00001`);
    expect(conversationIds).not.toContain(`${idPrefix}00002`);
    expect(conversationIds).toContain(`${idPrefix}00004`);
    expect(add).toHaveBeenCalledWith("process-conversation-turn", {
      conversationId: `${idPrefix}00003`, observedVersion: 9,
    }, expect.objectContaining({ jobId: `conversation-turn__${idPrefix}00003__9` }));
  }, 120_000);

  integrationIt("deduplicates concurrent replicas and a restarted repair process through deterministic job IDs", async () => {
    const clock = new Date();
    const { idPrefix, queue } = await createFixture(5, clock);
    const [first, second] = await Promise.all([
      repairService(queue, () => clock).runPass(),
      repairService(queue, () => clock).runPass(),
    ]);
    expect(first.scanned).toBe(2);
    expect(second.scanned).toBe(2);
    const waiting = await queue.getJobs(["waiting", "delayed"], 0, -1);
    expect(waiting.filter((job) => job.data.conversationId.startsWith(idPrefix))).toHaveLength(2);

    expect((await repairService(queue, () => clock).runPass()).scanned).toBe(2);
    const afterRestart = await queue.getJobs(["waiting", "delayed"], 0, -1);
    expect(afterRestart.filter((job) => job.data.conversationId.startsWith(idPrefix))).toHaveLength(2);
  }, 30_000);

  integrationIt("retries a retained failed versioned job once across concurrent repairs without another inbound", async () => {
    const clock = new Date();
    const { idPrefix, queue } = await createFixture(4, clock);
    const conversationId = `${idPrefix}00003`;
    const observedVersion = 9;
    const jobId = `conversation-turn__${conversationId}__${observedVersion}`;
    const workerConnection = new IORedis(redisUrl!, { maxRetriesPerRequest: null });
    let deliveryCount = 0;
    let aiSendCount = 0;
    let enterSuccessfulAttempt!: () => void;
    const successfulAttemptEntered = new Promise<void>((resolve) => { enterSuccessfulAttempt = resolve; });
    let releaseSuccessfulAttempt!: () => void;
    const successfulAttemptGate = new Promise<void>((resolve) => { releaseSuccessfulAttempt = resolve; });
    const worker = new Worker<ConversationTurnJob>("whatsapp-events", async (job: Job<ConversationTurnJob>) => {
      if (job.id !== jobId) return;
      deliveryCount++;
      if (deliveryCount === 1) throw new Error("transient processor failure");
      enterSuccessfulAttempt();
      await successfulAttemptGate;
      const claimed = await prisma.conversation.updateMany({
        where: {
          id: conversationId,
          controlMode: "AI",
          controlRevision: 4,
          pendingAiControlRevision: 4,
          inboundVersion: observedVersion,
          lastProcessedVersion: { lt: observedVersion },
        },
        data: { processingInboundVersion: observedVersion, processingStartedAt: new Date() },
      });
      if (claimed.count !== 1) return;
      aiSendCount++;
      await prisma.conversation.updateMany({
        where: { id: conversationId, processingInboundVersion: observedVersion },
        data: {
          lastProcessedVersion: observedVersion,
          pendingTurnStartedAt: null,
          pendingAiNotBeforeAt: null,
          pendingAiControlRevision: null,
          pendingAiDelayMinutes: null,
          processingInboundVersion: null,
          processingStartedAt: null,
        },
      });
    }, { connection: workerConnection });
    resources.push(() => workerConnection.quit(), () => worker.close());

    let lookupCount = 0;
    let releaseLookups!: () => void;
    const bothFailedLookups = new Promise<void>((resolve) => { releaseLookups = resolve; });
    const concurrentQueue = {
      add: queue.add.bind(queue),
      getJob: async (id: string) => {
        const job = await queue.getJob(id);
        if (id === jobId && job && await job.getState() === "failed") {
          lookupCount++;
          if (lookupCount === 2) releaseLookups();
          await bothFailedLookups;
        }
        return job;
      },
    };

    try {
      await worker.waitUntilReady();
      await queue.add("process-conversation-turn", {
        conversationId, observedVersion,
      }, { jobId, delay: 0, attempts: 1, removeOnComplete: true });
      await waitForJobState(queue, jobId, "failed");

      const before = await prisma.conversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: {
          inboundVersion: true,
          pendingAiNotBeforeAt: true,
          controlMode: true,
          controlRevision: true,
          pendingAiControlRevision: true,
        },
      });
      expect(deliveryCount).toBe(1);

      const [first, second] = await Promise.all([
        repairService(concurrentQueue, () => clock).runPass(),
        repairService(concurrentQueue, () => clock).runPass(),
      ]);
      expect(first.scanned + second.scanned).toBe(2);
      expect(first.requeued + second.requeued).toBe(1);
      expect(first.skipped + second.skipped).toBe(1);
      await successfulAttemptEntered;

      const afterRepair = await prisma.conversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: {
          inboundVersion: true,
          pendingAiNotBeforeAt: true,
          controlMode: true,
          controlRevision: true,
          pendingAiControlRevision: true,
        },
      });
      expect(afterRepair).toEqual(before);

      releaseSuccessfulAttempt();
      const completionDeadline = Date.now() + 5_000;
      while (Date.now() < completionDeadline) {
        const completed = await prisma.conversation.findUniqueOrThrow({
          where: { id: conversationId }, select: { lastProcessedVersion: true },
        });
        if (completed.lastProcessedVersion === observedVersion) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(await prisma.conversation.findUniqueOrThrow({
        where: { id: conversationId }, select: { inboundVersion: true, lastProcessedVersion: true },
      })).toEqual({ inboundVersion: observedVersion, lastProcessedVersion: observedVersion });
      expect(deliveryCount).toBe(2);
      expect(aiSendCount).toBe(1);
    } finally {
      releaseSuccessfulAttempt();
      releaseLookups();
    }
  }, 30_000);

  integrationIt("preserves pending state after enqueue failure and retries frozen deadlines with latest version and clock drift", async () => {
    const clock = new Date();
    const fixture = await createFixture(5, clock);
    const futureAt = new Date(clock.getTime() + 90_000);
    const futureId = `${fixture.idPrefix}future`;
    const futureRecoveryId = `${fixture.idPrefix}future-recovery`;
    await prisma.checkoutRecovery.create({ data: {
      id: futureRecoveryId,
      shopId: (await prisma.conversation.findUniqueOrThrow({
        where: { id: `${fixture.idPrefix}00003` },
        select: { checkoutRecovery: { select: { shopId: true } } },
      })).checkoutRecovery!.shopId,
      checkoutToken: futureRecoveryId,
      lastExternalActivityAt: clock,
    } });
    await prisma.conversation.create({ data: {
      id: futureId,
      type: "RECOVERY",
      checkoutRecoveryId: futureRecoveryId,
      controlRevision: 2,
      controlChangedAt: clock,
      inboundVersion: 12,
      lastProcessedVersion: 3,
      pendingTurnStartedAt: new Date(clock.getTime() - 60_000),
      pendingAiNotBeforeAt: futureAt,
      pendingAiControlRevision: 2,
      pendingAiDelayMinutes: 2,
      lastInboundAt: new Date(clock.getTime() - 60_000),
    } });

    const originalError = new Error("Redis unavailable");
    const add = vi.fn()
      .mockRejectedValueOnce(originalError)
      .mockImplementation((name: string, data: ConversationTurnJob, options: { jobId: string; delay: number }) =>
        fixture.queue.add(name, data, options));
    const service = repairService({ add } as never, () => clock);
    await expect(service.runPass()).rejects.toBe(originalError);

    const preserved = await prisma.conversation.findUniqueOrThrow({
      where: { id: futureId },
      select: {
        inboundVersion: true,
        lastProcessedVersion: true,
        pendingAiNotBeforeAt: true,
        pendingTurnStartedAt: true,
        pendingAiControlRevision: true,
      },
    });
    expect(preserved).toMatchObject({ inboundVersion: 12, lastProcessedVersion: 3 });
    expect(preserved.pendingAiNotBeforeAt).toEqual(futureAt);

    const outcome = await service.runPass();
    expect(outcome.failed).toBe(0);
    expect(outcome.requeued).toBe(3);
    expect(await fixture.queue.getJob(`conversation-turn__${futureId}__12`)).toMatchObject({
      data: { conversationId: futureId, observedVersion: 12 },
      delay: 90_000,
    });
    const overdueId = `${fixture.idPrefix}00003`;
    expect(await fixture.queue.getJob(`conversation-turn__${overdueId}__9`)).toMatchObject({
      data: { conversationId: overdueId, observedVersion: 9 },
      delay: 0,
    });
  }, 30_000);
});
