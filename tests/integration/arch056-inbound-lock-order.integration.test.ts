import { afterEach, describe, expect, it } from "vitest";

import prisma from "../../src/lib/db.js";
import { ConversationService } from "../../src/services/conversation.service.js";
import { InboundWhatsAppAudioService } from "../../src/services/inbound-whatsapp-audio.service.js";
import {
  cleanupArch056RecoveryFixture,
  createArch056RecoveryFixture,
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

describe("ARCH-056 inbound parent-first lock order", () => {
  integrationIt("blocks the second receive on the parent before its child insert", async () => {
    const fixture = await createArch056RecoveryFixture(1);
    cleanup.push(() => cleanupArch056RecoveryFixture(fixture));
    const service = new ConversationService();
    const firstHasUpdatedParent = createArch056Barrier();
    const releaseFirst = createArch056Barrier();
    const secondRequestedParent = createArch056Barrier();
    let secondBackendPid = 0;
    const insertTransactions: number[] = [];
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
        await withArch056Timeout(releaseFirst.promise, "first receive release");
      },
      beforeMessageInsert: async () => {
        insertTransactions.push(index);
      },
    }));

    try {
      const firstReceive = service.receiveMessage({
        conversationId: fixture.conversationId,
        providerMessageId: `arch056-first-${fixture.suffix}`,
        inReplyToProviderId: null,
        content: "first inbound fixture",
      });
      await withArch056Timeout(firstHasUpdatedParent.promise, "first parent update");

      const secondReceive = service.receiveMessage({
        conversationId: fixture.conversationId,
        providerMessageId: `arch056-second-${fixture.suffix}`,
        inReplyToProviderId: null,
        content: "second inbound fixture",
      });
      await withArch056Timeout(secondRequestedParent.promise, "second parent request");
      await waitForArch056LockWait(prisma, secondBackendPid, "second Conversation lock");
      expect(insertTransactions).toEqual([]);

      releaseFirst.release();
      const results = await withArch056Timeout(
        Promise.all([firstReceive, secondReceive]),
        "both serialized receives",
      );
      expect(results.map((result) => result.version).sort()).toEqual([1, 2]);
      expect(insertTransactions.sort()).toEqual([0, 1]);

      const [messageCount, conversation] = await Promise.all([
        prisma.conversationMessage.count({
          where: { conversationId: fixture.conversationId },
        }),
        prisma.conversation.findUniqueOrThrow({
          where: { id: fixture.conversationId },
          select: {
            inboundVersion: true,
            pendingTurnStartedAt: true,
            pendingAiNotBeforeAt: true,
            pendingAiDelayMinutes: true,
            pendingAiControlRevision: true,
          },
        }),
      ]);
      expect(messageCount).toBe(2);
      expect(conversation).toMatchObject({
        inboundVersion: 2,
        pendingAiDelayMinutes: 1,
        pendingAiControlRevision: 3,
      });
      expect(conversation.pendingAiNotBeforeAt?.getTime()).toBe(
        conversation.pendingTurnStartedAt!.getTime() + 60_000,
      );
    } finally {
      releaseFirst.release();
      restoreTransactions();
    }
  });

  integrationIt("serializes audio completion before a concurrent text child insert", async () => {
    const fixture = await createArch056RecoveryFixture(1);
    cleanup.push(() => cleanupArch056RecoveryFixture(fixture));
    const audioEventTime = new Date(Date.now() - 5_000);
    const audioMessage = await prisma.conversationMessage.create({
      data: {
        conversationId: fixture.conversationId,
        providerMessageId: `arch056-audio-${fixture.suffix}`,
        direction: "INBOUND",
        senderType: "CUSTOMER",
        status: "DELIVERED",
        content: "",
        contentType: "AUDIO",
        transcriptionStatus: "PENDING",
        createdAt: audioEventTime,
      },
    });
    const audioService = new InboundWhatsAppAudioService();
    const completeAudio = (audioService as any).complete.bind(audioService);
    const service = new ConversationService();
    const audioHasUpdatedParent = createArch056Barrier();
    const releaseAudio = createArch056Barrier();
    const textRequestedParent = createArch056Barrier();
    let textBackendPid = 0;
    const childInsertTransactions: number[] = [];
    const restoreTransactions = patchArch056Transaction(prisma, (index) => ({
      beforeParentLock: async (tx) => {
        if (index !== 1) return;
        const rows = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
        textBackendPid = Number(rows[0].pid);
        textRequestedParent.release();
      },
      afterPendingUpdate: async () => {
        if (index !== 0) return;
        audioHasUpdatedParent.release();
        await withArch056Timeout(releaseAudio.promise, "audio transaction release");
      },
      beforeMessageInsert: async () => {
        childInsertTransactions.push(index);
      },
    }));

    try {
      const audioCompletion = completeAudio(
        audioMessage.id,
        fixture.conversationId,
        "verified audio transcript",
        "test-provider",
        "test-model",
        12_000,
        audioMessage.id,
        audioEventTime,
      );
      await withArch056Timeout(audioHasUpdatedParent.promise, "audio pending-state update");
      const textReceive = service.receiveMessage({
        conversationId: fixture.conversationId,
        providerMessageId: `arch056-text-after-audio-${fixture.suffix}`,
        inReplyToProviderId: null,
        content: "text after audio",
      });
      await withArch056Timeout(textRequestedParent.promise, "text parent request");
      await waitForArch056LockWait(prisma, textBackendPid, "text receive behind audio completion");
      expect(childInsertTransactions).toEqual([]);

      releaseAudio.release();
      await expect(withArch056Timeout(audioCompletion, "audio completion")).resolves.toBe(true);
      await expect(withArch056Timeout(textReceive, "text receive after audio")).resolves.toMatchObject({
        conversationId: fixture.conversationId,
        version: 2,
        duplicate: false,
      });
      const [audioAfter, textAfter, state] = await Promise.all([
        prisma.conversationMessage.findUniqueOrThrow({ where: { id: audioMessage.id } }),
        prisma.conversationMessage.findUniqueOrThrow({
          where: { providerMessageId: `arch056-text-after-audio-${fixture.suffix}` },
        }),
        prisma.conversation.findUniqueOrThrow({
          where: { id: fixture.conversationId },
          select: {
            inboundVersion: true,
            pendingTurnStartedAt: true,
            pendingAiNotBeforeAt: true,
            pendingAiDelayMinutes: true,
            pendingAiControlRevision: true,
          },
        }),
      ]);
      expect(audioAfter).toMatchObject({
        transcriptionStatus: "COMPLETED",
        content: "verified audio transcript",
      });
      expect(textAfter.content).toBe("text after audio");
      expect(childInsertTransactions).toEqual([1]);
      expect(state).toMatchObject({
        inboundVersion: 2,
        pendingAiDelayMinutes: 1,
        pendingAiControlRevision: 3,
      });
      expect(state.pendingAiNotBeforeAt?.getTime()).toBe(
        state.pendingTurnStartedAt!.getTime() + 60_000,
      );
    } finally {
      releaseAudio.release();
      restoreTransactions();
    }
  });

});
