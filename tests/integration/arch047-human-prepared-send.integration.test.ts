import "dotenv/config";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { humanDispatchFixture } from "./fixtures/recovery-human-dispatch.fixture.js";
import { sha256Text, PostgresModerationAssessmentService } from
  "../../src/services/conversation-moderation/moderation-assessment.service.js";
import { digest, stableJson } from "../../src/services/conversation-wrappers/projection.js";
import type { PreparedWrapper } from "../../src/services/conversation-wrappers/contracts.js";
import type { ModerationOperation } from "../../src/services/conversation-moderation/moderation-operation.js";

const suite = process.env.TEST_DATABASE_URL && process.env.REDIS_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

const compiled: PreparedWrapper = {
  schemaVersion: 1, family: "MODA_CONVERSATION_WRAPPER", responseSlot: "response.body",
  header: [{ kind: "text", value: "Wrapper-only header: " }],
  body: [{ kind: "responseSlot", name: "response.body" }],
  footer: [{ kind: "text", value: " Terms apply." }], conditionals: [],
};

suite("ARCH-047 BG009 PostgreSQL prepared human send", () => {
  async function withPublishedWrapper(f: Awaited<ReturnType<typeof humanDispatchFixture>>) {
    const adminId = randomUUID();
    const definitionId = `wtdef_${digest(randomUUID())}`;
    await f.db.platformAdmin.create({ data: {
      id: adminId, email: `bg009-${adminId}@example.test`, role: "SUPER_ADMIN",
    } });
    await f.db.shop.update({ where: { id: f.shopId }, data: { defaultLanguageTag: "en" } });
    await f.db.whatsAppTemplateDefinition.create({ data: {
      id: definitionId, kind: "MODA_CONVERSATION_WRAPPER", audience: "SHARED",
      sourceLanguageTag: "en", astSchemaVersion: 1, sourceHash: digest(randomUUID()),
      status: "PUBLISHED", publishedAt: new Date(), createdByAdminId: adminId,
    } });
    const contentHash = digest(stableJson(compiled));
    await f.db.whatsAppTemplateLocale.create({ data: {
      definitionId, languageTag: "en", status: "SOURCE_SAVED", contentHash,
      localeAst: { schemaVersion: 1, prepared: compiled },
    } });
    await f.db.whatsAppConversationWrapperActiveSlot.create({ data: {
      audience: "SHARED", definitionId, editVersion: 1, updatedByAdminId: adminId,
    } });
    return async () => {
      await f.db.whatsAppConversationWrapperActiveSlot.delete({ where: { audience: "SHARED" } });
      await f.db.whatsAppTemplateLocale.deleteMany({ where: { definitionId } });
      await f.db.whatsAppTemplateDefinition.delete({ where: { id: definitionId } });
      await f.db.platformAdmin.delete({ where: { id: adminId } });
    };
  }

  it("moderates and sends exactly the committed wrapped message, retaining original intent", async () => {
    const f = await humanDispatchFixture("bg009-wrap-equality");
    let cleanup: (() => Promise<void>) | undefined;
    try {
      cleanup = await withPublishedWrapper(f);
      const original = "Merchant text retained verbatim";
      const commandId = await f.addCommand({ textBody: original });
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const dispatcher = f.dispatcher();
      await dispatcher.processClaim(commandId, claim.leaseToken);
      const command = await f.db.merchantConversationSendCommand.findUniqueOrThrow({ where: { id: commandId } });
      const text = command.preparedTextBody!;
      expect(command.textBody).toBe(original);
      expect(text).toContain("Wrapper-only header: ");
      expect(text).toContain(original);
      expect(text).toContain("Terms apply.");
      expect(command.preparedAt).not.toBeNull();
      expect(command.preparedWrapperEvidence).toMatchObject({ outcome: "RENDERED", audience: "SHARED" });
      const assessment = await f.db.conversationModerationAssessment.findFirstOrThrow({
        where: { merchantSendCommandId: commandId },
      });
      expect(assessment.decision).toBe("ALLOW");
      expect(assessment.contentSha256).toBe(sha256Text(text));
      const outbound = await f.db.conversationMessage.findUniqueOrThrow({ where: { id: command.outboundMessageId! } });
      expect(outbound.content).toBe(text);
      expect(f.provider.sendWhatsAppText).toHaveBeenCalledOnce();
      expect(vi.mocked(f.provider.sendWhatsAppText).mock.calls[0]?.[0].text).toBe(outbound.content);
      expect((await f.commands.claimDueHumanCommands({ limit: 5, now: new Date() })))
        .not.toContainEqual(expect.objectContaining({ id: commandId }));
      await dispatcher.close();
    } finally { if (cleanup) await cleanup(); await f.close(); }
  }, 120_000);

  it("freezes explicit no-wrapper passthrough and uses the same moderated admission path", async () => {
    const f = await humanDispatchFixture("bg009-passthrough");
    try {
      const text = "Original text without any configured wrapper";
      const commandId = await f.addCommand({ textBody: text });
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const dispatcher = f.dispatcher();
      await dispatcher.processClaim(commandId, claim.leaseToken);
      const cmd = await f.db.merchantConversationSendCommand.findUniqueOrThrow({ where: { id: commandId } });
      expect(cmd.textBody).toBe(text);
      expect(cmd.preparedTextBody).toBe(text);
      expect(cmd.preparedWrapperEvidence).toMatchObject({ outcome: "PASSTHROUGH", reason: "NOT_CONFIGURED" });
      expect((await f.db.conversationModerationAssessment.findFirstOrThrow({
        where: { merchantSendCommandId: commandId },
      })).contentSha256).toBe(sha256Text(text));
      const persisted = await f.db.conversationMessage.findUniqueOrThrow({ where: { id: cmd.outboundMessageId! } });
      expect(persisted.content).toBe(text);
      expect(vi.mocked(f.provider.sendWhatsAppText).mock.calls[0]?.[0].text).toBe(persisted.content);
      await dispatcher.close();
    } finally { await f.close(); }
  }, 120_000);

  it("wrapper-only abusive content is BLOCKED before permit or provider send", async () => {
    const f = await humanDispatchFixture("bg009-wrapper-moderation-block");
    let cleanup: (() => Promise<void>) | undefined;
    try {
      cleanup = await withPublishedWrapper(f);
      const commandId = await f.addCommand({ textBody: "Harmless raw message" });
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const operation: ModerationOperation = {
        moderation: { key: "omini.moderation", version: 1,
          value: { baseUrl: "http://127.0.0.1:1/v1/moderations", modelId: "omni-moderation-latest" } },
        providerVersion: 1, openAiApiKey: "bg009-disposable-only",
      };
      const moderator = new PostgresModerationAssessmentService(f.db, async ({ text }) => ({
        flagged: text.includes("Wrapper-only header:"),
        categories: { harassment: text.includes("Wrapper-only header:") },
        categoryScores: { harassment: 0.95 }, returnedModel: "omni-moderation-latest",
      }), undefined, async () => operation);
      const dispatcher = f.dispatcher(undefined, moderator);
      await dispatcher.processClaim(commandId, claim.leaseToken);
      expect((await f.db.conversationModerationAssessment.findFirstOrThrow({
        where: { merchantSendCommandId: commandId },
      })).decision).toBe("BLOCK");
      expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();
      expect((await f.db.merchantConversationSendCommand.findUniqueOrThrow({ where: { id: commandId } }))
        .providerDispatchKey).toBeNull();
      await dispatcher.close();
    } finally { if (cleanup) await cleanup(); await f.close(); }
  }, 120_000);

  it("reuses frozen bytes but suppresses a changed wrapper slot at the final permit", async () => {
    const f = await humanDispatchFixture("bg009-wrapper-slot-changed");
    let cleanup: (() => Promise<void>) | undefined;
    try {
      cleanup = await withPublishedWrapper(f);
      const commandId = await f.addCommand({ textBody: "Please reply tomorrow" });
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const loaded = await f.commands.loadClaimedCommand(commandId, claim.leaseToken);
      expect(loaded.kind).toBe("claimed");
      if (loaded.kind !== "claimed") throw new Error("Expected claimed command");
      const frozen = await f.preparation.freeze(loaded.command, claim.leaseToken);
      expect(frozen.kind).toBe("frozen");
      await f.db.whatsAppConversationWrapperActiveSlot.update({ where: { audience: "SHARED" },
        data: { editVersion: { increment: 1 } } });
      const dispatcher = f.dispatcher();
      await dispatcher.processClaim(commandId, claim.leaseToken);
      expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();
      const command = await f.db.merchantConversationSendCommand.findUniqueOrThrow({ where: { id: commandId } });
      expect(command.providerDispatchKey).toBeNull();
      expect(command.preparedTextBody).toBe(frozen.kind === "frozen" ? frozen.body : null);
      expect(command.state).toBe("CANCELLED");
      await dispatcher.close();
    } finally { if (cleanup) await cleanup(); await f.close(); }
  }, 120_000);
});
