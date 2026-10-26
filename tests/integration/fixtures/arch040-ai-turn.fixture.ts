import { randomUUID } from "node:crypto";
import type { ModerationAssessmentService } from "../../../src/services/conversation-moderation/moderation-assessment.service.js";
import { allowModerationFixture } from "./arch040-allow-moderation.fixture.js";
import { ConversationTurnProcessor } from "../../../src/services/conversation-turn-processor.service.js";
import { OutboundMessageDeliveryService } from "../../../src/services/outbound-whatsapp-admission/outbound-message-delivery.service.js";
import { AiTurnOwnershipService } from "../../../src/services/recovery-conversation/ai-turn-ownership.service.js";
import { OutboundSendFenceService } from "../../../src/services/recovery-conversation/outbound-send-fence.service.js";
import type { humanDispatchFixture } from "./recovery-human-dispatch.fixture.js";

const USER_MESSAGE = "Please help me recover my basket";
const SYSTEM_MESSAGE = "System-test scenario ARCH-040-BACKGROUND-002";

type Fixture = Awaited<ReturnType<typeof humanDispatchFixture>>;
type ModelAnswer = { replyText: string; detectedLanguageTag: string | null; detectedLanguageConfidence: number | null };

/** Invoke the pinned pinned Aimock HTTP endpoint with the same strict
 * finalResponse tool-call protocol used by the CommerceAgent system tests.
 * This is a controlled model boundary, not an in-process synthetic answer.
 */
async function queryAimock(baseUrl: string): Promise<ModelAnswer> {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/.test(baseUrl)) {
    throw new Error("ARCH-040 refused a non-loopback Aimock endpoint");
  }
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer arch040-disposable-test", "content-type": "application/json" },
    body: JSON.stringify({
      model: "openrouter/system-test",
      messages: [
        { role: "system", content: SYSTEM_MESSAGE },
        { role: "user", content: USER_MESSAGE },
      ],
      tools: [{
        type: "function", function: { name: "finalResponse", description: "Return a final answer",
          parameters: { type: "object", properties: { replyText: { type: "string" } }, required: ["replyText"] },
      } }],
    }),
  });
  if (!response.ok) throw new Error(`ARCH-040 Aimock returned HTTP ${response.status}`);
  const body = await response.json() as {
    choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>;
  };
  const tool = body.choices?.[0]?.message?.tool_calls?.[0]?.function;
  if (tool?.name !== "finalResponse" || !tool.arguments) {
    throw new Error("ARCH-040 Aimock did not produce a finalResponse tool call");
  }
  const answer = JSON.parse(tool.arguments) as Partial<ModelAnswer>;
  if (!answer.replyText || typeof answer.replyText !== "string") {
    throw new Error("ARCH-040 Aimock response did not contain replyText");
  }
  return {
    replyText: answer.replyText,
    detectedLanguageTag: answer.detectedLanguageTag ?? null,
    detectedLanguageConfidence: answer.detectedLanguageConfidence ?? null,
  };
}

/** Exercise the actual Background ConversationTurnProcessor revision snapshots,
 * admission delivery and final provider fence, using the Background-local Aimock
 * and WhatsApp HTTP emulator. The prepared admission is a deterministic fixture;
 * billing-plan/credit ledger certification belongs to system-test.
 */
export async function runAiTurnThroughBackgroundMocks(
  f: Fixture, options: { takeoverThenResume: boolean; moderation?: ModerationAssessmentService },
) {
  const aimock = await f.startAimock();
  const url = aimock.snapshot().openRouterBaseUrl;
  if (!url) throw new Error("ARCH-040 Aimock is not ready");

  // A previously HUMAN conversation resumes AI at revision 2. The turn must
  // retain this original revision even if takeover/resume happens mid-model.
  await f.changeOwner("HUMAN", "AI", 1);
  const pendingAt = new Date(Date.now() - 60_000);
  await f.addInitialOutreach();
  await f.db.conversationMessage.create({ data: {
    conversationId: f.conversationId, direction: "INBOUND", senderType: "CUSTOMER",
    providerMessageId: `arch040-ai-inbound-${randomUUID()}`,
    status: "DELIVERED", content: USER_MESSAGE, createdAt: pendingAt,
  } });
  await f.db.conversation.update({ where: { id: f.conversationId }, data: {
    inboundVersion: 1, lastProcessedVersion: 0,
    lastInboundAt: pendingAt, pendingTurnStartedAt: pendingAt,
    processingInboundVersion: null, processingStartedAt: null,
  } });
  const prepared = await f.db.conversationMessage.create({ data: {
    conversationId: f.conversationId, senderType: "AGENT", direction: "OUTBOUND",
    status: "PENDING", content: "Pending model reply",
  } });
  const sender = new OutboundMessageDeliveryService(
    f.db,
    f.provider as unknown as ConstructorParameters<typeof OutboundMessageDeliveryService>[1],
    f.execution as unknown as ConstructorParameters<typeof OutboundMessageDeliveryService>[2],
    new AiTurnOwnershipService(f.db),
    new OutboundSendFenceService(f.db, f.durableEligibility),
    options.moderation ?? allowModerationFixture(),
  );
  const conversation = {
    getTurnState: async (id: string) => f.db.conversation.findUniqueOrThrow({
      where: { id }, select: {
        inboundVersion: true, lastProcessedVersion: true, lastInboundAt: true,
        pendingTurnStartedAt: true, processingInboundVersion: true, processingStartedAt: true,
      },
    }),
    claimTurn: async (id: string, version: number, now: Date) =>
      (await f.db.conversation.updateMany({
        where: { id, inboundVersion: version, lastProcessedVersion: { lt: version },
          pendingTurnStartedAt: { not: null }, processingInboundVersion: null },
        data: { processingInboundVersion: version, processingStartedAt: now },
      })).count === 1,
    completeTurn: async (id: string, version: number) =>
      (await f.db.conversation.updateMany({
        where: { id, inboundVersion: version, processingInboundVersion: version },
        data: { lastProcessedVersion: version, pendingTurnStartedAt: null,
          processingInboundVersion: null, processingStartedAt: null },
      })).count === 1,
    releaseTurn: async (id: string, version: number) => {
      await f.db.conversation.updateMany({ where: { id, processingInboundVersion: version },
        data: { processingInboundVersion: null, processingStartedAt: null } });
    },
    hasChanged: async (id: string, version: number) => {
      const row = await f.db.conversation.findUniqueOrThrow({ where: { id },
        select: { inboundVersion: true, processingInboundVersion: true } });
      return row.inboundVersion !== version || row.processingInboundVersion !== version;
    },
    applyDetectedLanguage: async () => true,
  };
  const processor = new ConversationTurnProcessor({
    queue: { add: async () => {} },
    conversation,
    ownership: new AiTurnOwnershipService(f.db),
    admission: {
      reserve: async () => ({ kind: "admitted" as const, shopId: f.shopId,
        conversationId: f.conversationId, messageId: prepared.id, terminal: false,
        executionScope: "recovery" as const }),
      sendPreparedText: (input) => sender.sendPreparedText(input),
      failPrepared: (messageId) => sender.failPrepared(messageId),
    },
    abuseAdmission: { admitSettledTurn: async () => ({ kind: "allowed" as const }) },
    loadTurn: async () => ({
      shopId: f.shopId, to: f.recipient, customerPhone: f.recipient,
      conversationType: "RECOVERY" as const, checkoutRecoveryId: f.recoveryId,
      hasReplyContext: true, context: {}, languageMessage: USER_MESSAGE,
    }),
    aiWrapper: { renderConversationResponse: async (input) => ({
      kind: "no-wrapper" as const, body: input.responseBody, reason: "NOT_CONFIGURED" as const,
    }) },
    runAgent: async () => {
      const answer = await queryAimock(url);
      if (options.takeoverThenResume) {
        await f.changeOwner("AI", "HUMAN", 2);
        await f.changeOwner("HUMAN", "AI", 3);
      }
      return answer;
    },
    getResult: (answer) => answer,
    runtimeConfig: { current: () => ({
      conversationQuietWindowMs: 0, conversationMaxSettleWindowMs: 0,
    }) } as unknown as ConstructorParameters<typeof ConversationTurnProcessor>[0]["runtimeConfig"],
  });
  await processor.process({ conversationId: f.conversationId, observedVersion: 1 });
  return { messageId: prepared.id, aimockJournal: await aimock.journalSummary() };
}
