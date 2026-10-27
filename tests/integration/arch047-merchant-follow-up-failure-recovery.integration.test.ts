import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { describe, expect, it, vi } from "vitest";
import { FreeRecoveryReservationService } from "../../src/services/free-recovery-reservation.service.js";
import { OutboundSendFenceService } from
  "../../src/services/recovery-conversation/outbound-send-fence.service.js";
import { writeLocalStop } from "../../src/services/whatsapp-contact-opt-out/stop-writer.js";
import { hasLocalNoContact } from "../../src/services/whatsapp-contact-opt-out/local-no-contact.js";
import { canonicalWhatsAppSender } from "../../src/services/whatsapp-contact-opt-out/phone.js";
import { approvedMerchantFollowUpFixture, preparedFollowUp } from
  "./fixtures/arch047-human-follow-up.fixture.js";

const suite = process.env.TEST_DATABASE_URL && process.env.REDIS_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

/** BG007-specific race and compensation proofs: actual SQL command/attempt
 * leases, BG006 late registration fence, and the disposable Meta HTTP emulator.
 * Provider billing ports remain injected as in the existing ARCH-040 fixture.
 */
suite("ARCH-047 BG007 late STOP, failures, and retry boundaries", () => {
  const fence = (db: Awaited<ReturnType<typeof approvedMerchantFollowUpFixture>>["f"]["db"]) =>
    new OutboundSendFenceService(db, async () => null);

  it("fails closed when STOP commits after BG001 preparation and releases the one provisional credit", async () => {
    const seeded = await approvedMerchantFollowUpFixture("stop-after-preparation");
    try {
      const { f, identity } = seeded;
      // The canonical wa_id must pass the same identity parser as the SQL STOP fence.
      expect(canonicalWhatsAppSender(f.recipient)).toBe(f.recipient);
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand(identity.providerTemplateName);
      const customer = await f.db.customer.create({ data: { shopId: f.shopId, phone: `+${f.recipient}` } });
      await f.db.customerPhone.create({ data: {
        customerId: customer.id, phone: `+${f.recipient}`,
        whatsappCanonicalPhone: f.recipient,
      } });
      const sourceKey = createRecoveryIdempotencyKey(f.shopId, `recovery-outreach:${attemptId}`);
      let prepared = false;
      const resolver = vi.fn(async () => {
        prepared = true;
        return preparedFollowUp(identity);
      });
      const credit = f.billing.admitAndRevalidate.mockImplementationOnce(async () => {
        expect(prepared).toBe(true);
        const counter = await f.db.shopEntitlementCounter.create({ data: {
          shopId: f.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS",
          grantedQuantity: 1, reservedQuantity: 1,
        } });
        await f.db.usageReservation.create({ data: {
          shopId: f.shopId, counterId: counter.id, sourceKey, quantity: 1, status: "RESERVED",
        } });
        const stop = await writeLocalStop(f.db, {
          canonical: f.recipient, shopId: f.shopId, eventId: randomUUID(), at: new Date(),
        });
        expect(stop.changed).toBe(1);
        // Prove the committed STOP is observable by the exact predicate used
        // inside BG006 final SQL admission, before returning to the dispatcher.
        expect(await hasLocalNoContact(f.db, {
          shopId: f.shopId, recipient: f.recipient,
        })).toBe(true);
        return { kind: "admitted" as const, admission: { sourceKey } };
      });
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const lateFence = fence(f.db);
      const permit = vi.spyOn(lateFence, "admitFinalSend");
      const dispatcher = f.dispatcher(undefined, undefined, undefined, undefined, {
        fence: lateFence, followUpTemplates: { resolve: resolver } as never,
      });
      await dispatcher.processClaim(commandId, claim.leaseToken);
      await dispatcher.close();
      expect(permit).toHaveBeenCalledOnce();
      expect(resolver).toHaveBeenCalledOnce();
      expect(credit).toHaveBeenCalledOnce();
      expect(await f.commandState(commandId)).toMatchObject({
        state: "CANCELLED", providerDispatchKey: null, outboundMessageId: null,
      });
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
        .initiationKey).toBeNull();
      expect((await f.db.usageReservation.findUniqueOrThrow({ where: { sourceKey } })).status)
        .toBe("RELEASED");
      expect(f.releaseExistingCredit).toHaveBeenCalledOnce();
      expect(f.providerHttpRequests).toEqual([]);
      expect(f.billing.onConfirmedProviderSend).not.toHaveBeenCalled();
      expect(await f.db.usageEvent.count({ where: { shopId: f.shopId } })).toBe(0);
    } finally { await seeded.cleanup(); }
  }, 60_000);

  it("rejects control loss after preparation without another Meta request or charged follow-up", async () => {
    const seeded = await approvedMerchantFollowUpFixture("control-loss-after-preparation");
    try {
      const { f, identity } = seeded;
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand(identity.providerTemplateName);
      let prepared = false;
      const resolver = vi.fn(async () => {
        prepared = true;
        return preparedFollowUp(identity);
      });
      // Let claimSequenceTwo succeed; transfer control only after preparation,
      // claim and billing, immediately before BG006's locked final permit.
      f.billing.admitAndRevalidate.mockImplementationOnce(async (input) => {
        expect(prepared).toBe(true);
        await f.changeOwner("HUMAN", "AI", 1);
        return { kind: "admitted" as const,
          admission: { sourceKey: `recovery-outreach:${input.sequenceTwoAttemptId}` } };
      });
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const lateFence = fence(f.db);
      const permit = vi.spyOn(lateFence, "admitFinalSend");
      await f.dispatcher(undefined, undefined, undefined, undefined, {
        fence: lateFence, followUpTemplates: { resolve: resolver } as never,
      }).processClaim(commandId, claim.leaseToken);
      expect(resolver).toHaveBeenCalledOnce();
      expect(permit).toHaveBeenCalledOnce();
      expect(await f.commandState(commandId)).toMatchObject({
        state: "CANCELLED", providerDispatchKey: null, outboundMessageId: null,
      });
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
        .initiationKey).toBeNull();
      expect(f.providerHttpRequests).toHaveLength(0);
      expect(f.billing.onConfirmedProviderSend).not.toHaveBeenCalled();
      expect(await f.db.usageEvent.count({ where: { shopId: f.shopId } })).toBe(0);
    } finally { await seeded.cleanup(); }
  }, 60_000);

  it("keeps a provider timeout UNKNOWN across worker restart, settles only verified evidence, and never resubmits", async () => {
    const seeded = await approvedMerchantFollowUpFixture("timeout-unknown-restart");
    try {
      const { f, identity } = seeded;
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand(identity.providerTemplateName);
      const resolver = vi.fn(async () => preparedFollowUp(identity));
      f.failNextProviderHttp("timeout");
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const first = f.dispatcher(undefined, undefined, undefined, undefined, {
        fence: fence(f.db), followUpTemplates: { resolve: resolver } as never,
      });
      await first.processClaim(commandId, claim.leaseToken);
      await first.close();
      expect(await f.commandState(commandId)).toMatchObject({
        state: "UNKNOWN", providerDispatchKey: expect.any(String), outboundMessageId: expect.any(String),
      });
      expect(f.providerHttpRequests).toEqual([{ type: "template" }]);
      expect(f.billing.onConfirmedProviderSend).not.toHaveBeenCalled();
      expect(f.billing.onDefinitiveProviderFailure).not.toHaveBeenCalled();
      const restarted = f.dispatcher(undefined, undefined, undefined, undefined, {
        fence: fence(f.db), followUpTemplates: { resolve: resolver } as never,
      });
      await restarted.poll();
      expect(await f.commands.claimDueHumanCommands({ limit: 5, now: new Date(Date.now() + 600_000) }))
        .toEqual([]);
      await expect(f.reconciliation.reconcileUnknown({ commandId,
        outcome: { kind: "accepted", providerMessageId: "unverified-ignored" }, verified: false,
      })).resolves.toEqual({ kind: "ignored", reason: "unverified-provider-outcome" });
      expect((await f.commandState(commandId))?.state).toBe("UNKNOWN");
      expect((await f.reconciliation.reconcileUnknown({ commandId,
        outcome: { kind: "accepted", providerMessageId: `wa-${randomUUID()}` }, verified: true,
      })).kind).toBe("sent");
      await restarted.reconcileConfirmedFollowUps();
      await restarted.reconcileConfirmedFollowUps();
      await restarted.close();
      expect(f.provider.sendWhatsAppTemplate).toHaveBeenCalledOnce();
      expect(f.providerHttpRequests).toEqual([{ type: "template" }]);
      expect((await f.commandState(commandId))?.state).toBe("SENT");
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
        .status).toBe("WAITING_FOR_RESPONSE");
      expect(f.billing.onConfirmedProviderSend).toHaveBeenCalledOnce();
      expect(await f.db.recoveryOutreachAttempt.count({
        where: { checkoutRecoveryId: f.recoveryId, sequence: 2 },
      })).toBe(1);
    } finally { await seeded.cleanup(); }
  }, 60_000);


  it("recovers an expired BG007 template permit as UNKNOWN without ever replaying the Meta call", async () => {
    const seeded = await approvedMerchantFollowUpFixture("expired-permit-restart");
    try {
      const { f, identity } = seeded;
      const { commandId } = await f.addMerchantFollowUpCommand(identity.providerTemplateName);
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      // Model a hard crash after a committed BG006 permit but before transport.
      expect((await fence(f.db).admitFinalSend({
        senderType: "HUMAN", shopId: f.shopId, recoveryId: f.recoveryId,
        conversationId: f.conversationId, expectedControlRevision: 1,
        commandId, leaseToken: claim.leaseToken, recipient: f.recipient, now: new Date(),
        proactive: { consent: null, verifiedCategory: "MARKETING",
          templateName: identity.providerTemplateName,
          languageCode: identity.providerLanguageCode, templateRegistration: identity },
      })).kind).toBe("admitted");
      await f.db.$executeRawUnsafe(`UPDATE "whatsapp"."MerchantConversationSendCommand"
        SET "leaseExpiresAt"=statement_timestamp()-interval '1 second' WHERE "id"=$1`, commandId);
      const restarted = f.dispatcher();
      await restarted.reconcileExpiredPermits();
      await restarted.poll();
      await restarted.close();
      expect(await f.commandState(commandId)).toMatchObject({
        state: "UNKNOWN", providerDispatchKey: expect.any(String), outboundMessageId: expect.any(String),
      });
      expect(f.providerHttpRequests).toEqual([]);
      expect(f.provider.sendWhatsAppTemplate).not.toHaveBeenCalled();
      expect(await f.commands.claimDueHumanCommands({ limit: 3, now: new Date(Date.now() + 600_000) }))
        .toEqual([]);
      expect((await f.reconciliation.reconcileUnknown({ commandId,
        verified: true, outcome: { kind: "definitive-failure", reason: "provider_rejected" },
      })).kind).toBe("definitive-failure");
      expect((await f.commandState(commandId))?.state).toBe("FAILED");
      expect(f.providerHttpRequests).toEqual([]);
    } finally { await seeded.cleanup(); }
  }, 60_000);

  it("definitive Meta refusal releases the persisted credit once; replay cannot refund or dispatch again", async () => {
    const seeded = await approvedMerchantFollowUpFixture("provider-reject-credit-refund");
    try {
      const { f, identity } = seeded;
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand(identity.providerTemplateName);
      const sourceKey = createRecoveryIdempotencyKey(f.shopId, `recovery-outreach:${attemptId}`);
      const counter = await f.db.shopEntitlementCounter.create({ data: {
        shopId: f.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS",
        grantedQuantity: 1, reservedQuantity: 1,
      } });
      await f.db.usageReservation.create({ data: {
        shopId: f.shopId, counterId: counter.id, sourceKey, quantity: 1, status: "RESERVED",
      } });
      f.billing.onDefinitiveProviderFailure.mockImplementationOnce(async () => {
        const released = await new FreeRecoveryReservationService(f.db).release({ shopId: f.shopId, sourceKey });
        expect(released.kind).toBe("released");
      });
      f.failNextProviderHttp("provider-rejected");
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const dispatcher = f.dispatcher(undefined, undefined, undefined, undefined, {
        fence: fence(f.db), followUpTemplates: { resolve: vi.fn(async () => preparedFollowUp(identity)) } as never,
      });
      await dispatcher.processClaim(commandId, claim.leaseToken);
      await dispatcher.processClaim(commandId, claim.leaseToken);
      await dispatcher.poll();
      await dispatcher.close();
      expect(await f.commandState(commandId)).toMatchObject({
        state: "FAILED", providerDispatchKey: expect.any(String), outboundMessageId: expect.any(String),
      });
      expect(f.billing.onDefinitiveProviderFailure).toHaveBeenCalledOnce();
      expect(f.billing.onConfirmedProviderSend).not.toHaveBeenCalled();
      expect((await f.db.usageReservation.findUniqueOrThrow({ where: { sourceKey } })).status)
        .toBe("RELEASED");
      expect((await f.db.shopEntitlementCounter.findUniqueOrThrow({ where: { id: counter.id } }))
        .reservedQuantity).toBe(0);
      expect(f.providerHttpRequests).toEqual([{ type: "template" }]);
      expect((await f.reconciliation.recordDefinitiveFailure({ commandId,
        reason: "provider_rejected", definitiveProviderEvidence: true,
      })).kind).toBe("ignored");
      expect(f.billing.onDefinitiveProviderFailure).toHaveBeenCalledOnce();
      expect(await f.db.usageEvent.count({ where: { shopId: f.shopId } })).toBe(0);
    } finally { await seeded.cleanup(); }
  }, 60_000);

  it("reclaims a deferred pre-permit command with a fresh lease but the SAME sequence-two attempt", async () => {
    const seeded = await approvedMerchantFollowUpFixture("deferred-reclaim");
    try {
      const { f, identity } = seeded;
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand(identity.providerTemplateName);
      const resolver = vi.fn(async () => preparedFollowUp(identity));
      f.billing.admitAndRevalidate.mockImplementationOnce(async () => ({
        kind: "blocked", reason: "capacity-exhausted",
      } as never));
      const firstLease = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const dispatcher = f.dispatcher(undefined, undefined, undefined, undefined, {
        fence: fence(f.db), followUpTemplates: { resolve: resolver } as never,
      });
      await dispatcher.processClaim(commandId, firstLease.leaseToken);
      expect(await f.commandState(commandId)).toMatchObject({
        state: "FAILED", providerDispatchKey: null, outboundMessageId: null,
      });
      expect(f.providerHttpRequests).toHaveLength(0);
      // Advance the legitimate retry's due time; a new owner gets a fresh lease.
      await f.db.merchantConversationSendCommand.update({ where: { id: commandId },
        data: { nextAttemptAt: new Date(Date.now() - 1_000) },
      });
      const nextLease = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      expect(nextLease.id).toBe(commandId);
      expect(nextLease.leaseToken).not.toBe(firstLease.leaseToken);
      await dispatcher.processClaim(commandId, firstLease.leaseToken); // stale worker cannot steal it
      await dispatcher.processClaim(commandId, nextLease.leaseToken);
      await dispatcher.close();
      await f.whatsapp.waitForMessageCount(1);
      expect(await f.commandState(commandId)).toMatchObject({
        state: "SENT", providerDispatchKey: expect.any(String), dispatchAttemptCount: 2,
      });
      expect(f.providerHttpRequests).toEqual([{ type: "template" }]);
      expect(f.billing.admitAndRevalidate).toHaveBeenCalledTimes(2);
      expect(f.billing.onConfirmedProviderSend).toHaveBeenCalledOnce();
      expect(await f.db.recoveryOutreachAttempt.count({
        where: { checkoutRecoveryId: f.recoveryId, sequence: 2 },
      })).toBe(1);
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
        .outboundMessageId).toBe((await f.commandState(commandId))?.outboundMessageId);
    } finally { await seeded.cleanup(); }
  }, 60_000);
});
