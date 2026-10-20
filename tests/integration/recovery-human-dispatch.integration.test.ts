import "dotenv/config";
import { describe, expect, it, vi } from "vitest";
import { allowModerationFixture } from "./fixtures/arch040-allow-moderation.fixture.js";
import { OutboundMessageDeliveryService } from "../../src/services/outbound-whatsapp-admission/outbound-message-delivery.service.js";
import { AiTurnOwnershipService } from "../../src/services/recovery-conversation/ai-turn-ownership.service.js";
import { OutboundSendFenceService } from "../../src/services/recovery-conversation/outbound-send-fence.service.js";
import { WhatsAppServiceError } from "../../src/services/whatsapp.service.js";
import { PlatformConfigurationFailure } from "../../src/services/platform-configuration/errors.js";
import { WhatsAppProviderStatusService } from "../../src/services/whatsapp-provider-status.service.js";
import { runAiTurnThroughBackgroundMocks } from "./fixtures/arch040-ai-turn.fixture.js";
import { humanDispatchFixture } from "./fixtures/recovery-human-dispatch.fixture.js";

const suite = process.env.TEST_DATABASE_URL && process.env.REDIS_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

suite("ARCH-040 BACKGROUND-002 real dispatcher, PostgreSQL/Redis and mock Meta", () => {
  it("missing sender config defers before permit and records a safe operational incident", async () => {
    const f = await humanDispatchFixture("sender-preflight-incident");
    try {
      const commandId = await f.addCommand();
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const incidents = { record: vi.fn(async () => {}) };
      const preflight = vi.fn(async () => { throw new PlatformConfigurationFailure("MISSING", "messaging.sender"); });
      const service = f.dispatcher(undefined, allowModerationFixture(), incidents, preflight);
      await service.processClaim(commandId, claim.leaseToken);
      expect(preflight).toHaveBeenCalledOnce();
      expect(await f.commandState(commandId)).toEqual(expect.objectContaining({
        state: "FAILED", providerDispatchKey: null, outboundMessageId: null,
      }));
      expect(incidents.record).toHaveBeenCalledWith(expect.objectContaining({
        commandId, shopId: f.shopId, error: expect.any(PlatformConfigurationFailure), outcome: "pre_dispatch",
      }));
      expect(f.billing.admitAndRevalidate).not.toHaveBeenCalled();
      expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();
      await service.close();
    } finally { await f.close(); }
  }, 60_000);

  it("incident reporter observes original sender-config exception after a durable UNKNOWN", async () => {
    const f = await humanDispatchFixture("sender-missing-incident");
    try {
      const commandId = await f.addCommand();
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const incidents = { record: vi.fn(async () => {}) };
      const original = f.provider.sendWhatsAppText;
      f.provider.sendWhatsAppText = vi.fn(async () => { throw new PlatformConfigurationFailure("MISSING", "messaging.sender"); });
      try {
        const service = f.dispatcher(undefined, allowModerationFixture(), incidents);
        await service.processClaim(commandId, claim.leaseToken);
        expect((await f.commandState(commandId))?.state).toBe("UNKNOWN");
        expect(incidents.record).toHaveBeenCalledWith(expect.objectContaining({
          commandId, shopId: f.shopId, error: expect.any(PlatformConfigurationFailure), outcome: "unknown",
        }));
        await service.close();
      } finally { f.provider.sendWhatsAppText = original; }
    } finally { await f.close(); }
  }, 60_000);

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

  it("blocks Meta after a shop suspension commits between screening and final admission", async () => {
    const f = await humanDispatchFixture("suspension-admission");
    try {
      const id = await f.addCommand();
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      expect(claim.id).toBe(id);
      // The command has passed the Redis gate and was already leased; suspension
      // commits while the worker runs its subsequent execution eligibility check.
      f.execution.evaluate.mockImplementationOnce(async () => {
        await f.suspendShop();
        return { allowed: true } as const;
      });
      const service = f.dispatcher();
      await service.processClaim(id, claim.leaseToken);
      expect(await f.commandState(id)).toEqual(expect.objectContaining({
        state: "CANCELLED", providerDispatchKey: null, outboundMessageId: null,
      }));
      expect(f.durableEligibility).not.toHaveBeenCalled();
      expect(f.billing.admitAndRevalidate).not.toHaveBeenCalled();
      expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();
      expect(f.provider.sendWhatsAppTemplate).not.toHaveBeenCalled();
      expect(await f.db.conversationMessage.count({
        where: { conversationId: f.conversationId, senderType: "HUMAN" },
      })).toBe(0);
      await service.close();
    } finally { await f.close(); }
  }, 60_000);

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

  it("releases reserved recovery credit when suspension wins after billing but before permit", async () => {
    const f = await humanDispatchFixture("suspension-after-credit");
    try {
      const { commandId } = await f.addMerchantFollowUpCommand();
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      f.billing.admitAndRevalidate.mockImplementationOnce(async (input) => {
        await f.suspendShop();
        return { kind: "admitted", admission: { sourceKey: `recovery-outreach:${input.sequenceTwoAttemptId}` } } as const;
      });
      const service = f.dispatcher();
      await service.processClaim(commandId, claim.leaseToken);
      await service.close();
      expect(f.billing.admitAndRevalidate).toHaveBeenCalledTimes(1);
      expect(f.billing.releaseBeforePermit).toHaveBeenCalledTimes(1);
      expect(f.billing.releaseBeforePermit).toHaveBeenCalledWith(
        expect.objectContaining({ sourceKey: expect.stringContaining("recovery-outreach:") }),
      );
      expect(f.billing.onConfirmedProviderSend).not.toHaveBeenCalled();
      expect(f.billing.onDefinitiveProviderFailure).not.toHaveBeenCalled();
      expect(f.durableEligibility).not.toHaveBeenCalled();
      expect(f.provider.sendWhatsAppTemplate).not.toHaveBeenCalled();
      expect((await f.commandState(commandId))?.state).toBe("CANCELLED");
    } finally { await f.close(); }
  }, 60_000);

  it("two real dispatcher replicas lease a single command and submit exactly one Meta request", async () => {
    const f = await humanDispatchFixture("two-replicas");
    try {
      const id = await f.addCommand();
      const replicaA = f.dispatcher();
      const replicaB = f.dispatcher();
      // Hold the HTTP request at the real WhatsApp transport boundary, not
      // in a fake sendWhatsAppText implementation. Replica B must not emit a
      // second request to the Background-owned emulator while A is in flight.
      const pendingHttp = f.holdNextProviderHttp();
      try {
        await replicaA.poll();
        await pendingHttp.entered;
        await replicaB.poll();
      } finally {
        pendingHttp.release();
        await Promise.all([replicaA.close(), replicaB.close()]);
      }
      await f.whatsapp.waitForMessageCount(1);
      expect(f.whatsapp.messages).toHaveLength(1);
      expect(f.whatsapp.messages[0]?.body.type).toBe("text");
      expect(f.providerHttpRequests).toEqual([{ type: "text" }]);
      expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(1);
      expect(f.provider.sendWhatsAppTemplate).not.toHaveBeenCalled();
      expect(f.durableEligibility).toHaveBeenCalledTimes(1);
      expect(await f.commandState(id)).toEqual(expect.objectContaining({
        state: "SENT", dispatchAttemptCount: 1,
        outboundMessageId: expect.any(String), providerDispatchKey: expect.any(String),
      }));
      expect(await f.db.conversationMessage.count({
        where: { conversationId: f.conversationId, senderType: "HUMAN" },
      })).toBe(1);
      // Merchant replies must not consume the automated-message usage ledger.
      expect(await f.db.usageEvent.count({ where: {
        shopId: f.shopId, metric: "OUTBOUND_AUTOMATED_MESSAGE",
      } })).toBe(0);
      expect(await f.commands.claimDueHumanCommands({
        limit: 5, now: new Date(Date.now() + 120_000),
      })).toEqual([]);
    } finally { await f.close(); }
  }, 60_000);

  it("Redis rate denial stops final durable admission and prevents a second Meta submission", async () => {
    const f = await humanDispatchFixture("screening-rate");
    try {
      const firstId = await f.addCommand();
      const secondId = await f.addCommand();
      const leases = await f.commands.claimDueHumanCommands({ limit: 2, now: new Date() });
      const first = leases.find((lease) => lease.id === firstId)!;
      const second = leases.find((lease) => lease.id === secondId)!;
      const service = f.dispatcher({
        maxTextCharacters: 4000, shopPerMinute: 1,
        recipientPerHour: 100, repeatedIdenticalPerTenMinutes: 100,
      });
      await service.processClaim(first.id, first.leaseToken);
      await service.processClaim(second.id, second.leaseToken);
      expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(1);
      await f.whatsapp.waitForMessageCount(1);
      expect(f.whatsapp.messages).toHaveLength(1);
      expect(f.providerHttpRequests).toHaveLength(1);
      expect(f.durableEligibility).toHaveBeenCalledTimes(1);
      expect(f.billing.admitAndRevalidate).not.toHaveBeenCalled();
      expect(await f.commandState(secondId)).toEqual(expect.objectContaining({
        state: "CANCELLED", providerDispatchKey: null, outboundMessageId: null,
      }));
      await service.close();
    } finally { await f.close(); }
  }, 60_000);

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
      // Simulate an abrupt process crash after durable admission but before HTTP.
      const fencing = new OutboundSendFenceService(f.db, async () => null);
      expect((await fencing.admitFinalSend({
        senderType: "HUMAN", shopId: f.shopId, conversationId: f.conversationId,
        recoveryId: f.recoveryId, expectedControlRevision: 1,
        commandId: id, leaseToken: claim.leaseToken, recipient: f.recipient, now: new Date(),
      })).kind).toBe("admitted");
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

  it("denies queued HUMAN text after the verified customer window expires without template substitution", async () => {
    const f = await humanDispatchFixture("expired-human-window");
    try {
      const commandId = await f.addCommand();
      await f.db.conversation.update({ where: { id: f.conversationId },
        data: { lastInboundAt: new Date(Date.now() - 25 * 60 * 60_000) } });
      const [claim] = await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() });
      const service = f.dispatcher();
      await service.processClaim(commandId, claim!.leaseToken);
      await service.close();

      expect(await f.commandState(commandId)).toEqual(expect.objectContaining({
        state: "CANCELLED", providerDispatchKey: null, outboundMessageId: null,
      }));
      expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();
      expect(f.provider.sendWhatsAppTemplate).not.toHaveBeenCalled();
      expect(f.providerHttpRequests).toHaveLength(0);
      expect(await f.db.conversationMessage.count({
        where: { conversationId: f.conversationId, senderType: "HUMAN" },
      })).toBe(0);
    } finally { await f.close(); }
  }, 60_000);

  it("dispatches producer-neutral commands identically with one HUMAN message per command", async () => {
    const f = await humanDispatchFixture("producer-neutral-parity");
    try {
      const commandIds = [await f.addCommand(), await f.addCommand()];
      const service = f.dispatcher();
      await service.poll();
      await service.close();

      await f.whatsapp.waitForMessageCount(2);
      expect(f.providerHttpRequests).toEqual([{ type: "text" }, { type: "text" }]);
      expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(2);
      expect(f.provider.sendWhatsAppTemplate).not.toHaveBeenCalled();
      expect(await f.db.conversationMessage.count({
        where: { conversationId: f.conversationId, senderType: "HUMAN" },
      })).toBe(2);
      for (const commandId of commandIds) {
        expect(await f.commandState(commandId)).toEqual(expect.objectContaining({
          state: "SENT", dispatchAttemptCount: 1,
          outboundMessageId: expect.any(String), providerDispatchKey: expect.any(String),
        }));
      }
    } finally { await f.close(); }
  }, 60_000);

  it("lets only the eligible HUMAN path claim the shared sequence-two attempt", async () => {
    const f = await humanDispatchFixture("sequence-two-claim-race");
    try {
      await f.addInitialOutreach();
      const [scheduled, merchant] = await Promise.all([
        f.followUps.claimSequenceTwo({
          recoveryId: f.recoveryId, initiator: "scheduled_no_response",
          initiationKey: `scheduled-${f.recoveryId}`, recipient: f.recipient, now: new Date(),
        }),
        f.followUps.claimSequenceTwo({
          recoveryId: f.recoveryId, initiator: "merchant_post_window",
          initiationKey: `merchant-${f.recoveryId}`, recipient: f.recipient,
          expectedRevision: 1, now: new Date(),
        }),
      ]);

      expect(merchant.kind).toBe("claimed");
      expect(scheduled).toEqual({ kind: "suppressed", reason: "human-controlled" });
      await expect(f.followUps.claimSequenceTwo({
        recoveryId: f.recoveryId, initiator: "merchant_post_window",
        initiationKey: `merchant-retry-${f.recoveryId}`, recipient: f.recipient,
        expectedRevision: 1, now: new Date(),
      })).resolves.toEqual({ kind: "suppressed", reason: "already-claimed" });
      expect(await f.db.recoveryOutreachAttempt.count({
        where: { checkoutRecoveryId: f.recoveryId, sequence: 2 },
      })).toBe(1);
      expect(await f.db.recoveryOutreachAttempt.findUnique({
        where: { checkoutRecoveryId_sequence: { checkoutRecoveryId: f.recoveryId, sequence: 2 } },
        select: { initiatedBy: true, initiationKey: true, status: true, outboundMessageId: true },
      })).toEqual(expect.objectContaining({
        initiatedBy: "HUMAN", initiationKey: `merchant-${f.recoveryId}`,
        status: "PENDING", outboundMessageId: null,
      }));

      const commandId = await f.addCommand({
        kind: "RECOVERY_FOLLOW_UP_TEMPLATE",
        idempotencyKey: `merchant-${f.recoveryId}`,
        attemptId: merchant.attemptId,
      });
      const dispatcher = f.dispatcher();
      await dispatcher.poll();
      await dispatcher.close();

      await f.whatsapp.waitForMessageCount(1);
      expect(f.providerHttpRequests).toEqual([{ type: "template" }]);
      expect(await f.commandState(commandId)).toEqual(expect.objectContaining({
        state: "SENT", dispatchAttemptCount: 1,
        outboundMessageId: expect.any(String), providerDispatchKey: expect.any(String),
      }));
      expect(await f.db.recoveryOutreachAttempt.count({
        where: { checkoutRecoveryId: f.recoveryId, sequence: 2 },
      })).toBe(1);
      expect(f.billing.admitAndRevalidate).toHaveBeenCalledTimes(1);
      expect(f.billing.onConfirmedProviderSend).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  }, 60_000);

  it("reconciles HUMAN command receipts and keeps duplicate/out-of-order status monotonic", async () => {
    const f = await humanDispatchFixture("human-provider-receipts");
    try {
      const commandIds = [await f.addCommand(), await f.addCommand()];
      const claims = await f.commands.claimDueHumanCommands({ limit: 2, now: new Date() });
      const dispatcher = f.dispatcher();
      for (const claim of claims) await dispatcher.processClaim(claim.id, claim.leaseToken);
      await dispatcher.close();

      const commands = await Promise.all(commandIds.map((id) =>
        f.db.merchantConversationSendCommand.findUniqueOrThrow({
          where: { id }, select: { state: true, outboundMessageId: true },
        })));
      const followUp = await f.addMerchantFollowUpCommand();
      const followUpDispatcher = f.dispatcher();
      await followUpDispatcher.poll();
      await followUpDispatcher.close();
      const followUpCommand = await f.db.merchantConversationSendCommand.findUniqueOrThrow({
        where: { id: followUp.commandId }, select: { state: true, outboundMessageId: true },
      });
      const messages = await Promise.all(commands.map((command) =>
        f.db.conversationMessage.findUniqueOrThrow({
          where: { id: command.outboundMessageId! }, select: { id: true, providerMessageId: true },
        })));
      const followUpMessage = await f.db.conversationMessage.findUniqueOrThrow({
        where: { id: followUpCommand.outboundMessageId! },
        select: { id: true, providerMessageId: true },
      });
      const statuses = new WhatsAppProviderStatusService(f.db as never, {
        debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => ({}),
      } as never);
      const event = {
        schemaVersion: 2 as const,
        providerAccountId: "receipt-account",
        providerPhoneNumberId: "receipt-phone",
        providerMessageId: messages[0]!.providerMessageId!,
        status: "READ" as const,
        occurredAt: new Date().toISOString(),
      };

      await expect(statuses.process(event)).resolves.toBe("applied");
      await expect(statuses.process(event)).resolves.toBe("ignored");
      await statuses.process({ ...event, status: "DELIVERED" });
      await statuses.process({ ...event, status: "FAILED" });

      const failedEvent = {
        ...event,
        providerMessageId: messages[1]!.providerMessageId!,
        schemaVersion: 3 as const,
        status: "FAILED" as const,
        failure: { providerCode: "131026" },
      };
      await expect(statuses.process(failedEvent)).resolves.toBe("applied");
      await expect(statuses.process(failedEvent)).resolves.toBe("ignored");

      const failedFollowUpEvent = {
        ...failedEvent,
        providerMessageId: followUpMessage.providerMessageId!,
        schemaVersion: 3 as const,
      };
      await expect(statuses.process(failedFollowUpEvent)).resolves.toBe("applied");
      expect(await f.db.recoveryOutreachAttempt.findUnique({
        where: { id: followUp.attemptId }, select: { status: true, failureCode: true },
      })).toEqual({ status: "FAILED", failureCode: "WHATSAPP_RECIPIENT_UNDELIVERABLE" });

      expect(await f.db.conversationMessage.findUnique({
        where: { id: messages[0]!.id }, select: { status: true, readAt: true },
      })).toEqual(expect.objectContaining({ status: "READ", readAt: expect.any(Date) }));
      expect(await f.db.merchantConversationSendCommand.findUnique({
        where: { id: commandIds[0] }, select: { state: true },
      })).toEqual({ state: "SENT" });
      expect(await f.db.conversationMessage.findUnique({
        where: { id: messages[1]!.id }, select: { status: true, providerFailureCode: true },
      })).toEqual({ status: "FAILED", providerFailureCode: "131026" });
      expect(await f.db.merchantConversationSendCommand.findUnique({
        where: { id: commandIds[1] }, select: { state: true, failureCode: true },
      })).toEqual({ state: "SENT", failureCode: null });
      expect(await f.db.usageEvent.count({
        where: { shopId: f.shopId, metric: "DELIVERED_WHATSAPP_MESSAGE" },
      })).toBe(1);
      expect(f.providerHttpRequests).toEqual([{ type: "text" }, { type: "text" }, { type: "template" }]);
    } finally { await f.close(); }
  }, 60_000);
});
