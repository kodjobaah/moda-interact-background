import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "@modainteract/moda-interact-shared/logging";

import prisma from "../../src/lib/db.js";
import { ConversationService } from "../../src/services/conversation.service.js";
import {
  cleanupArch056RecoveryFixture,
  createArch056RecoveryFixture,
  type Arch056InboundFixture,
} from "./helpers/arch056-inbound-fixtures.js";
import {
  createArch056Barrier,
  patchArch056Transaction,
  waitForArch056LockWait,
  withArch056Timeout,
} from "./helpers/arch056-inbound-barriers.js";

const integrationIt = process.env.TEST_REDIS_URL ? it : it.skip;
const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).reverse().map((close) => close()));
});

async function readInboundState(fixture: Arch056InboundFixture) {
  return prisma.conversation.findUniqueOrThrow({
    where: { id: fixture.conversationId },
    select: {
      inboundVersion: true,
      pendingTurnStartedAt: true,
      pendingAiNotBeforeAt: true,
      pendingAiDelayMinutes: true,
      pendingAiControlRevision: true,
      lastInboundAt: true,
      lastMessageAt: true,
    },
  });
}

describe("ARCH-056 inbound transaction rollback", () => {
  integrationIt("rolls back helper state after an injected post-helper failure and logs the original error", async () => {
    const fixture = await createArch056RecoveryFixture(7);
    cleanup.push(() => cleanupArch056RecoveryFixture(fixture));
    const sourceError = Object.assign(
      new Error("arch056-inbound-fixture-source-failure"),
      { code: "P2002", clientVersion: "6.19.3" },
    );
    const records: string[] = [];
    const logger = createLogger({
      serviceName: "moda-messaging-worker",
      environment: "test",
      sink: (record) => records.push(JSON.stringify(record)),
    });
    const providerMessageId = `arch056-rollback-${fixture.suffix}`;
    const restoreTransactions = patchArch056Transaction(prisma, () => ({
      afterPendingUpdate: async () => { throw sourceError; },
    }));

    try {
      let observedError: unknown;
      try {
        await new ConversationService(undefined, logger).receiveMessage({
          conversationId: fixture.conversationId,
          providerMessageId,
          inReplyToProviderId: null,
          content: "rollback fixture content",
        });
      } catch (error) {
        observedError = error;
      }
      expect(observedError).toBe(sourceError);

      const [message, state] = await Promise.all([
        prisma.conversationMessage.findUnique({
          where: { providerMessageId },
        }),
        readInboundState(fixture),
      ]);
      expect(message).toBeNull();
      expect(state).toEqual({
        inboundVersion: 0,
        pendingTurnStartedAt: null,
        pendingAiNotBeforeAt: null,
        pendingAiDelayMinutes: null,
        pendingAiControlRevision: null,
        lastInboundAt: null,
        lastMessageAt: null,
      });

      const record = JSON.parse(records.find((line) => JSON.parse(line).event === "whatsapp.inbound.persistence_failed")!);
      expect(record.data).toMatchObject({
        conversationId: fixture.conversationId,
        providerMessageId,
        stage: "atomic-receive",
        error: {
          name: "Error",
          message: "arch056-inbound-fixture-source-failure",
        },
        prismaCode: "P2002",
        prismaClientVersion: "6.19.3",
      });
    } finally {
      restoreTransactions();
    }
  });

  integrationIt("rolls back the losing helper mutation after both duplicate pre-reads miss", async () => {
    const fixture = await createArch056RecoveryFixture(1);
    cleanup.push(() => cleanupArch056RecoveryFixture(fixture));
    const providerMessageId = `arch056-raced-duplicate-${fixture.suffix}`;
    const firstHasUpdatedParent = createArch056Barrier();
    const releaseFirst = createArch056Barrier();
    const secondRequestedParent = createArch056Barrier();
    const bothPreReadsCompleted = createArch056Barrier();
    let preReadCount = 0;
    let secondBackendPid = 0;
    const originalFindUnique = prisma.conversationMessage.findUnique.bind(prisma.conversationMessage);
    const findUniqueSpy = vi.spyOn(prisma.conversationMessage, "findUnique").mockImplementation(async (args: any) => {
      const result = await originalFindUnique(args);
      if (args.where?.providerMessageId === providerMessageId && preReadCount < 2) {
        preReadCount += 1;
        if (preReadCount === 2) bothPreReadsCompleted.release();
        await withArch056Timeout(bothPreReadsCompleted.promise, "duplicate pre-reads");
      }
      return result;
    });
    const restoreTransactions = patchArch056Transaction(prisma, (index) => ({
      beforeParentLock: async (tx) => {
        if (index !== 1) return;
        const rows = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
        secondBackendPid = Number(rows[0].pid);
        secondRequestedParent.release();
      },
      afterPendingUpdate: async () => {
        if (index !== 0) return;
        firstHasUpdatedParent.release();
        await withArch056Timeout(releaseFirst.promise, "duplicate race first transaction release");
      },
    }));

    try {
      const service = new ConversationService();
      const firstReceive = service.receiveMessage({
        conversationId: fixture.conversationId,
        providerMessageId,
        inReplyToProviderId: null,
        content: "single owned duplicate message",
      });
      const secondReceive = service.receiveMessage({
        conversationId: fixture.conversationId,
        providerMessageId,
        inReplyToProviderId: null,
        content: "losing duplicate message",
      });
      await withArch056Timeout(firstHasUpdatedParent.promise, "duplicate race first helper update");
      await withArch056Timeout(secondRequestedParent.promise, "duplicate race second parent request");
      await waitForArch056LockWait(prisma, secondBackendPid, "duplicate race second Conversation lock");

      releaseFirst.release();
      const outcomes = await withArch056Timeout(
        Promise.allSettled([firstReceive, secondReceive]),
        "duplicate race transactions",
      );
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const rejection = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
      expect((rejection.reason as { code?: string }).code).toBe("P2002");

      const [messageCount, beforeRetry] = await Promise.all([
        prisma.conversationMessage.count({
          where: { conversationId: fixture.conversationId },
        }),
        readInboundState(fixture),
      ]);
      expect(messageCount).toBe(1);
      expect(beforeRetry.inboundVersion).toBe(1);
      expect(beforeRetry.pendingAiDelayMinutes).toBe(1);
      expect(beforeRetry.pendingAiNotBeforeAt?.getTime()).toBe(
        beforeRetry.pendingTurnStartedAt!.getTime() + 60_000,
      );

      await expect(service.receiveMessage({
        conversationId: fixture.conversationId,
        providerMessageId,
        inReplyToProviderId: null,
        content: "retry duplicate",
      })).resolves.toMatchObject({
        conversationId: fixture.conversationId,
        version: 1,
        duplicate: true,
      });
      expect((await readInboundState(fixture)).inboundVersion).toBe(1);
    } finally {
      releaseFirst.release();
      findUniqueSpy.mockRestore();
      restoreTransactions();
    }
  });
});
