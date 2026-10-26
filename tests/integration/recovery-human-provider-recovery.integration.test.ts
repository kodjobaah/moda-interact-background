import "dotenv/config";
import { describe, expect, it } from "vitest";
import { OutboundSendFenceService } from "../../src/services/recovery-conversation/outbound-send-fence.service.js";
import { WhatsAppServiceError } from "../../src/services/whatsapp.service.js";
import { moderationConfig } from "../../src/services/conversation-moderation/moderation-policy.js";
import { humanDispatchFixture } from "./fixtures/recovery-human-dispatch.fixture.js";

const suite = process.env.TEST_DATABASE_URL && process.env.REDIS_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

suite("ARCH-040 HUMAN provider failure and crash reconciliation", () => {
  it("an uncertain Meta response remains UNKNOWN across worker restart and is never resubmitted", async () => {
    const f = await humanDispatchFixture("provider-unknown");
    try {
      const id = await f.addCommand();
      f.failNextProviderHttp("timeout");
      const initial = f.dispatcher();
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      await initial.processClaim(id, claim.leaseToken);
      await initial.close();
      expect(await f.commandState(id)).toEqual(expect.objectContaining({
        state: "UNKNOWN", providerDispatchKey: expect.any(String), outboundMessageId: expect.any(String),
      }));
      const restarted = f.dispatcher();
      await restarted.poll();
      await restarted.close();
      expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(1);
      expect(f.providerHttpRequests).toHaveLength(1);
      await f.whatsapp.assertNoAdditionalMessages({ count: 0, quietMs: 50 });
      expect(await f.commandState(id)).toEqual(expect.objectContaining({ state: "UNKNOWN" }));
      expect(await f.commands.claimDueHumanCommands({ limit: 5, now: new Date(Date.now() + 600_000) }))
        .toEqual([]);
      // Verified external status can settle UNKNOWN without another Meta request.
      expect((await f.reconciliation.reconcileUnknown({
        commandId: id, outcome: { kind: "accepted", providerMessageId: "wa-reconciled" }, verified: true,
      })).kind).toBe("sent");
      expect((await f.commandState(id))?.state).toBe("SENT");
      expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  }, 60_000);

  it("recovers an expired admitted provider permit as UNKNOWN without reissuing Meta HTTP", async () => {
    const f = await humanDispatchFixture("permit-crash-recovery");
    try {
      const id = await f.addCommand();
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      // Simulate the real pre-permit sequence: lease-fenced preparation and an
      // ALLOW on the exact frozen body, without making a Meta HTTP request.
      const loaded = await f.commands.loadClaimedCommand(id, claim.leaseToken, new Date());
      expect(loaded.kind).toBe("claimed");
      if (loaded.kind !== "claimed") throw new Error("Expected claimed command");
      const frozen = await f.preparation.freeze(loaded.command, claim.leaseToken);
      expect(frozen.kind).toBe("frozen");
      if (frozen.kind !== "frozen") throw new Error("Expected frozen HUMAN_TEXT body");
      const moderation = f.persistedAllowModeration();
      const subject = { kind: "HUMAN_COMMAND" as const, commandId: id };
      const policyVersion = moderationConfig().policyVersion;
      expect(await moderation.effectiveText(subject)).toBe(frozen.body);
      expect((await moderation.assessText({
        subject, shopId: f.shopId, conversationId: f.conversationId,
        effectiveText: frozen.body, inputKind: "TEXT", policyVersion, now: new Date(),
      })).kind).toBe("allow");
      expect(await moderation.requireCurrentAllowance({
        subject, effectiveText: frozen.body, policyVersion,
      })).toBe(true);

      // Simulate an abrupt process crash after durable admission but before HTTP.
      const fencing = new OutboundSendFenceService(f.db, async () => null);
      const permit = await fencing.admitFinalSend({
        senderType: "HUMAN", shopId: f.shopId, conversationId: f.conversationId,
        recoveryId: f.recoveryId, expectedControlRevision: 1,
        commandId: id, leaseToken: claim.leaseToken, recipient: f.recipient, now: new Date(),
      });
      expect(permit.kind).toBe("admitted");
      if (permit.kind !== "admitted") throw new Error("Expected durable provider permit");
      expect(permit.messageContent).toBe(frozen.body);
      await f.db.$executeRawUnsafe(`UPDATE "whatsapp"."MerchantConversationSendCommand"
        SET "leaseExpiresAt"=statement_timestamp()-interval '1 second' WHERE "id"=$1`, id);
      const restarted = f.dispatcher();
      await restarted.reconcileExpiredPermits();
      await restarted.poll();
      await restarted.close();
      expect((await f.commandState(id))?.state).toBe("UNKNOWN");
      expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();
      expect(f.provider.sendWhatsAppTemplate).not.toHaveBeenCalled();
    } finally { await f.close(); }
  }, 60_000);

  it("a definitively rejected HUMAN follow-up compensates its original credit admission once", async () => {
    const f = await humanDispatchFixture("definitive-followup");
    try {
      const { commandId: id, attemptId } = await f.addMerchantFollowUpCommand();
      f.failNextProviderHttp("provider-rejected");
      const lease = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const service = f.dispatcher();
      await service.processClaim(id, lease.leaseToken);
      await service.close();
      expect(f.billing.admitAndRevalidate).toHaveBeenCalledTimes(1);
      expect(f.billing.onDefinitiveProviderFailure).toHaveBeenCalledTimes(1);
      expect(f.billing.onDefinitiveProviderFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          admission: expect.objectContaining({ sourceKey: `recovery-outreach:${attemptId}` }),
          error: expect.any(WhatsAppServiceError),
        }),
      );
      expect(f.billing.onConfirmedProviderSend).not.toHaveBeenCalled();
      expect(f.billing.releaseBeforePermit).not.toHaveBeenCalled();
      expect(f.provider.sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
      expect(f.providerHttpRequests).toEqual([{ type: "template" }]);
      await f.whatsapp.assertNoAdditionalMessages({ count: 0, quietMs: 50 });
      expect((await f.commandState(id))?.state).toBe("FAILED");
      expect(await f.db.conversationMessage.findFirst({
        where: { conversationId: f.conversationId, senderType: "HUMAN" },
        select: { status: true },
      })).toEqual({ status: "FAILED" });
      expect(await f.commands.claimDueHumanCommands({ limit: 5, now: new Date(Date.now() + 600_000) }))
        .toEqual([]);
    } finally { await f.close(); }
  }, 60_000);

  it("repairs a confirmed provider send after a credit-finalisation crash without another Meta request", async () => {
    const f = await humanDispatchFixture("credit-crash-repair");
    try {
      const { commandId: id, attemptId } = await f.addMerchantFollowUpCommand();
      f.billing.onConfirmedProviderSend.mockRejectedValueOnce(new Error("credit-finalisation-temporarily-unavailable"));
      const lease = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const initial = f.dispatcher();
      await initial.processClaim(id, lease.leaseToken);
      await initial.close();
      expect((await f.commandState(id))?.state).toBe("SENT");
      expect(f.billing.onConfirmedProviderSend).toHaveBeenCalledTimes(1);
      const before = await f.db.recoveryOutreachAttempt.findUnique({ where: { id: attemptId } });
      expect(before?.status).toBe("PENDING");
      const restarted = f.dispatcher();
      await restarted.reconcileConfirmedFollowUps();
      await restarted.reconcileConfirmedFollowUps();
      await restarted.close();
      expect(f.provider.sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
      await f.whatsapp.waitForMessageCount(1);
      expect(f.whatsapp.messages[0]?.body.type).toBe("template");
      expect(f.providerHttpRequests).toEqual([{ type: "template" }]);
      expect(f.billing.onConfirmedProviderSend).toHaveBeenCalledTimes(2);
      expect(f.billing.admitAndRevalidate).toHaveBeenCalledTimes(2);
      expect(f.billing.onConfirmedProviderSend).toHaveBeenCalledWith(expect.objectContaining({
        admission: expect.objectContaining({ sourceKey: `recovery-outreach:${attemptId}` }),
        recoveryId: f.recoveryId,
      }));
      const after = await f.db.recoveryOutreachAttempt.findUnique({ where: { id: attemptId } });
      expect(after?.status).toBe("WAITING_FOR_RESPONSE");
      expect(after?.outboundMessageId).toBe((await f.commandState(id))?.outboundMessageId);
    } finally { await f.close(); }
  }, 60_000);
});
