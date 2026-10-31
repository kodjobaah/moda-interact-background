import { randomUUID } from "node:crypto";

import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";

import prisma from "../../src/lib/db.js";
import {
  ConversationService,
} from "../../src/services/conversation.service.js";
import {
  ConversationTurnProcessor,
  type ConversationTurnJob,
} from "../../src/services/conversation-turn-processor.service.js";
import { recordProcessableInbound } from "../../src/services/conversation-ai-delay/pending-turn-repository.js";

const redisUrl = process.env.TEST_REDIS_URL;
const integrationIt = redisUrl ? it : it.skip;

const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).reverse().map((close) => close()));
});

const logger: StructuredLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

async function waitFor<T>(
  label: string,
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest = await read();
  while (!accept(latest)) {
    if (Date.now() >= deadline) {
      throw new Error(`${label} timed out. Last value: ${JSON.stringify(latest)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    latest = await read();
  }
  return latest;
}

async function seedStandaloneConversation() {
  const suffix = randomUUID();
  const shopId = `shop-${suffix}`;
  const customerId = `customer-${suffix}`;
  const conversationId = `conversation-${suffix}`;

  await prisma.shop.create({
    data: {
      id: shopId,
      domain: `arch007-b010-${suffix}.myshopify.com`,
      status: "ACTIVE",
      onboardingCompleted: true,
    },
  });
  await prisma.customer.create({
    data: {
      id: customerId,
      shopId,
      phone: "+447700900000",
    },
  });
  await prisma.conversation.create({
    data: {
      id: conversationId,
      shopId,
      customerId,
      standaloneScopeKey: `arch007-b010:${suffix}`,
      type: "PRODUCT_SUPPORT",
      outcome: "IN_PROGRESS",
    },
  });

  return { conversationId, customerId, shopId };
}

async function seedRecoveryConversation(delayMinutes = 7) {
  const suffix = randomUUID();
  const shopId = `shop-${suffix}`;
  const recoveryId = `recovery-${suffix}`;
  const conversationId = `conversation-${suffix}`;
  await prisma.shop.create({
    data: {
      id: shopId,
      domain: `arch054-${suffix}.myshopify.com`,
      status: "ACTIVE",
    },
  });
  await prisma.checkoutRecovery.create({
    data: {
      id: recoveryId,
      shopId,
      checkoutToken: `checkout-${suffix}`,
      status: "MESSAGE_SENT",
      lastExternalActivityAt: new Date(),
    },
  });
  await prisma.shopSettings.create({
    data: { shopId, aiResponseDelayMinutes: delayMinutes },
  });
  await prisma.conversation.create({
    data: {
      id: conversationId,
      type: "RECOVERY",
      checkoutRecoveryId: recoveryId,
      controlRevision: 3,
    },
  });
  return { conversationId, recoveryId, shopId };
}

describe("ARCH-054 pending AI deadline PostgreSQL transaction", () => {
  it("serializes concurrent first text messages and freezes the winner's settings snapshot", async () => {
    const seeded = await seedRecoveryConversation(1);
    const conversation = new ConversationService();
    const [first, second] = await Promise.all([
      conversation.receiveMessage({
        conversationId: seeded.conversationId,
        providerMessageId: `first-${randomUUID()}`,
        inReplyToProviderId: null,
        content: "first fragment",
      }),
      conversation.receiveMessage({
        conversationId: seeded.conversationId,
        providerMessageId: `second-${randomUUID()}`,
        inReplyToProviderId: null,
        content: "second fragment",
      }),
    ]);
    const winner = await prisma.conversation.findUniqueOrThrow({
      where: { id: seeded.conversationId },
      select: {
        inboundVersion: true,
        pendingTurnStartedAt: true,
        pendingAiNotBeforeAt: true,
        pendingAiDelayMinutes: true,
        pendingAiControlRevision: true,
      },
    });
    expect([first.version, second.version].sort()).toEqual([1, 2]);
    expect(winner.inboundVersion).toBe(2);
    expect(winner.pendingTurnStartedAt).not.toBeNull();
    expect(winner.pendingAiNotBeforeAt?.getTime()).toBe(
      winner.pendingTurnStartedAt!.getTime() + 60_000,
    );
    expect(winner).toMatchObject({
      pendingAiDelayMinutes: 1,
      pendingAiControlRevision: 3,
    });

    await prisma.shopSettings.update({
      where: { shopId: seeded.shopId },
      data: { aiResponseDelayMinutes: 30 },
    });
    await conversation.receiveMessage({
      conversationId: seeded.conversationId,
      providerMessageId: `third-${randomUUID()}`,
      inReplyToProviderId: null,
      content: "later fragment",
    });
    const afterSettingsChange = await prisma.conversation.findUniqueOrThrow({
      where: { id: seeded.conversationId },
      select: {
        pendingTurnStartedAt: true,
        pendingAiNotBeforeAt: true,
        pendingAiDelayMinutes: true,
        pendingAiControlRevision: true,
      },
    });
    expect(afterSettingsChange).toEqual({
      pendingTurnStartedAt: winner.pendingTurnStartedAt,
      pendingAiNotBeforeAt: winner.pendingAiNotBeforeAt,
      pendingAiDelayMinutes: 1,
      pendingAiControlRevision: 3,
    });
  });

  it("rolls back the inbound message and frozen snapshot together on transaction failure", async () => {
    const seeded = await seedRecoveryConversation(7);
    const providerMessageId = `rollback-${randomUUID()}`;
    await expect(prisma.$transaction(async (tx) => {
      await tx.conversationMessage.create({
        data: {
          conversationId: seeded.conversationId,
          providerMessageId,
          direction: "INBOUND",
          senderType: "CUSTOMER",
          status: "DELIVERED",
          content: "must roll back",
        },
      });
      await recordProcessableInbound(tx, seeded.conversationId, new Date());
      throw new Error("ARCH054_INJECTED_TRANSACTION_FAILURE");
    })).rejects.toThrow("ARCH054_INJECTED_TRANSACTION_FAILURE");

    expect(await prisma.conversationMessage.findUnique({
      where: { providerMessageId },
    })).toBeNull();
    expect(await prisma.conversation.findUniqueOrThrow({
      where: { id: seeded.conversationId },
      select: {
        inboundVersion: true,
        pendingTurnStartedAt: true,
        pendingAiNotBeforeAt: true,
        pendingAiDelayMinutes: true,
        pendingAiControlRevision: true,
      },
    })).toEqual({
      inboundVersion: 0,
      pendingTurnStartedAt: null,
      pendingAiNotBeforeAt: null,
      pendingAiDelayMinutes: null,
      pendingAiControlRevision: null,
    });
  });
});

async function createTurnBoundary({ failFirstSchedule = false } = {}) {
  const queueName = `arch007-b010-${randomUUID()}`;
  const queueRedis = new IORedis(redisUrl!, { maxRetriesPerRequest: null });
  const workerRedis = new IORedis(redisUrl!, { maxRetriesPerRequest: null });
  const queue = new Queue<ConversationTurnJob>(queueName, {
    connection: queueRedis,
  });
  const conversation = new ConversationService();
  const agentCalls: string[] = [];
  const providerOutputs: string[] = [];
  const claimedVersions: number[] = [];
  let failNextSchedule = failFirstSchedule;

  const schedulingQueue = {
    add: async (
      name: string,
      data: ConversationTurnJob,
      options: { jobId: string; delay: number; removeOnComplete?: boolean },
    ) => {
      if (failNextSchedule) {
        failNextSchedule = false;
        throw new Error("ARCH007_B010_INJECTED_TURN_ENQUEUE_FAILURE");
      }
      return queue.add(name, data, options);
    },
  };

  const processor = new ConversationTurnProcessor({
    queue: schedulingQueue,
    conversation,
    admission: {
      reserve: vi.fn(async ({ conversationId, shopId }) => ({
        kind: "admitted" as const,
        shopId,
        messageId: `outbound-${randomUUID()}`,
        conversationId,
        terminal: false,
      })),
      sendPreparedText: vi.fn(async (input) => {
        providerOutputs.push(input.text);
        return input;
      }),
      failPrepared: vi.fn(async () => undefined),
    },
    abuseAdmission: {
      admitSettledTurn: vi.fn(async () => ({ kind: "allowed" as const })),
    },
    loadTurn: async (conversationId) => {
      const state = await conversation.getTurnState(conversationId);
      if (state.processingInboundVersion !== null) {
        claimedVersions.push(state.processingInboundVersion);
      }
      return {
        shopId: "shop",
        to: "+447700900000",
        customerPhone: "+447700900000",
        conversationType: "PRODUCT_SUPPORT" as const,
        checkoutRecoveryId: null,
        hasReplyContext: false,
        context: { conversationId },
        languageMessage: "settled turn",
      };
    },
    aiWrapper: { renderConversationResponse: async (input) => ({
      kind: "no-wrapper" as const, body: input.responseBody, reason: "NOT_CONFIGURED" as const,
    }) },
    runAgent: vi.fn(async (context: { conversationId: string }) => {
      agentCalls.push(context.conversationId);
      return {
        replyText: "settled response",
        detectedLanguageTag: null,
        detectedLanguageConfidence: null,
      };
    }),
    getResult: (result) => result,
    runtimeConfig: {
      current: () => ({
        conversationQuietWindowMs: 150,
        conversationMaxSettleWindowMs: 600,
      }) as any,
    },
    logger,
  });

  const worker = new Worker<ConversationTurnJob>(
    queueName,
    async (job: Job<ConversationTurnJob>) => {
      if (job.name !== "process-conversation-turn") {
        throw new Error(`Unexpected job ${job.name}`);
      }
      await processor.process(job.data, job);
    },
    { connection: workerRedis },
  );

  cleanup.push(
    () => queueRedis.quit(),
    () => workerRedis.quit(),
    () => queue.close(),
    () => worker.close(),
  );
  await worker.waitUntilReady();

  return {
    agentCalls,
    claimedVersions,
    conversation,
    processor,
    providerOutputs,
    queue,
  };
}

describe.sequential("ARCH-007-BACKGROUND-010 live turn scheduling", () => {
  integrationIt(
    "coalesces three persisted fragments and claims only the settled current version",
    async () => {
      const seeded = await seedStandaloneConversation();
      const boundary = await createTurnBoundary();
      const fragments = [
        "Hi I was looking at",
        "the black jacket",
        "sorry I mean blue",
      ];
      const firstOccurredAt = Date.now() - 60_000;

      for (const [index, content] of fragments.entries()) {
        const received = await boundary.conversation.receiveMessage({
          conversationId: seeded.conversationId,
          providerMessageId: `fragment-${index + 1}-${randomUUID()}`,
          inReplyToProviderId: null,
          content,
          occurredAt: new Date(firstOccurredAt + (index * 5)),
        });
        await boundary.processor.enqueue(
          seeded.conversationId,
          received.version,
        );
      }

      const settled = await waitFor(
        "settled version 3",
        () => boundary.conversation.getTurnState(seeded.conversationId),
        (state) => state.lastProcessedVersion === 3,
      );
      const persisted = await prisma.conversationMessage.findMany({
        where: { conversationId: seeded.conversationId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { content: true },
      });

      expect(persisted.map((message) => message.content)).toEqual(fragments);
      expect(settled).toMatchObject({
        inboundVersion: 3,
        lastProcessedVersion: 3,
        pendingTurnStartedAt: null,
        processingInboundVersion: null,
        processingStartedAt: null,
      });
      expect(boundary.claimedVersions).toEqual([3]);
      expect(boundary.agentCalls).toHaveLength(1);
      expect(boundary.providerOutputs).toEqual(["settled response"]);
    },
  );

  integrationIt(
    "repairs a missing turn job when a persisted message is delivered again after enqueue failure",
    async () => {
      const seeded = await seedStandaloneConversation();
      const boundary = await createTurnBoundary({ failFirstSchedule: true });
      const providerMessageId = `enqueue-failure-${randomUUID()}`;
      const message = {
        conversationId: seeded.conversationId,
        providerMessageId,
        inReplyToProviderId: null,
        content: "Can you help?",
        occurredAt: new Date(),
      };

      const first = await boundary.conversation.receiveMessage(message);
      expect(first).toMatchObject({ duplicate: false, version: 1 });
      await expect(
        boundary.processor.enqueue(seeded.conversationId, first.version),
      ).rejects.toThrow("ARCH007_B010_INJECTED_TURN_ENQUEUE_FAILURE");

      const duplicate = await boundary.conversation.receiveMessage(message);
      expect(duplicate).toMatchObject({ duplicate: true, version: 1 });

      // Mirrors the worker contract: persistence-level duplicate detection does
      // not suppress the idempotent ensure-scheduled operation.
      await boundary.processor.enqueue(
        seeded.conversationId,
        duplicate.version,
      );

      const settled = await waitFor(
        "repaired version 1",
        () => boundary.conversation.getTurnState(seeded.conversationId),
        (state) => state.lastProcessedVersion === 1,
      );

      expect(settled).toMatchObject({
        inboundVersion: 1,
        lastProcessedVersion: 1,
        pendingTurnStartedAt: null,
        processingInboundVersion: null,
        processingStartedAt: null,
      });
      expect(boundary.claimedVersions).toEqual([1]);
      expect(boundary.agentCalls).toHaveLength(1);
      expect(boundary.providerOutputs).toEqual(["settled response"]);
    },
  );
});
