import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { describe, expect, it } from "vitest";
import { allowModerationFixture } from "./fixtures/arch040-allow-moderation.fixture.js";
import { OutboundMessageDeliveryService } from "../../src/services/outbound-whatsapp-admission/outbound-message-delivery.service.js";
import { AiTurnOwnershipService } from "../../src/services/recovery-conversation/ai-turn-ownership.service.js";
import { OutboundSendFenceService } from "../../src/services/recovery-conversation/outbound-send-fence.service.js";
import type { ModerationAssessmentService } from "../../src/services/conversation-moderation/moderation-assessment.service.js";
import { runAiTurnThroughBackgroundMocks } from "./fixtures/arch040-ai-turn.fixture.js";
import { humanDispatchFixture } from "./fixtures/recovery-human-dispatch.fixture.js";
import { ConversationService } from "../../src/services/conversation.service.js";
import {
  ConversationTurnProcessor,
  type ConversationTurnJob,
} from "../../src/services/conversation-turn-processor.service.js";

const suite = process.env.TEST_DATABASE_URL && process.env.REDIS_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

async function waitForCondition(label: string, predicate: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`${label} timed out`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
async function createRecoveryTurnBoundary(
  f: Awaited<ReturnType<typeof humanDispatchFixture>>,
  options: {
    delayMinutes: number;
    ownership?: ConstructorParameters<typeof ConversationTurnProcessor>[0]["ownership"];
    moderation?: ModerationAssessmentService;
  },
) {
  await f.db.shopSettings.upsert({
    where: { shopId: f.shopId },
    create: { shopId: f.shopId, aiResponseDelayMinutes: options.delayMinutes },
    update: { aiResponseDelayMinutes: options.delayMinutes },
  });
  await f.changeOwner("HUMAN", "AI", 1);
  await f.addInitialOutreach();
  const conversation = new ConversationService();
  const inbound = await conversation.receiveMessage({
    conversationId: f.conversationId,
    providerMessageId: `arch054-turn-${randomUUID()}`,
    inReplyToProviderId: null,
    content: "Please help with my basket",
    occurredAt: new Date(),
  });
  const initialState = await conversation.getTurnState(f.conversationId);
  let fixedNow: Date | null = null;
  const ownership = options.ownership ?? new AiTurnOwnershipService(f.db);
  const sender = new OutboundMessageDeliveryService(
    f.db,
    f.provider as unknown as ConstructorParameters<typeof OutboundMessageDeliveryService>[1],
    f.execution as unknown as ConstructorParameters<typeof OutboundMessageDeliveryService>[2],
    new AiTurnOwnershipService(f.db),
    new OutboundSendFenceService(f.db, f.durableEligibility),
    options.moderation ?? allowModerationFixture(),
  );
  const queueName = `arch054-turn-${randomUUID()}`;
  const queueConnection = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  const workerConnection = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  const queue = new Queue<ConversationTurnJob>(queueName, { connection: queueConnection });
  const reservations: string[] = [];
  const agentCalls: number[] = [];
  const processor = new ConversationTurnProcessor({
    queue,
    conversation,
    ownership,
    admission: {
      reserve: async ({ shopId, conversationId }) => {
        reservations.push(conversationId);
        const message = await f.db.conversationMessage.create({ data: {
          conversationId, direction: "OUTBOUND", senderType: "AGENT",
          status: "PENDING", content: "Pending model reply",
        } });
        return { kind: "admitted" as const, shopId, conversationId,
          messageId: message.id, terminal: false, executionScope: "recovery" as const };
      },
      sendPreparedText: (input) => sender.sendPreparedText(input),
      failPrepared: (messageId) => sender.failPrepared(messageId),
    },
    abuseAdmission: { admitSettledTurn: async () => ({ kind: "allowed" as const }) },
    loadTurn: async () => ({
      shopId: f.shopId, to: f.recipient, customerPhone: f.recipient,
      conversationType: "RECOVERY" as const, checkoutRecoveryId: f.recoveryId,
      hasReplyContext: true, context: {}, languageMessage: "Please help with my basket",
    }),
    runAgent: async () => {
      agentCalls.push((await conversation.getTurnState(f.conversationId)).inboundVersion);
      return {
        replyText: "Your basket is ready to recover.",
        detectedLanguageTag: null,
        detectedLanguageConfidence: null,
      };
    },
    aiWrapper: { renderConversationResponse: async (input) => ({
      kind: "no-wrapper" as const, body: input.responseBody, reason: "NOT_CONFIGURED" as const,
    }) },
    getResult: (result) => result,
    now: () => fixedNow ?? new Date(),
    runtimeConfig: { current: () => ({
      conversationQuietWindowMs: 0, conversationMaxSettleWindowMs: 120_000,
    }) } as unknown as ConstructorParameters<typeof ConversationTurnProcessor>[0]["runtimeConfig"],
  });
  const worker = new Worker<ConversationTurnJob>(queueName, async (job: Job<ConversationTurnJob>) => {
    await processor.process(job.data, job);
  }, { connection: workerConnection });
  await worker.waitUntilReady();

  return {
    conversation, inbound, initialState, processor, queue, worker, reservations, agentCalls,
    setNow(value: Date) { fixedNow = value; },
    async enqueue(version = inbound.version) { await processor.enqueue(f.conversationId, version); },
    async close() {
      await worker.close();
      await queue.close();
      await Promise.all([queueConnection.quit(), workerConnection.quit()]);
    },
  };
}

suite("ARCH-040 HUMAN and AI control handover regression", () => {
  it("uses Background-local Aimock and WhatsApp emulator for an allowed AI recovery reply", async () => {
    const f = await humanDispatchFixture("aimock-allowed-ai-turn");
    try {
      const result = await runAiTurnThroughBackgroundMocks(f, { takeoverThenResume: false });
      expect(result.aimockJournal).toEqual(expect.objectContaining({
        requestCount: 1, matchedCount: 1, toolNames: expect.arrayContaining(["finalResponse"]),
      }));
      await f.whatsapp.waitForMessageCount(1);
      expect(f.whatsapp.messages).toHaveLength(1);
      expect(f.whatsapp.messages[0]?.body).toEqual(expect.objectContaining({
        type: "text", to: f.recipient,
        text: expect.objectContaining({ body: "Your basket is ready to recover." }),
      }));
      expect(f.providerHttpRequests).toEqual([{ type: "text" }]);
      expect((await f.db.conversationMessage.findUnique({ where: { id: result.messageId } }))?.status)
        .toBe("SENT");
    } finally { await f.close(); }
  }, 120_000);

  it("uses Background-local Aimock to prove takeover/resume suppresses an in-flight AI reply", async () => {
    const f = await humanDispatchFixture("aimock-stale-ai-turn");
    try {
      const result = await runAiTurnThroughBackgroundMocks(f, { takeoverThenResume: true });
      expect(result.aimockJournal).toEqual(expect.objectContaining({ requestCount: 1, matchedCount: 1 }));
      expect(f.providerHttpRequests).toHaveLength(0);
      await f.whatsapp.assertNoAdditionalMessages({ count: 0, quietMs: 100 });
      expect((await f.db.conversationMessage.findUnique({ where: { id: result.messageId } }))?.status)
        .toBe("FAILED");
      const control = await f.db.conversation.findUniqueOrThrow({ where: { id: f.conversationId },
        select: { controlMode: true, controlRevision: true } });
      expect(control).toEqual({ controlMode: "AI", controlRevision: 4 });
    } finally { await f.close(); }
  }, 120_000);

  it("live AI outbound sender refuses an old revision even after takeover and Resume AI", async () => {
    const f = await humanDispatchFixture("stale-ai-reply");
    try {
      // AI turn starts at revision 2. HUMAN takes over at 3; Resume AI at 4
      // must not revive the response generated under revision 2.
      await f.changeOwner("HUMAN", "AI", 1);
      const originalRevision = 2;
      await f.changeOwner("AI", "HUMAN", 2);
      await f.changeOwner("HUMAN", "AI", 3);
      const message = await f.db.conversationMessage.create({ data: {
        conversationId: f.conversationId, direction: "OUTBOUND", senderType: "AGENT",
        status: "PENDING", content: "Stale model answer",
      } });
      const sender = new OutboundMessageDeliveryService(
        f.db,
        f.provider as unknown as ConstructorParameters<typeof OutboundMessageDeliveryService>[1],
        f.execution as unknown as ConstructorParameters<typeof OutboundMessageDeliveryService>[2],
        new AiTurnOwnershipService(f.db),
        new OutboundSendFenceService(f.db, f.durableEligibility),
        allowModerationFixture(),
      );
      const result = await sender.sendPreparedText({
        kind: "admitted", shopId: f.shopId, conversationId: f.conversationId,
        messageId: message.id, terminal: false, executionScope: "recovery",
        to: f.recipient, text: "Stale model answer", expectedControlRevision: originalRevision,
      });
      expect(result).toEqual({ kind: "suppressed", reason: "conversation-invalid" });
      expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();
      expect(f.durableEligibility).not.toHaveBeenCalled();
      expect((await f.db.conversationMessage.findUnique({ where: { id: message.id } }))?.status).toBe("FAILED");
    } finally { await f.close(); }
  }, 60_000);

  it("keeps the recovery AI deadline frozen across newer inbound and executes only when due", async () => {
    const f = await humanDispatchFixture("bg002-recovery-delay");
    const turn = await createRecoveryTurnBoundary(f, { delayMinutes: 1 });
    try {
      const acceleratedDeadline = new Date(Date.now() + 3_000);
      await f.db.conversation.update({ where: { id: f.conversationId }, data: {
        pendingAiNotBeforeAt: acceleratedDeadline,
      } });
      turn.initialState.pendingAiNotBeforeAt = acceleratedDeadline;
      await turn.enqueue();
      const firstJobId = `conversation-turn__${f.conversationId}__${turn.inbound.version}`;
      await waitForCondition("first recovery job delayed", async () => {
        const job = await turn.queue.getJob(firstJobId);
        return job !== undefined && await job.getState() === "delayed";
      });
      expect(turn.reservations).toHaveLength(0);
      expect(turn.agentCalls).toHaveLength(0);

      const deadline = turn.initialState.pendingAiNotBeforeAt;
      const startedAt = turn.initialState.pendingTurnStartedAt;
      const newer = await turn.conversation.receiveMessage({
        conversationId: f.conversationId,
        providerMessageId: `arch054-followup-${randomUUID()}`,
        inReplyToProviderId: null,
        content: "One more detail",
        occurredAt: new Date(),
      });
      const updated = await turn.conversation.getTurnState(f.conversationId);
      expect(newer.version).toBe(turn.inbound.version + 1);
      expect(updated.pendingAiNotBeforeAt).toEqual(deadline);
      expect(updated.pendingTurnStartedAt).toEqual(startedAt);
      await turn.enqueue(newer.version);
      await turn.enqueue(newer.version);
      await turn.enqueue(turn.inbound.version);

      await waitForCondition("due recovery turn completed", async () => {
        const current = await turn.conversation.getTurnState(f.conversationId);
        return current.lastProcessedVersion === newer.version;
      }, 15_000);
      expect(turn.agentCalls).toEqual([newer.version]);
      expect(turn.reservations).toHaveLength(1);
      expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(1);
    } finally { await turn.close(); await f.close(); }
  }, 45_000);

  it("rejects a recovery permit when newer inbound commits during the final ownership await", async () => {
    const f = await humanDispatchFixture("bg002-final-inbound-fence");
    let releaseFinalCheck!: () => void;
    let signalFinalCheck!: () => void;
    const finalCheck = new Promise<void>((resolve) => { signalFinalCheck = resolve; });
    const continueCheck = new Promise<void>((resolve) => { releaseFinalCheck = resolve; });
    const realOwnership = new AiTurnOwnershipService(f.db);
    const ownership = {
      readTurnOwnership: (conversationId: string) => realOwnership.readTurnOwnership(conversationId),
      checkAutomatedTurn: async (input: Parameters<AiTurnOwnershipService["checkAutomatedTurn"]>[0]) => {
        const decision = await realOwnership.checkAutomatedTurn(input);
        if (input.phase === "before-provider" && decision.kind === "allowed") {
          signalFinalCheck();
          await continueCheck;
        }
        return decision;
      },
    };
    const turn = await createRecoveryTurnBoundary(f, { delayMinutes: 0, ownership });
    try {
      const processing = turn.processor.process({
        conversationId: f.conversationId,
        observedVersion: turn.inbound.version,
      });
      await finalCheck;
      const newer = await turn.conversation.receiveMessage({
        conversationId: f.conversationId,
        providerMessageId: `arch054-racing-inbound-${randomUUID()}`,
        inReplyToProviderId: null,
        content: "Actually, one more thing",
        occurredAt: new Date(),
      });
      releaseFinalCheck();
      await processing;

      const prepared = await f.db.conversationMessage.findFirstOrThrow({
        where: { conversationId: f.conversationId, direction: "OUTBOUND", senderType: "AGENT" },
      });
      expect(newer.version).toBeGreaterThan(turn.inbound.version);
      expect(prepared.status).toBe("FAILED");
      expect(prepared.providerDispatchKey).toBeNull();
      expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();
      expect(await turn.queue.getJob(`conversation-turn__${f.conversationId}__${newer.version}`))
        .toBeDefined();
    } finally { releaseFinalCheck(); await turn.close(); await f.close(); }
  }, 60_000);

  it("rejects a recovery permit when newer inbound commits during outbound moderation", async () => {
    const f = await humanDispatchFixture("bg002-moderation-inbound-fence");
    let releaseModeration!: () => void;
    let signalModeration!: () => void;
    const moderationReached = new Promise<void>((resolve) => { signalModeration = resolve; });
    const continueModeration = new Promise<void>((resolve) => { releaseModeration = resolve; });
    const moderation = allowModerationFixture();
    moderation.requireCurrentAllowance = async () => {
      signalModeration();
      await continueModeration;
      return true;
    };
    const turn = await createRecoveryTurnBoundary(f, { delayMinutes: 0, moderation });
    try {
      const processing = turn.processor.process({
        conversationId: f.conversationId,
        observedVersion: turn.inbound.version,
      });
      await moderationReached;
      const newer = await turn.conversation.receiveMessage({
        conversationId: f.conversationId,
        providerMessageId: `arch054-moderation-inbound-${randomUUID()}`,
        inReplyToProviderId: null,
        content: "Correction while your answer is being checked",
        occurredAt: new Date(),
      });
      releaseModeration();
      await processing;

      const prepared = await f.db.conversationMessage.findFirstOrThrow({
        where: { conversationId: f.conversationId, direction: "OUTBOUND", senderType: "AGENT" },
      });
      expect(newer.version).toBeGreaterThan(turn.inbound.version);
      expect(prepared.status).toBe("FAILED");
      expect(prepared.providerDispatchKey).toBeNull();
      expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();
    } finally { releaseModeration(); await turn.close(); await f.close(); }
  }, 60_000);

  it("keeps a permit that commits before a later inbound message", async () => {
    const f = await humanDispatchFixture("bg002-permit-wins-inbound-race");
    let releaseProvider!: () => void;
    let signalProvider!: () => void;
    const providerReached = new Promise<void>((resolve) => { signalProvider = resolve; });
    const continueProvider = new Promise<void>((resolve) => { releaseProvider = resolve; });
    f.provider.sendWhatsAppText.mockImplementationOnce(async () => {
      signalProvider();
      await continueProvider;
      return { providerMessageId: "wamid-permit-won" };
    });
    const turn = await createRecoveryTurnBoundary(f, { delayMinutes: 0 });
    try {
      const processing = turn.processor.process({
        conversationId: f.conversationId,
        observedVersion: turn.inbound.version,
      });
      await providerReached;
      const prepared = await f.db.conversationMessage.findFirstOrThrow({
        where: { conversationId: f.conversationId, direction: "OUTBOUND", senderType: "AGENT" },
      });
      expect(prepared.providerDispatchKey).not.toBeNull();

      const newer = await turn.conversation.receiveMessage({
        conversationId: f.conversationId,
        providerMessageId: `arch054-after-permit-${randomUUID()}`,
        inReplyToProviderId: null,
        content: "A later message after admission",
        occurredAt: new Date(),
      });
      expect(newer.version).toBeGreaterThan(turn.inbound.version);
      releaseProvider();
      await processing;

      const sent = await f.db.conversationMessage.findUniqueOrThrow({ where: { id: prepared.id } });
      expect(sent.status).toBe("SENT");
      expect(sent.providerDispatchKey).not.toBeNull();
      expect(f.provider.sendWhatsAppText).toHaveBeenCalledOnce();
    } finally { releaseProvider(); await turn.close(); await f.close(); }
  }, 60_000);
});
