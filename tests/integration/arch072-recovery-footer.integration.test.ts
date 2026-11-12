import { recoveryShopHeaderPrefix, verifiedRecoveryShopHeader } from "../../src/services/conversation-wrappers/recovery-shop-header.js";
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { humanDispatchFixture } from "./fixtures/recovery-human-dispatch.fixture.js";
import { OutboundSendFenceService } from "../../src/services/recovery-conversation/outbound-send-fence.service.js";
import { RECOVERY_CHECKOUT_SEPARATOR } from "../../src/services/conversation-wrappers/recovery-checkout-footer.js";
import { sha256Text } from "../../src/services/conversation-moderation/moderation-assessment.service.js";

const suite = process.env.TEST_DATABASE_URL && process.env.REDIS_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

suite("ARCH-072 persisted recovery footer identity", () => {
  it("freezes, replays, moderates and sends the identical complete HUMAN body", async () => {
    const f = await humanDispatchFixture("footer-human", { checkoutLifetimeDays: 7 });
    const dispatcher = f.dispatcher();
    try {
      const url = `https://${f.shopId}.example.test/checkouts/trusted`;
      await f.db.checkoutRecovery.update({ where: { id: f.recoveryId }, data: { checkoutUrl: url } });
      const original = "  Staff authored body\nretained verbatim  ";
      const commandId = await f.addCommand({ textBody: original });
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const loaded = await f.commands.loadClaimedCommand(commandId, claim.leaseToken);
      if (loaded.kind !== "claimed") throw new Error("Missing claim");
      const frozen = await f.preparation.freeze(loaded.command, claim.leaseToken);
      const expected = recoveryShopHeaderPrefix(verifiedRecoveryShopHeader(f.shopId, `${f.shopId}.example.test`, null)!) + original + RECOVERY_CHECKOUT_SEPARATOR + url;
      expect(frozen).toMatchObject({ kind: "frozen", body: expected });
      const replay = await f.commands.loadClaimedCommand(commandId, claim.leaseToken);
      if (replay.kind !== "claimed") throw new Error("Missing replay");
      expect(await f.preparation.freeze(replay.command, claim.leaseToken)).toMatchObject({ kind: "frozen", body: expected });
      await dispatcher.processClaim(commandId, claim.leaseToken);
      const command = await f.db.merchantConversationSendCommand.findUniqueOrThrow({ where: { id: commandId } });
      expect(command.textBody).toBe(original);
      expect(command.preparedTextBody).toBe(expected);
      expect(command.preparedWrapperEvidence).toMatchObject({ recoveryCheckoutUrl: url });
      const message = await f.db.conversationMessage.findUniqueOrThrow({ where: { id: command.outboundMessageId! } });
      const assessment = await f.db.conversationModerationAssessment.findFirstOrThrow({ where: { merchantSendCommandId: commandId } });
      expect(assessment.contentSha256).toBe(sha256Text(expected));
      expect(message.content).toBe(expected);
      expect(vi.mocked(f.provider.sendWhatsAppText).mock.calls[0]?.[0].text).toBe(expected);
      expect(f.provider.sendWhatsAppText).toHaveBeenCalledOnce();
    } finally { await dispatcher.close(); await f.close(); }
  }, 120_000);

  for (const mode of ["matching", "mismatching", "concurrent-change"] as const) {
    it(`enforces committed automated notice body: ${mode}`, async () => {
      const f = await humanDispatchFixture(`footer-${mode}`);
      try {
        await f.addCommand(); // Durable initial outreach and verified inbound evidence.
        await f.db.$transaction(async tx => {
          await tx.$queryRawUnsafe(`SELECT "id" FROM "commerce"."Shop" WHERE "id"=$1 FOR UPDATE`, f.shopId);
          await tx.$queryRawUnsafe(`SELECT "id" FROM "whatsapp"."Conversation" WHERE "id"=$1 FOR UPDATE`, f.conversationId);
          await tx.$executeRawUnsafe(`UPDATE "whatsapp"."Conversation" SET "controlMode"='AI', "controlRevision"=2,
            "controlChangedAt"=statement_timestamp() WHERE "id"=$1`, f.conversationId);
          await tx.$executeRawUnsafe(`INSERT INTO "whatsapp"."ConversationControlEvent"
            ("id","conversationId","fromMode","toMode","fromRevision","toRevision")
            VALUES ($1,$2,'HUMAN','AI',1,2)`, randomUUID(), f.conversationId);
        });
        const expected = "Prepared notice" + RECOVERY_CHECKOUT_SEPARATOR + `https://${f.shopId}.example.test/checkouts/trusted`;
        const message = await f.db.conversationMessage.create({ data: {
          id: randomUUID(), conversationId: f.conversationId, direction: "OUTBOUND", senderType: "AGENT",
          status: "PENDING", content: mode === "mismatching" ? "Different committed body" : expected,
        } });
        const fence = new OutboundSendFenceService(f.db, async () => null);
        const admit = () => fence.admitFinalSend({ senderType: "AGENT", shopId: f.shopId,
          recoveryId: f.recoveryId, conversationId: f.conversationId, messageId: message.id,
          recipient: "15551234567", expectedControlRevision: 2, now: new Date(), expectedContent: expected, deliveryKind: "TEXT" });
        let result;
        if (mode === "concurrent-change") {
          let release!: () => void;
          let locked!: () => void;
          const ready = new Promise<void>(resolve => { locked = resolve; });
          const gate = new Promise<void>(resolve => { release = resolve; });
          const mutation = f.db.$transaction(async tx => {
            await tx.$queryRawUnsafe(`SELECT "id" FROM "commerce"."Shop" WHERE "id"=$1 FOR UPDATE`, f.shopId);
            await tx.conversationMessage.update({ where: { id: message.id }, data: { content: "Racing replacement" } });
            locked();
            await gate;
          });
          await ready;
          const pending = admit();
          await new Promise(resolve => setTimeout(resolve, 50));
          release();
          await mutation;
          result = await pending;
        } else result = await admit();
        expect(result.kind).toBe(mode === "matching" ? "admitted" : "suppressed");
        const persisted = await f.db.conversationMessage.findUniqueOrThrow({ where: { id: message.id } });
        if (mode === "matching") expect(persisted.providerDispatchKey).not.toBeNull();
        else expect(persisted.providerDispatchKey).toBeNull();
        expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();
      } finally { await f.close(); }
    }, 120_000);
  }
});
