import "dotenv/config";
import { describe, expect, it } from "vitest";
import { PostgresModerationAssessmentService, sha256Text } from "../../src/services/conversation-moderation/moderation-assessment.service.js";
import { ModerationTurnGate } from "../../src/services/conversation-moderation/moderation-turn-gate.js";
import { moderationConfig } from "../../src/services/conversation-moderation/moderation-policy.js";
import { allowedHistoryCandidates } from "../../src/services/conversation-moderation/moderation-history.js";
import { humanDispatchFixture } from "./fixtures/recovery-human-dispatch.fixture.js";
import { runAiTurnThroughBackgroundMocks } from "./fixtures/arch040-ai-turn.fixture.js";
import { startArch040ModerationAimock } from "./fixtures/arch040-moderation-aimock.fixture.js";
import { OutboundMessageDeliveryService } from "../../src/services/outbound-whatsapp-admission/outbound-message-delivery.service.js";
import { AiTurnOwnershipService } from "../../src/services/recovery-conversation/ai-turn-ownership.service.js";
import { OutboundSendFenceService } from "../../src/services/recovery-conversation/outbound-send-fence.service.js";
import { prepareAutomatedTemplateInput } from "../../src/services/conversation-moderation/automated-template-input.js";

const suite = process.env.TEST_DATABASE_URL && process.env.REDIS_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

async function moderatedFixture(name: string, options: { blockedTexts?: string[] } = {}) {
  const f = await humanDispatchFixture(name);
  try {
    const aimock = await startArch040ModerationAimock(options);
    return {
      f, aimock,
      async close() {
        try { await aimock.close(); } finally { await f.close(); }
      },
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}

function assertModerationHttp(
  journal: Array<{ path?: string; input?: unknown; model?: unknown; status?: number }>,
  inputs: string[], statuses: number[] = inputs.map(() => 200),
) {
  expect(journal).toEqual(inputs.map((input, index) => ({
    path: "/v1/moderations", input, model: "omni-moderation-latest", status: statuses[index],
  })));
}

suite("ARCH-040 BACKGROUND-006 persisted moderation with B002-local AI and WhatsApp mocks", () => {
  it("moderates verified inbound content before a turn, keeps flagged messages and permits later safe content", async () => {
    const { f, aimock, close } = await moderatedFixture("moderation-inbound");
    const service = new PostgresModerationAssessmentService(f.db, aimock.moderate, undefined, aimock.readOperation);
    const gate = new ModerationTurnGate(service);
    try {
      const started = new Date(Date.now() - 2_000);
      const blocked = await f.db.conversationMessage.create({ data: {
        conversationId: f.conversationId, direction: "INBOUND", senderType: "CUSTOMER",
        status: "DELIVERED", content: "moderation-fixture-block", createdAt: new Date(started.getTime() + 100),
      } });
      expect(await gate.moderatePending(f.conversationId, started)).toBe("suppressed");
      expect((await f.db.conversationMessage.findUnique({ where: { id: blocked.id } }))?.content)
        .toBe("moderation-fixture-block");
      expect((await f.db.conversationModerationAssessment.findFirst({
        where: { conversationMessageId: blocked.id }, select: { decision: true },
      }))?.decision).toBe("BLOCK");
      await f.db.conversationMessage.create({ data: {
        conversationId: f.conversationId, direction: "INBOUND", senderType: "CUSTOMER",
        status: "DELIVERED", content: "How do I find my order?", createdAt: new Date(started.getTime() + 200),
      } });
      expect(await gate.moderatePending(f.conversationId, started)).toBe("allowed");
      const safe = await allowedHistoryCandidates([
        { id: blocked.id, direction: "INBOUND", senderType: "CUSTOMER", content: "moderation-fixture-block" },
      ], aimock.readOperation);
      expect(safe).toHaveLength(0); // blocked text never enters normal CommerceAgent history
      assertModerationHttp(aimock.journal(), ["moderation-fixture-block", "How do I find my order?"]); // cached BLOCK was not reclassified
      expect(await gate.moderatePending(f.conversationId, started)).toBe("allowed");
      assertModerationHttp(aimock.journal(), ["moderation-fixture-block", "How do I find my order?"]);
    } finally { await close(); }
  }, 120_000);

  it("refuses an unsupported image without fabricating an approval or calling OpenAI", async () => {
    const { f, aimock, close } = await moderatedFixture("moderation-media");
    try {
      const started = new Date(Date.now() - 2_000);
      const image = await f.db.conversationMessage.create({ data: {
        conversationId: f.conversationId, direction: "INBOUND", senderType: "CUSTOMER",
        contentType: "UNSUPPORTED", content: "[unsupported image]", createdAt: started,
      } });
      const gate = new ModerationTurnGate(new PostgresModerationAssessmentService(f.db, aimock.moderate, undefined, aimock.readOperation));
      expect(await gate.moderatePending(f.conversationId, new Date(started.getTime() - 10))).toBe("suppressed");
      expect(await f.db.conversationModerationAssessment.count({ where: { conversationMessageId: image.id, decision: "ALLOW" } })).toBe(0);
      expect(aimock.journal()).toHaveLength(0);
    } finally { await close(); }
  }, 120_000);

  it("BLOCK on a HUMAN command terminates it before billing and WhatsApp emulator", async () => {
    const { f, aimock, close } = await moderatedFixture("moderation-human-block");
    try {
      // Verified customer inbound opens the HUMAN text service window.
      const inboundAt = new Date(Date.now() - 5_000);
      await f.db.conversationMessage.create({ data: {
        conversationId: f.conversationId, direction: "INBOUND", senderType: "CUSTOMER",
        content: "Please contact me about my order", status: "DELIVERED", createdAt: inboundAt,
      } });
      await f.db.conversation.update({ where: { id: f.conversationId },
        data: { lastInboundAt: inboundAt } });
      const commandId = await f.addCommand({ textBody: "moderation-fixture-block" });
      const service = new PostgresModerationAssessmentService(f.db, aimock.moderate, undefined, aimock.readOperation);
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      await f.dispatcher(undefined, service).processClaim(commandId, claim.leaseToken);
      const decision = await f.db.conversationModerationAssessment.findFirst({
        where: { merchantSendCommandId: commandId },
      });
      expect(decision?.decision).toBe("BLOCK");
      assertModerationHttp(aimock.journal(), ["moderation-fixture-block"]);
      expect(await f.db.conversationMessage.count({ where: { conversationId: f.conversationId, senderType: "HUMAN" } })).toBe(0);
      expect(f.providerHttpRequests).toHaveLength(0);
      expect(f.billing.admitAndRevalidate).not.toHaveBeenCalled();
    } finally { await close(); }
  }, 120_000);

  it("moderates real Aimock output before B002 WhatsApp HTTP emulator send; reuses ALLOW", async () => {
    const { f, aimock, close } = await moderatedFixture("moderation-aimock-meta");
    try {
      const service = new PostgresModerationAssessmentService(f.db, aimock.moderate, undefined, aimock.readOperation);
      const turn = await runAiTurnThroughBackgroundMocks(f, {
        takeoverThenResume: false, moderation: service,
      });
      expect(turn.aimockJournal.requestCount).toBe(1);
      await f.whatsapp.waitForMessageCount(1);
      expect(f.providerHttpRequests).toHaveLength(1);
      const record = await f.db.conversationModerationAssessment.findFirst({ where: {
        conversationMessageId: turn.messageId, decision: "ALLOW",
      } });
      expect(record).toEqual(expect.objectContaining({
        contentSha256: sha256Text("Your basket is ready to recover."),
        policyVersion: moderationConfig().policyVersion,
      }));
      assertModerationHttp(aimock.journal(), ["Your basket is ready to recover."]);
      expect(await service.requireCurrentAllowance({
        subject: { kind: "AGENT_MESSAGE", messageId: turn.messageId },
        effectiveText: "Your basket is ready to recover.", policyVersion: moderationConfig().policyVersion,
      })).toBe(true);
      assertModerationHttp(aimock.journal(), ["Your basket is ready to recover."]);
    } finally { await close(); }
  }, 120_000);

  it("Aimock-generated flagged AGENT output cannot reach B002 WhatsApp emulator", async () => {
    const { f, aimock, close } = await moderatedFixture("moderation-aimock-block", {
      blockedTexts: ["Your basket is ready to recover."],
    });
    try {
      const service = new PostgresModerationAssessmentService(f.db, aimock.moderate, undefined, aimock.readOperation);
      const result = await runAiTurnThroughBackgroundMocks(f, {
        takeoverThenResume: false, moderation: service,
      });
      expect(result.aimockJournal.requestCount).toBe(1);
      expect(f.providerHttpRequests).toHaveLength(0);
      await f.whatsapp.assertNoAdditionalMessages({ count: 0, quietMs: 100 });
      expect((await f.db.conversationMessage.findUnique({ where: { id: result.messageId } }))?.status).toBe("FAILED");
      expect((await f.db.conversationModerationAssessment.findFirst({
        where: { conversationMessageId: result.messageId },
      }))?.decision).toBe("BLOCK");
      assertModerationHttp(aimock.journal(), ["Your basket is ready to recover."]);
    } finally { await close(); }
  }, 120_000);

  it("allows a moderated AUTOMATION template through B002 WhatsApp emulator with the exact parameter digest", async () => {
    const { f, aimock, close } = await moderatedFixture("moderation-automation-template-allow");
    try {
      await f.changeOwner("HUMAN", "AI", 1);
      const message = await f.db.conversationMessage.create({ data: {
        conversationId: f.conversationId, direction: "OUTBOUND", senderType: "AUTOMATION",
        status: "PENDING", content: "[Pending automated template]",
      } });
      const moderation = new PostgresModerationAssessmentService(f.db, aimock.moderate, undefined, aimock.readOperation);
      const delivery = new OutboundMessageDeliveryService(f.db, f.provider, f.execution,
        new AiTurnOwnershipService(f.db), new OutboundSendFenceService(f.db, async () => null), moderation,
        undefined, undefined,
        // The fixture proves template/moderation delivery, not Shopify/Meta reads.
        { preflight: async () => ({ kind: "allowed", snapshot: null }) },
        { verify: async () => "MARKETING" });
      const template = { to: f.recipient, templateName: "checkout_recovery", languageCode: "en_US",
        bodyParameters: ["Your basket is ready to recover.", "cart-123"] };
      const expected = prepareAutomatedTemplateInput(template).effectiveText;
      expect(await delivery.sendPreparedTemplate({
        kind: "admitted", shopId: f.shopId, conversationId: f.conversationId,
        messageId: message.id, terminal: false, executionScope: "recovery",
      }, template)).toMatchObject({ kind: "admitted" });
      await f.whatsapp.waitForMessageCount(1);
      expect(f.providerHttpRequests).toHaveLength(1);
      expect((await f.db.conversationMessage.findUnique({ where: { id: message.id } })))
        .toMatchObject({ content: expected, status: "SENT" });
      expect(await f.db.conversationModerationAssessment.findFirst({
        where: { conversationMessageId: message.id, decision: "ALLOW" },
      })).toMatchObject({ contentSha256: sha256Text(expected), inputKind: "TEXT" });
      expect(await moderation.requireCurrentAllowance({ subject: { kind: "AUTOMATION_MESSAGE", messageId: message.id },
        effectiveText: expected, policyVersion: moderationConfig().policyVersion })).toBe(true);
      assertModerationHttp(aimock.journal(), [expected]);
    } finally { await close(); }
  }, 120_000);

  it("blocks changed AUTOMATION template parameters rather than reusing an earlier ALLOW", async () => {
    const { f, aimock, close } = await moderatedFixture("moderation-automation-template-block", {
      blockedTexts: ["moderation-fixture-block"],
    });
    try {
      await f.changeOwner("HUMAN", "AI", 1);
      const message = await f.db.conversationMessage.create({ data: {
        conversationId: f.conversationId, direction: "OUTBOUND", senderType: "AUTOMATION",
        status: "PENDING", content: "[Pending automated template]",
      } });
      const subject = { kind: "AUTOMATION_MESSAGE" as const, messageId: message.id };
      const moderation = new PostgresModerationAssessmentService(f.db, aimock.moderate, undefined, aimock.readOperation);
      const allowedTemplate = { to: f.recipient, templateName: "checkout_recovery", languageCode: "en_US",
        bodyParameters: ["Customer-safe value"] };
      const oldContent = prepareAutomatedTemplateInput(allowedTemplate).effectiveText;
      await f.db.conversationMessage.update({ where: { id: message.id }, data: { content: oldContent } });
      expect((await moderation.assessText({ subject, shopId: f.shopId, conversationId: f.conversationId,
        effectiveText: oldContent, inputKind: "TEXT", policyVersion: moderationConfig().policyVersion,
        now: new Date() })).kind).toBe("allow");
      const blockedTemplate = { ...allowedTemplate, bodyParameters: ["moderation-fixture-block"] };
      const blockedContent = prepareAutomatedTemplateInput(blockedTemplate).effectiveText;
      const delivery = new OutboundMessageDeliveryService(f.db, f.provider, f.execution,
        new AiTurnOwnershipService(f.db), new OutboundSendFenceService(f.db, async () => null), moderation);
      expect(await delivery.sendPreparedTemplate({
        kind: "admitted", shopId: f.shopId, conversationId: f.conversationId,
        messageId: message.id, terminal: false, executionScope: "recovery",
      }, blockedTemplate)).toMatchObject({ kind: "suppressed" });
      expect(f.providerHttpRequests).toHaveLength(0);
      await f.whatsapp.assertNoAdditionalMessages({ count: 0, quietMs: 100 });
      expect(await f.db.conversationModerationAssessment.findMany({
        where: { conversationMessageId: message.id }, select: { decision: true, contentSha256: true },
      })).toEqual(expect.arrayContaining([
        { decision: "ALLOW", contentSha256: sha256Text(oldContent) },
        { decision: "BLOCK", contentSha256: sha256Text(blockedContent) },
      ]));
      expect(await moderation.requireCurrentAllowance({ subject, effectiveText: blockedContent,
        policyVersion: moderationConfig().policyVersion })).toBe(false);
      assertModerationHttp(aimock.journal(), [oldContent, blockedContent]);
    } finally { await close(); }
  }, 120_000);

  it("a terminal ALLOW does not approve changed text or a new policy, including duplicate inbound", async () => {
    const { f, aimock, close } = await moderatedFixture("moderation-content-revision");
    const service = new PostgresModerationAssessmentService(f.db, aimock.moderate, undefined, aimock.readOperation);
    try {
      const msg = await f.db.conversationMessage.create({ data: {
        conversationId: f.conversationId, direction: "INBOUND", senderType: "CUSTOMER",
        content: "Safe first response", status: "DELIVERED",
      } });
      const subject = { kind: "CUSTOMER_MESSAGE" as const, messageId: msg.id };
      const original = { subject, shopId: f.shopId, conversationId: f.conversationId,
        effectiveText: "Safe first response", inputKind: "TEXT" as const,
        policyVersion: moderationConfig().policyVersion, now: new Date() };
      expect((await service.assessText(original)).kind).toBe("allow");
      expect((await service.assessText(original)).kind).toBe("allow");
      assertModerationHttp(aimock.journal(), ["Safe first response"]);
      await f.db.conversationMessage.update({ where: { id: msg.id },
        data: { content: "Second response needs fresh approval" } });
      expect(await service.requireCurrentAllowance({ subject, effectiveText: original.effectiveText,
        policyVersion: original.policyVersion })).toBe(false);
      expect((await service.assessText({ ...original, effectiveText: "Second response needs fresh approval" })).kind).toBe("allow");
      assertModerationHttp(aimock.journal(), ["Safe first response", "Second response needs fresh approval"]);
      expect(await f.db.conversationModerationAssessment.count({ where: { conversationMessageId: msg.id } })).toBe(2);
    } finally { await close(); }
  }, 120_000);

  it("unknown classifier/network errors retain the same assessment and never yield ALLOW", async () => {
    const { f, aimock, close } = await moderatedFixture("moderation-retry");
    try {
      const message = await f.db.conversationMessage.create({ data: {
        conversationId: f.conversationId, direction: "INBOUND", senderType: "CUSTOMER",
        content: "Ordinary order help question", status: "DELIVERED",
      } });
      await aimock.failNextWith(429, { error: { message: "rate limited", type: "rate_limit_error" } });
      const service = new PostgresModerationAssessmentService(f.db, aimock.moderate, undefined, aimock.readOperation);
      const input = { subject: { kind: "CUSTOMER_MESSAGE" as const, messageId: message.id },
        shopId: f.shopId, conversationId: f.conversationId, effectiveText: message.content,
        inputKind: "TEXT" as const, policyVersion: moderationConfig().policyVersion, now: new Date() };
      expect((await service.assessText(input)).kind).toBe("retry");
      expect((await service.assessText(input)).kind).toBe("retry");
      assertModerationHttp(aimock.journal(), ["Ordinary order help question"], [429]);
      expect(await service.requireCurrentAllowance({ subject: input.subject,
        effectiveText: input.effectiveText, policyVersion: input.policyVersion })).toBe(false);
      expect(await f.db.conversationModerationAssessment.count({
        where: { conversationMessageId: message.id },
      })).toBe(1);
    } finally { await close(); }
  }, 120_000);

  it("malformed HTTP 200 moderation response cannot persist ALLOW or submit to WhatsApp", async () => {
    const { f, aimock, close } = await moderatedFixture("moderation-malformed");
    try {
      const message = await f.db.conversationMessage.create({ data: {
        conversationId: f.conversationId, direction: "INBOUND", senderType: "CUSTOMER",
        content: "Please check my order", status: "DELIVERED",
      } });
      await aimock.failNextWith(200, { model: "omni-moderation-latest", results: [] });
      const service = new PostgresModerationAssessmentService(f.db, aimock.moderate, undefined, aimock.readOperation);
      const subject = { kind: "CUSTOMER_MESSAGE" as const, messageId: message.id };
      const outcome = await service.assessText({
        subject, shopId: f.shopId, conversationId: f.conversationId,
        effectiveText: message.content, inputKind: "TEXT",
        policyVersion: moderationConfig().policyVersion, now: new Date(),
      });
      expect(outcome.kind).toBe("retry");
      assertModerationHttp(aimock.journal(), ["Please check my order"]);
      expect(await f.db.conversationModerationAssessment.findFirst({
        where: { conversationMessageId: message.id }, select: { decision: true },
      })).toEqual({ decision: "RETRYABLE_ERROR" });
      expect(await service.requireCurrentAllowance({ subject, effectiveText: message.content,
        policyVersion: moderationConfig().policyVersion })).toBe(false);
      expect(f.providerHttpRequests).toHaveLength(0);
    } finally { await close(); }
  }, 120_000);

});
