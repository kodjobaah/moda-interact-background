import "dotenv/config";
import { describe, expect, it } from "vitest";
import { allowModerationFixture } from "./fixtures/arch040-allow-moderation.fixture.js";
import { OutboundMessageDeliveryService } from "../../src/services/outbound-whatsapp-admission/outbound-message-delivery.service.js";
import { AiTurnOwnershipService } from "../../src/services/recovery-conversation/ai-turn-ownership.service.js";
import { OutboundSendFenceService } from "../../src/services/recovery-conversation/outbound-send-fence.service.js";
import { runAiTurnThroughBackgroundMocks } from "./fixtures/arch040-ai-turn.fixture.js";
import { humanDispatchFixture } from "./fixtures/recovery-human-dispatch.fixture.js";

const suite = process.env.TEST_DATABASE_URL && process.env.REDIS_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

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
});
