import { randomUUID } from "node:crypto";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { describe, expect, it } from "vitest";
import { adoptInitial, exactBlockSource } from "../../src/services/recovery-allowance/storage.js";
import { lockRecoveryContext } from "../../src/services/recovery-conversation/recovery-conversation.sql.js";
import { RecoveryDeliveryCompensationService } from "../../src/services/recovery-delivery-compensation/reconcile.service.js";
import { inspectScheduledFollowUpRetryLineage } from "../../src/services/recovery-delivery-retry/follow-up-lineage.js";
import { ScheduledFollowUpRetryFundingService } from "../../src/services/recovery-delivery-retry/follow-up-funding.js";
import { withOneRecoveryTransactionFault } from "./fixtures/recovery-transaction-fault.fixture.js";
import { FreeRecoveryReservationService } from "../../src/services/free-recovery-reservation.service.js";
import { createInitialOutreachCreditFixture } from "./fixtures/arch056-initial-outreach-credit.fixture.js";

const suite = process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

async function prepareCompensatedFollowUp(source: "free" | "purchased") {
  // The fixture uses Shopify for free and WooCommerce for purchased initial
  // funding. Historical acceptance is seeded; no provider is called.
  const f = await createInitialOutreachCreditFixture({ source, sentAgeMs: 60 * 60_000 });
  try {
    expect(await f.service.settleConfirmedInitialOutreach({ shopId: f.shopId, recoveryId: f.recoveryId,
      outreachAttemptId: f.attemptId, outboundMessageId: f.messageId })).toMatchObject({ kind: "settled" });
    const conversation = await f.db.conversation.findUniqueOrThrow({ where: { checkoutRecoveryId: f.recoveryId } });
    await f.db.recoveryOutreachAttempt.update({ where: { id: f.attemptId }, data: { status: "NO_RESPONSE" } });
    const initial = await f.db.$transaction(tx => adoptInitial(tx, conversation.id, { outboundHardLimit: 20, terminalMessageReservedSlots: 1 }));
    const attemptId = randomUUID();
    const sourceKey = createRecoveryIdempotencyKey(f.shopId, `recovery-outreach:${attemptId}`);
    const sentAt = new Date(f.sentAt.getTime() + 30 * 60_000);
    const failedAt = new Date(sentAt.getTime() + 1_000);
    const providerMessageId = `wamid-${randomUUID()}`;
    // Establish a second historical reservation, then use the real credit
    // owner to commit it. This is fixture data, not retry admission.
    const reservation = await f.db.$transaction(async tx => {
      const counter = await tx.shopEntitlementCounter.update({
        where: { shopId_counter: { shopId: f.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" } },
        data: { grantedQuantity: { increment: 1 }, reservedQuantity: { increment: 1 }, version: { increment: 1 } },
      });
      return tx.usageReservation.create({ data: { shopId: f.shopId, counterId: counter.id,
        sourceKey, quantity: 1, status: "RESERVED" } });
    });
    expect(await new FreeRecoveryReservationService(f.db).commit({ shopId: f.shopId, sourceKey })).toMatchObject({ kind: "committed" });
    const block = await f.db.$transaction(async tx => {
      await lockRecoveryContext(tx, conversation.id);
      await tx.conversationAllowanceBlock.update({ where: { id: initial.id }, data: { state: "CLOSED" } });
      return tx.conversationAllowanceBlock.create({ data: { shopId: f.shopId, conversationId: conversation.id,
        ordinal: 1, fundingKind: "FOLLOW_UP", state: "ACTIVE", predecessorId: initial.id,
        creditReservationId: reservation.id, hardMessageLimit: 20, terminalReservedSlots: 1 } });
    });
    const message = await f.db.conversationMessage.create({ data: { conversationId: conversation.id,
      direction: "OUTBOUND", senderType: "AUTOMATION", status: "SENT", content: "Scheduled follow-up fixture",
      providerMessageId, sentAt, allowanceBlockId: block.id } });
    await f.db.recoveryOutreachAttempt.create({ data: { id: attemptId, checkoutRecoveryId: f.recoveryId, sequence: 2,
      trigger: "NO_RESPONSE_FOLLOW_UP", status: "WAITING_FOR_RESPONSE", recipient: "15551234567", configuredOfferMode: "NONE",
      initiatedBy: "AUTOMATION", initiationKey: `scheduled-no-response:${f.recoveryId}`, claimedAt: sentAt,
      sentAt, outboundMessageId: message.id } });
    await f.db.usageEvent.create({ data: { shopId: f.shopId, metric: "OUTBOUND_AUTOMATED_MESSAGE", quantity: 1,
      provider: f.provider, idempotencyKey: `recovery-outreach:${attemptId}`, sourceType: "OUTBOUND_AUTOMATED_MESSAGE", sourceId: message.id } });
    await f.db.conversationMessage.update({ where: { id: message.id }, data: { status: "FAILED", failedAt, providerFailureCode: "131016" } });
    expect(await new RecoveryDeliveryCompensationService(f.db).reconcile(providerMessageId)).toBe("restored-spendable");
    const intent = await f.db.recoveryOutreachRetryIntent.findUniqueOrThrow({ where: { failedAttemptId: attemptId } });
    expect(intent).toMatchObject({ policy: "AFTER_COOLDOWN", fundingReservationId: reservation.id, failedMessageId: message.id });
    return { f, conversation, initial, attemptId, reservation, block, message, intent, failedAt };
  } catch (error) {
    await f.close();
    throw error;
  }
}

suite("Scheduled follow-up retry lineage (PostgreSQL)", () => {
  it.each(["free", "purchased"] as const)("proves the compensated follow-up on the %s initial-credit fixture without creating a successor", async source => {
    const { f, conversation, initial, reservation, block, intent, failedAt } = await prepareCompensatedFollowUp(source);
    try {
      const history = await f.db.usageReservation.findMany({ where: { shopId: f.shopId }, orderBy: { id: "asc" } });
      const blocks = await f.db.conversationAllowanceBlock.findMany({ where: { conversationId: conversation.id }, orderBy: { ordinal: "asc" } });
      expect(blocks[1]).toMatchObject({ state: "CANCELLED", creditReservationId: reservation.id });
      const inspect = (now: Date) => f.db.$transaction(async tx => {
        expect(await lockRecoveryContext(tx, conversation.id)).toMatchObject({ shopId: f.shopId, recoveryId: f.recoveryId });
        return inspectScheduledFollowUpRetryLineage(tx, { shopId: f.shopId, recoveryId: f.recoveryId,
          conversationId: conversation.id, intentId: intent.id, now });
      }, { isolationLevel: "Serializable" });
      await expect(inspect(failedAt)).rejects.toThrow("cooldown is held");
      const due = new Date(intent.notBeforeAt!.getTime() + 1);
      const expected = { kind: "proven", plan: { kind: "new", sequence: 3, attemptId: `retry_${intent.id}`, initialAttemptId: f.attemptId },
        allowance: { initialBlockId: initial.id, failedBlockId: block.id } };
      expect(await inspect(due)).toMatchObject(expected);
      expect(await inspect(due)).toMatchObject(expected);
      // Reading eligibility cannot spend a credit, revive a block or allocate
      // another attempt/message even when the same intent is inspected twice.
      expect(await f.db.usageReservation.findMany({ where: { shopId: f.shopId }, orderBy: { id: "asc" } })).toEqual(history);
      expect(await f.db.conversationAllowanceBlock.findMany({ where: { conversationId: conversation.id }, orderBy: { ordinal: "asc" } })).toEqual(blocks);
      expect(await f.db.recoveryOutreachAttempt.count({ where: { checkoutRecoveryId: f.recoveryId } })).toBe(2);
      expect(await f.db.conversationMessage.count({ where: { conversationId: conversation.id } })).toBe(2);
    } finally { await f.close(); }
  }, 60_000);
});

async function registerHistoricalSender(f: Awaited<ReturnType<typeof prepareCompensatedFollowUp>>) {
  const phone = BigInt(`0x${randomUUID().replace(/-/g, "")}`).toString();
  const account = "918273645546372819";
  const recipient = "15551234567";
  await f.f.db.whatsAppPoolSender.create({ data: { providerPhoneNumberId: phone, providerAccountId: account,
    verifiedAt: f.f.sentAt, allocationEnabled: false } });
  const thread = await f.f.db.recoverySenderThread.create({ data: { canonicalRecipient: recipient, providerPhoneNumberId: phone, openedAt: f.f.sentAt } });
  const route = await f.f.db.recoverySenderRoute.create({ data: { shopId: f.f.shopId, threadId: thread.id,
    canonicalRecipient: recipient, providerPhoneNumberId: phone, openedAt: f.f.sentAt } });
  await f.f.db.recoverySenderAssignment.create({ data: { conversationId: f.conversation.id, routeId: route.id, assignedAt: f.f.sentAt } });
  await f.f.db.conversationMessage.update({ where: { id: f.message.id }, data: {
    dispatchProviderAccountId: account, dispatchProviderPhoneNumberId: phone,
  } });
}

suite("Scheduled follow-up retry funding (PostgreSQL; no provider dispatch)", () => {
  it.each(["free", "purchased"] as const)("atomically claims and funds one retry for the %s initial-credit fixture and replays the exact tuple", async source => {
    const fixture = await prepareCompensatedFollowUp(source);
    const { f, conversation, initial, attemptId, block, intent, failedAt } = fixture;
    try {
      const scope = { shopId: f.shopId, recoveryId: f.recoveryId, conversationId: conversation.id, intentId: intent.id };
      const due = new Date(Math.max(Date.now(), intent.notBeforeAt!.getTime() + 1));
      const funding = new ScheduledFollowUpRetryFundingService(f.db, () => due);
      const oldAttempt = await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      const oldBlocks = await f.db.conversationAllowanceBlock.findMany({ where: { conversationId: conversation.id }, orderBy: { ordinal: "asc" } });
      const oldCredit = await f.db.usageReservation.findUniqueOrThrow({ where: { id: intent.fundingReservationId } });
      await expect(funding.claimAndFund(scope)).resolves.toEqual({ kind: "held", reason: "follow-up-disabled" });
      await f.db.shopSettings.create({ data: { shopId: f.shopId, followUpEnabled: true, followUpDelayMinutes: 30 } });
      await expect(new ScheduledFollowUpRetryFundingService(f.db, () => failedAt).claimAndFund(scope)).resolves.toMatchObject({ kind: "held" });
      await expect(funding.claimAndFund(scope)).resolves.toEqual({ kind: "held", reason: "sender-identity-changed" });
      await registerHistoricalSender(fixture);
      expect(await f.db.recoveryOutreachAttempt.count({ where: { checkoutRecoveryId: f.recoveryId } })).toBe(2);
      expect(await f.db.usageReservation.count({ where: { shopId: f.shopId } })).toBe(2);
      // Exhaust the only free credit through the real source owner. There is
      // no other spendable credit in either fixture, including Woo's used lot.
      const other = new FreeRecoveryReservationService(f.db);
      const otherKey = createRecoveryIdempotencyKey(f.shopId, `other-${randomUUID()}`);
      expect(await other.reserve({ shopId: f.shopId, sourceKey: otherKey })).toMatchObject({ kind: "reserved" });
      await expect(funding.claimAndFund(scope)).resolves.toEqual({ kind: "held", reason: "credit:capacity-exhausted" });
      expect(await f.db.recoveryOutreachAttempt.count({ where: { checkoutRecoveryId: f.recoveryId } })).toBe(2);
      expect(await f.db.conversationAllowanceBlock.count({ where: { conversationId: conversation.id } })).toBe(2);
      expect(await other.release({ shopId: f.shopId, sourceKey: otherKey })).toMatchObject({ kind: "released" });
      // Prove real rollback on Shopify and lost commit ACK on Woo; the
      // replayable owner cannot create another reservation or block.
      const fault = withOneRecoveryTransactionFault(f.db, source === "free" ? "rollback" : "lost-ack");
      const first = await new ScheduledFollowUpRetryFundingService(fault.database, () => due).claimAndFund(scope);
      expect(fault.injected()).toBe(true);
      expect(fault.calls()).toBe(2);
      expect(first).toMatchObject({ kind: source === "free" ? "funded" : "existing", attemptId: `retry_${intent.id}`, sequence: 3 });
      if (first.kind === "held") throw new Error(`Funding held: ${first.reason}`);
      const replays = await Promise.all([funding.claimAndFund(scope), new ScheduledFollowUpRetryFundingService(f.db, () => due).claimAndFund(scope)]);
      for (const replay of replays) expect(replay).toMatchObject({ kind: "existing", attemptId: first.attemptId, sequence: 3,
        blockId: first.blockId, reservationId: first.reservationId });
      const fresh = await f.db.usageReservation.findUniqueOrThrow({ where: { id: first.reservationId } });
      expect(fresh).toMatchObject({ status: "RESERVED", quantity: 1, committedUsageEventId: null, compensationUsageEventId: null });
      expect(fresh.id).not.toBe(oldCredit.id);
      const successor = await f.db.conversationAllowanceBlock.findUniqueOrThrow({ where: { id: first.blockId } });
      expect(successor).toMatchObject({ ordinal: 2, fundingKind: "FOLLOW_UP", state: "PENDING", predecessorId: initial.id,
        creditReservationId: first.reservationId });
      expect(await f.db.$transaction(tx => exactBlockSource(tx, successor))).toMatchObject({ reservation: { id: first.reservationId } });
      expect(await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: first.attemptId } })).toMatchObject({
        sequence: 3, trigger: "NO_RESPONSE_FOLLOW_UP", initiatedBy: "AUTOMATION", initiationKey: `scheduled-no-response-retry:${intent.id}`,
        status: "PENDING", outboundMessageId: null, sentAt: null,
      });
      expect(await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } })).toEqual(oldAttempt);
      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: oldCredit.id } })).toEqual(oldCredit);
      expect(await f.db.conversationAllowanceBlock.findUniqueOrThrow({ where: { id: initial.id } })).toEqual(oldBlocks[0]);
      expect(await f.db.conversationAllowanceBlock.findUniqueOrThrow({ where: { id: block.id } })).toEqual(oldBlocks[1]);
      expect(await f.db.usageReservation.count({ where: { shopId: f.shopId, status: "RESERVED" } })).toBe(1);
      expect(await f.db.recoveryOutreachAttempt.count({ where: { checkoutRecoveryId: f.recoveryId } })).toBe(3);
      expect(await f.db.conversationAllowanceBlock.count({ where: { conversationId: conversation.id } })).toBe(3);
      expect(await f.db.conversationMessage.count({ where: { conversationId: conversation.id } })).toBe(2);
      expect(await f.db.usageEvent.findUnique({ where: { idempotencyKey: `recovery-outreach:${first.attemptId}` } })).toBeNull();
      // A policy change holds the existing reservation; it must not switch
      // billing source, release a possibly progressed action, or fund again.
      await f.db.shopSettings.update({ where: { shopId: f.shopId }, data: { followUpEnabled: false, followUpDelayMinutes: null } });
      await expect(funding.claimAndFund(scope)).resolves.toEqual({ kind: "held", reason: "follow-up-disabled" });
      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: fresh.id } })).toEqual(fresh);
    } finally { await f.close(); }
  }, 60_000);
});
