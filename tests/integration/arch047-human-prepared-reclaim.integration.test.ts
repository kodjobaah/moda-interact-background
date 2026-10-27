import "dotenv/config";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { humanDispatchFixture } from "./fixtures/recovery-human-dispatch.fixture.js";
import { sha256Text } from
  "../../src/services/conversation-moderation/moderation-assessment.service.js";
import { moderationConfig } from "../../src/services/conversation-moderation/moderation-policy.js";
import { HumanPreparedCommandService } from
  "../../src/services/recovery-conversation/human-prepared-command.service.js";
import { OutboundSendFenceService } from
  "../../src/services/recovery-conversation/outbound-send-fence.service.js";
import { writeLocalStop } from "../../src/services/whatsapp-contact-opt-out/stop-writer.js";
import { digest, stableJson } from "../../src/services/conversation-wrappers/projection.js";
import type { PreparedWrapper } from "../../src/services/conversation-wrappers/contracts.js";

const suite = process.env.TEST_DATABASE_URL && process.env.REDIS_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

const compiled: PreparedWrapper = {
  schemaVersion: 1, family: "MODA_CONVERSATION_WRAPPER", responseSlot: "response.body",
  header: [{ kind: "text", value: "Wrapper-only header: " }],
  body: [{ kind: "responseSlot", name: "response.body" }],
  footer: [{ kind: "text", value: " Terms apply." }], conditionals: [],
};

suite("ARCH-047 BG009 PostgreSQL moderation digest and crashed-lease replay", () => {
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

  it("rejects a raw-body moderation digest when the frozen customer-visible body differs", async () => {
    const f = await humanDispatchFixture("bg009-raw-digest-denied");
    let cleanup: (() => Promise<void>) | undefined;
    try {
      cleanup = await withPublishedWrapper(f);
      const raw = "Customer-safe merchant response";
      const commandId = await f.addCommand({ textBody: raw });
      const [claim] = await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() });
      const loaded = await f.commands.loadClaimedCommand(commandId, claim!.leaseToken);
      if (loaded.kind !== "claimed") throw new Error("Expected claimed HUMAN_TEXT");
      const frozen = await f.preparation.freeze(loaded.command, claim!.leaseToken);
      expect(frozen.kind).toBe("frozen");
      if (frozen.kind !== "frozen") throw new Error("Expected frozen wrapped text");
      expect(frozen.body).not.toBe(raw);
      expect(sha256Text(frozen.body)).not.toBe(sha256Text(raw));

      const insertPending = (id: string, digestValue: string) => f.db.$executeRaw`
        INSERT INTO "whatsapp"."ConversationModerationAssessment"
          ("id","shopId","conversationId","subject","merchantSendCommandId",
           "contentSha256","inputKind","requestedModel","policyVersion","updatedAt")
        VALUES (${id},${f.shopId},${f.conversationId},'HUMAN_COMMAND',${commandId},
          ${digestValue},'TEXT','omni-moderation-latest',${moderationConfig().policyVersion},
          statement_timestamp())`;
      // This must fail in PostgreSQL itself, independent of the TypeScript reader.
      await expect(insertPending(randomUUID(), sha256Text(raw)))
        .rejects.toThrow(/ARCH040 moderation HUMAN text digest mismatch/);
      expect(await f.db.conversationModerationAssessment.count({
        where: { merchantSendCommandId: commandId },
      })).toBe(0);
      expect(await insertPending(randomUUID(), sha256Text(frozen.body))).toBe(1);
      expect((await f.db.conversationModerationAssessment.findFirstOrThrow({
        where: { merchantSendCommandId: commandId },
      })).contentSha256).toBe(sha256Text(frozen.body));
      expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();
    } finally { if (cleanup) await cleanup(); await f.close(); }
  }, 120_000);

  it.each(["STOP", "HUMAN_CONTROL_LOSS"] as const)(
    "reclaims frozen bytes after a worker crash but %s prevents final dispatch",
    async (loss) => {
      const f = await humanDispatchFixture(`bg009-reclaim-${loss}`, { recipient: "447400123456" });
      let cleanup: (() => Promise<void>) | undefined;
      try {
        cleanup = await withPublishedWrapper(f);
        const commandId = await f.addCommand({ textBody: "Original merchant response" });
        const [initial] = await f.commands.claimDueHumanCommands({
          limit: 1, now: new Date(), ownerToken: "crashed-worker", leaseMs: 5_000,
        });
        const claimed = await f.commands.loadClaimedCommand(commandId, initial!.leaseToken);
        if (claimed.kind !== "claimed") throw new Error("Expected first lease");
        const frozen = await f.preparation.freeze(claimed.command, initial!.leaseToken);
        if (frozen.kind !== "frozen") throw new Error("Expected initial frozen wrapper");
        expect(frozen.body).not.toBe(claimed.command.textBody);
        const firstRow = await f.db.merchantConversationSendCommand.findUniqueOrThrow({
          where: { id: commandId },
        });
        const moderation = f.persistedAllowModeration();
        const subject = { kind: "HUMAN_COMMAND" as const, commandId };
        expect((await moderation.assessText({
          subject, shopId: f.shopId, conversationId: f.conversationId,
          effectiveText: frozen.body, inputKind: "TEXT",
          policyVersion: moderationConfig().policyVersion, now: new Date(),
        })).kind).toBe("allow");

        // Simulate a terminated worker: let its real PostgreSQL lease expire,
        // then start a distinct claimant. No fake clock or direct lease UPDATE.
        await new Promise((resolve) => setTimeout(resolve, 5_300));
        const [reclaimed] = await f.commands.claimDueHumanCommands({
          limit: 1, now: new Date(), ownerToken: "replacement-worker", leaseMs: 60_000,
        });
        expect(reclaimed?.id).toBe(commandId);
        expect(reclaimed!.leaseToken).not.toBe(initial!.leaseToken);
        expect((await f.commands.loadClaimedCommand(commandId, initial!.leaseToken)).kind)
          .toBe("refused");
        const second = await f.commands.loadClaimedCommand(commandId, reclaimed!.leaseToken);
        if (second.kind !== "claimed") throw new Error("Expected reclaimed lease");
        const renderAgain = vi.fn(async () => { throw new Error("Frozen bytes must not be rendered twice"); });
        const replayed = await new HumanPreparedCommandService(f.db, { prepare: renderAgain })
          .freeze(second.command, reclaimed!.leaseToken);
        expect(replayed).toEqual(frozen);
        expect(renderAgain).not.toHaveBeenCalled();
        const afterReclaim = await f.db.merchantConversationSendCommand.findUniqueOrThrow({
          where: { id: commandId },
        });
        expect(afterReclaim.preparedTextBody).toBe(firstRow.preparedTextBody);
        expect(afterReclaim.preparedWrapperEvidence).toEqual(firstRow.preparedWrapperEvidence);
        expect(afterReclaim.preparedAt).toEqual(firstRow.preparedAt);
        expect(afterReclaim.dispatchAttemptCount).toBe(2);

        if (loss === "STOP") {
          const customer = await f.db.customer.create({
            data: { shopId: f.shopId, phone: `+${f.recipient}` },
          });
          await f.db.customerPhone.create({ data: {
            customerId: customer.id, phone: `+${f.recipient}`,
            whatsappCanonicalPhone: f.recipient,
          } });
          expect((await writeLocalStop(f.db, {
            canonical: f.recipient, shopId: f.shopId,
            eventId: `bg009-reclaim-stop-${randomUUID()}`, at: new Date(),
          })).changed).toBe(1);
        } else {
          await f.changeOwner("HUMAN", "AI", 1);
        }
        // A previously valid moderation ALLOW does not override the new policy.
        expect(await moderation.requireCurrentAllowance({
          subject, effectiveText: frozen.body, policyVersion: moderationConfig().policyVersion,
        })).toBe(true);
        const permit = await new OutboundSendFenceService(f.db, f.durableEligibility)
          .admitFinalSend({ senderType: "HUMAN", conversationId: f.conversationId,
            shopId: f.shopId, recoveryId: f.recoveryId, expectedControlRevision: 1,
            commandId, leaseToken: reclaimed!.leaseToken, recipient: f.recipient, now: new Date() });
        expect(permit).toEqual({ kind: "suppressed", reason: loss === "STOP"
          ? "local-no-contact" : "stale-control-revision" });
        const restartedDispatcher = f.dispatcher();
        await restartedDispatcher.processClaim(commandId, reclaimed!.leaseToken);
        await restartedDispatcher.close();
        const final = await f.db.merchantConversationSendCommand.findUniqueOrThrow({
          where: { id: commandId },
        });
        expect(final.preparedTextBody).toBe(frozen.body);
        expect(final.preparedWrapperEvidence).toEqual(firstRow.preparedWrapperEvidence);
        expect(final.providerDispatchKey).toBeNull();
        expect(final.outboundMessageId).toBeNull();
        expect(final.state).toBe("CANCELLED");
        expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();
        expect(f.provider.sendWhatsAppTemplate).not.toHaveBeenCalled();
        expect(await f.db.conversationMessage.count({ where: {
          conversationId: f.conversationId, senderType: "HUMAN",
        } })).toBe(0);
      } finally { if (cleanup) await cleanup(); await f.close(); }
    }, 120_000,
  );
});
