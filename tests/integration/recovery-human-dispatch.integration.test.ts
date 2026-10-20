import "dotenv/config";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { describe, expect, it, vi } from "vitest";
import { allowModerationFixture } from "./fixtures/arch040-allow-moderation.fixture.js";
import { OutboundMessageDeliveryService } from "../../src/services/outbound-whatsapp-admission/outbound-message-delivery.service.js";
import { AiTurnOwnershipService } from "../../src/services/recovery-conversation/ai-turn-ownership.service.js";
import { OutboundSendFenceService } from "../../src/services/recovery-conversation/outbound-send-fence.service.js";
import { FollowUpClaimCancellationService } from "../../src/services/recovery-conversation/follow-up-claim-cancellation.service.js";
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

  it.each(["block", "review_required"] as const)(
    "releases the same sequence-two attempt after HUMAN moderation %s, without billing or Meta",
    async (outcome) => {
      const f = await humanDispatchFixture(`moderation-reclaim-${outcome}`);
      try {
        const { commandId, attemptId } = await f.addMerchantFollowUpCommand();
        const moderation = allowModerationFixture();
        moderation.assessText = async () => ({
          kind: outcome, assessmentId: `denied-${outcome}`, reasonCode: "fixture_denial",
        });
        const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
        await f.dispatcher(undefined, moderation).processClaim(commandId, claim.leaseToken);

        expect(await f.commandState(commandId)).toEqual(expect.objectContaining({
          state: "CANCELLED", outboundMessageId: null, providerDispatchKey: null,
        }));
        expect(await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId },
          select: { initiatedBy: true, initiationKey: true, claimedAt: true, outboundMessageId: true },
        })).toEqual({ initiatedBy: null, initiationKey: null, claimedAt: null, outboundMessageId: null });
        expect(f.billing.admitAndRevalidate).not.toHaveBeenCalled();
        expect(f.billing.releaseBeforePermit).not.toHaveBeenCalled();
        expect(f.providerHttpRequests).toHaveLength(0);
        expect(await f.db.usageReservation.count({ where: { shopId: f.shopId } })).toBe(0);
        expect(await f.db.usageEvent.count({ where: { shopId: f.shopId } })).toBe(0);

        const correctedKey = `corrected-${f.recoveryId}`;
        expect(await f.followUps.claimSequenceTwo({
          recoveryId: f.recoveryId, initiator: "merchant_post_window", expectedRevision: 1,
          initiationKey: correctedKey, recipient: f.recipient, now: new Date(),
        })).toEqual({ kind: "claimed", attemptId, billingSource: `recovery-outreach:${attemptId}` });
        expect(await f.db.recoveryOutreachAttempt.count({
          where: { checkoutRecoveryId: f.recoveryId, sequence: 2 },
        })).toBe(1);
        expect((await f.db.merchantConversationSendCommand.findUniqueOrThrow({ where: { id: commandId } }))
          .idempotencyKey).toBe(`merchant-${f.recoveryId}`);
      } finally { await f.close(); }
    }, 60_000,
  );

  it("recovers cancelled-but-claimed follow-ups after a crash without resending", async () => {
    const f = await humanDispatchFixture("historical-cancel-reclaim");
    try {
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand();
      const lease = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      expect(await f.commands.rejectCommand(commandId, lease.leaseToken, "human_content_moderation_blocked"))
        .toBe(true); // Simulates a previous worker's cancellation before claim release.
      const a = new FollowUpClaimCancellationService(f.db, f.commands);
      const b = new FollowUpClaimCancellationService(f.db, f.commands);
      const results = await Promise.all([a.repairCancelledClaims(), b.repairCancelledClaims()]);
      expect(results.reduce((sum, value) => sum + value, 0)).toBe(1);
      expect(await a.repairCancelledClaims()).toBe(0);
      expect(await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId },
        select: { initiationKey: true, initiatedBy: true },
      })).toEqual({ initiationKey: null, initiatedBy: null });
      expect(f.billing.admitAndRevalidate).not.toHaveBeenCalled();
      expect(f.providerHttpRequests).toHaveLength(0);
    } finally { await f.close(); }
  }, 60_000);

  it("releases a provisional credit after moderation rejection before resetting the same follow-up", async () => {
    const f = await humanDispatchFixture("reserved-credit-fail-closed");
    try {
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand();
      const sourceKey = createRecoveryIdempotencyKey(f.shopId, `recovery-outreach:${attemptId}`);
      // Reserved credit must name its capacity source. Match the live billing
      // constraint rather than inserting an impossible reservation row.
      const counter = await f.db.shopEntitlementCounter.create({ data: {
        shopId: f.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS",
        grantedQuantity: 1, reservedQuantity: 1,
      } });
      await f.db.usageReservation.create({ data: {
        shopId: f.shopId, counterId: counter.id, sourceKey, quantity: 1, status: "RESERVED",
      } });
      const moderation = allowModerationFixture();
      moderation.assessText = async () => ({
        kind: "block", assessmentId: "denied-existing-reservation", reasonCode: "fixture_denial",
      });
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      await f.dispatcher(undefined, moderation).processClaim(commandId, claim.leaseToken);
      expect((await f.commandState(commandId))?.state).toBe("CANCELLED");
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
        .initiationKey).toBeNull();
      expect((await f.db.usageReservation.findUniqueOrThrow({ where: { sourceKey } }))
        .status).toBe("RELEASED");
      expect(await f.db.shopEntitlementCounter.findUniqueOrThrow({ where: { id: counter.id } }))
        .toMatchObject({ grantedQuantity: 1, reservedQuantity: 0, committedQuantity: 0 });
      expect(f.releaseExistingCredit).toHaveBeenCalledTimes(1);
      expect(await f.db.usageEvent.count({ where: { shopId: f.shopId } })).toBe(0);
      expect(await f.followUps.claimSequenceTwo({
        recoveryId: f.recoveryId, initiator: "merchant_post_window", expectedRevision: 1,
        initiationKey: "second-command", recipient: f.recipient, now: new Date(),
      })).toEqual({ kind: "claimed", attemptId, billingSource: `recovery-outreach:${attemptId}` });
      expect(f.billing.admitAndRevalidate).not.toHaveBeenCalled();
      expect(f.providerHttpRequests).toHaveLength(0);
    } finally { await f.close(); }
  }, 60_000);

  it("keeps the claim and cancelled command when releasing a provisional credit fails", async () => {
    const f = await humanDispatchFixture("reserved-credit-release-failed");
    try {
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand();
      const sourceKey = createRecoveryIdempotencyKey(f.shopId, `recovery-outreach:${attemptId}`);
      const counter = await f.db.shopEntitlementCounter.create({ data: {
        shopId: f.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS",
        grantedQuantity: 1, reservedQuantity: 1,
      } });
      await f.db.usageReservation.create({ data: {
        shopId: f.shopId, counterId: counter.id, sourceKey, quantity: 1, status: "RESERVED",
      } });
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const failure = f.cancellationService(async () => { throw new Error("simulated release outage"); });
      expect(await failure.cancelClaimed(commandId, claim.leaseToken, "human_content_moderation_blocked"))
        .toBe("held");
      expect((await f.commandState(commandId))?.state).toBe("CANCELLED");
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
        .initiationKey).toBe(`merchant-${f.recoveryId}`);
      expect((await f.db.usageReservation.findUniqueOrThrow({ where: { sourceKey } })).status)
        .toBe("RESERVED");
      expect(f.providerHttpRequests).toHaveLength(0);
      // The next bounded repair poll uses the original command and credit.
      await f.db.merchantConversationSendCommand.update({ where: { id: commandId },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });
      expect(await f.cancellationService().repairCancelledClaims()).toBe(1);
      expect((await f.db.usageReservation.findUniqueOrThrow({ where: { sourceKey } })).status)
        .toBe("RELEASED");
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
        .initiationKey).toBeNull();
    } finally { await f.close(); }
  }, 60_000);

  it("repairs a crash after durable release but before attempt reset", async () => {
    const f = await humanDispatchFixture("released-before-claim-reset");
    try {
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand();
      const sourceKey = createRecoveryIdempotencyKey(f.shopId, `recovery-outreach:${attemptId}`);
      const counter = await f.db.shopEntitlementCounter.create({ data: {
        shopId: f.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS",
        grantedQuantity: 1, reservedQuantity: 1,
      } });
      await f.db.usageReservation.create({ data: {
        shopId: f.shopId, counterId: counter.id, sourceKey, quantity: 1, status: "RESERVED",
      } });
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const crashesAfterRelease = f.cancellationService(async (admission) => {
        await f.releaseExistingCredit(admission);
        throw new Error("simulated crash after durable release");
      });
      expect(await crashesAfterRelease.cancelClaimed(commandId, claim.leaseToken,
        "human_content_moderation_blocked")).toBe("held");
      expect((await f.commandState(commandId))?.state).toBe("CANCELLED");
      expect((await f.db.usageReservation.findUniqueOrThrow({ where: { sourceKey } })).status)
        .toBe("RELEASED");
      await f.db.merchantConversationSendCommand.update({ where: { id: commandId },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });
      f.releaseExistingCredit.mockClear();
      expect(await f.cancellationService().repairCancelledClaims()).toBe(1);
      expect(f.releaseExistingCredit).not.toHaveBeenCalled();
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
        .initiationKey).toBeNull();
      expect(f.providerHttpRequests).toHaveLength(0);
    } finally { await f.close(); }
  }, 60_000);

  it("does not release an ambiguous credit or let a new claimant take its attempt", async () => {
    const f = await humanDispatchFixture("ambiguous-credit-holds");
    try {
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand();
      const sourceKey = createRecoveryIdempotencyKey(f.shopId, `recovery-outreach:${attemptId}`);
      const counter = await f.db.shopEntitlementCounter.create({ data: {
        shopId: f.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS",
        grantedQuantity: 1, reservedQuantity: 1,
      } });
      await f.db.usageReservation.create({ data: {
        shopId: f.shopId, counterId: counter.id, sourceKey, quantity: 1, status: "AMBIGUOUS",
      } });
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      expect(await f.cancellationService().cancelClaimed(commandId, claim.leaseToken,
        "human_content_moderation_blocked")).toBe("held");
      expect((await f.commandState(commandId))?.state).toBe("CANCELLED");
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
        .initiationKey).toBe(`merchant-${f.recoveryId}`);
      expect(f.releaseExistingCredit).not.toHaveBeenCalled();
    } finally { await f.close(); }
  }, 60_000);

  it("serializes HUMAN cancellation with a scheduled AUTOMATION claim", async () => {
    const f = await humanDispatchFixture("human-automation-race");
    try {
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand();
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      await f.changeOwner("HUMAN", "AI", 1);
      const [cancel, automation] = await Promise.all([
        f.cancellationService().cancelClaimed(commandId, claim.leaseToken,
          "human_content_moderation_blocked"),
        f.followUps.claimSequenceTwo({ recoveryId: f.recoveryId,
          initiator: "scheduled_no_response", initiationKey: "automated-follow-up",
          recipient: f.recipient, now: new Date(),
        }),
      ]);
      expect(cancel).toBe("released");
      if (automation.kind !== "claimed") {
        expect(automation).toEqual({ kind: "suppressed", reason: "already-claimed" });
        expect(await f.followUps.claimSequenceTwo({ recoveryId: f.recoveryId,
          initiator: "scheduled_no_response", initiationKey: "automated-follow-up",
          recipient: f.recipient, now: new Date(),
        })).toEqual({ kind: "claimed", attemptId, billingSource: `recovery-outreach:${attemptId}` });
      } else {
        expect(automation.attemptId).toBe(attemptId);
      }
      expect(await f.db.recoveryOutreachAttempt.count({
        where: { checkoutRecoveryId: f.recoveryId, sequence: 2 },
      })).toBe(1);
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
        .initiationKey).toBe("automated-follow-up");
      expect(f.providerHttpRequests).toHaveLength(0);
    } finally { await f.close(); }
  }, 60_000);

  it("preserves the claim if the current worker lease expires before cancellation", async () => {
    const f = await humanDispatchFixture("cancel-lease-expiry");
    try {
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand();
      // The ARCH-040 database guard deliberately forbids shortening an active
      // CLAIMED lease with UPDATE. Let the shortest supported real lease expire
      // and use PostgreSQL's clock, which also governs the cancellation CAS.
      const claim = (await f.commands.claimDueHumanCommands({
        limit: 1, now: new Date(), leaseMs: 5_000,
      }))[0]!;
      await vi.waitFor(async () => {
        const [lease] = await f.db.$queryRawUnsafe<Array<{ expired: boolean }>>(`
          SELECT ("leaseExpiresAt" <= statement_timestamp()) AS "expired"
          FROM "whatsapp"."MerchantConversationSendCommand" WHERE "id"=$1`, commandId);
        expect(lease?.expired).toBe(true);
      }, { timeout: 12_000, interval: 100 });

      // A second worker may reclaim only after expiry; an old worker must
      // never cancel that new lease or release the HUMAN sequence-two claim.
      const [cancel, successors] = await Promise.all([
        f.cancellationService().cancelClaimed(commandId, claim.leaseToken,
          "human_content_moderation_blocked"),
        f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }),
      ]);
      expect(cancel).toBe("stale");
      expect(successors).toHaveLength(1);
      expect(successors[0]?.id).toBe(commandId);
      expect(successors[0]?.leaseToken).not.toBe(claim.leaseToken);
      expect((await f.commandState(commandId))?.state).toBe("CLAIMED");
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
        .initiationKey).toBe(`merchant-${f.recoveryId}`);
      expect(f.releaseExistingCredit).not.toHaveBeenCalled();
      expect(f.providerHttpRequests).toHaveLength(0);
    } finally { await f.close(); }
  }, 60_000);

  it("serializes final provider admission against cancellation of the same command", async () => {
    const f = await humanDispatchFixture("provider-permit-cancel-race");
    try {
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand();
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const [cancel, permit] = await Promise.all([
        f.cancellationService().cancelClaimed(commandId, claim.leaseToken,
          "human_content_moderation_blocked"),
        new OutboundSendFenceService(f.db, f.durableEligibility).admitFinalSend({
          senderType: "HUMAN", conversationId: f.conversationId, shopId: f.shopId,
          recoveryId: f.recoveryId, expectedControlRevision: 1, commandId,
          leaseToken: claim.leaseToken, recipient: f.recipient, now: new Date(),
        }),
      ]);
      const attempt = await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      if (permit.kind === "admitted") {
        expect(cancel).toBe("stale");
        expect(attempt.initiationKey).toBe(`merchant-${f.recoveryId}`);
      } else {
        expect(cancel).toBe("released");
        expect(attempt.initiationKey).toBeNull();
      }
      expect(f.providerHttpRequests).toHaveLength(0);
    } finally { await f.close(); }
  }, 60_000);

  it("refuses any release after the durable provider permit", async () => {
    const f = await humanDispatchFixture("permit-irreversible");
    try {
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand();
      const lease = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const permit = await new OutboundSendFenceService(f.db, f.durableEligibility).admitFinalSend({
        senderType: "HUMAN", conversationId: f.conversationId, shopId: f.shopId,
        recoveryId: f.recoveryId, expectedControlRevision: 1, commandId, leaseToken: lease.leaseToken,
        recipient: f.recipient, now: new Date(),
      });
      expect(permit.kind).toBe("admitted");
      const service = new FollowUpClaimCancellationService(f.db, f.commands);
      expect(await service.cancelClaimed(commandId, lease.leaseToken, "human_moderation_review_required"))
        .toBe("stale");
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
        .initiationKey).toBe(`merchant-${f.recoveryId}`);
      expect(await service.repairCancelledClaims()).toBe(0);
    } finally { await f.close(); }
  }, 60_000);

});
