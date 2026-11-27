import { randomUUID } from "node:crypto";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { describe, expect, it } from "vitest";
import { checkScheduledFollowUpRetryPermit, followUpRetryDispatchKey } from "../../src/services/recovery-delivery-retry/follow-up-permit.js";
import { RecoveryAllowanceService } from "../../src/services/recovery-allowance/renewal.service.js";
import { OutboundAdmissionReservationService } from "../../src/services/outbound-whatsapp-admission/outbound-admission-reservation.service.js";
import { exactBlockSource } from "../../src/services/recovery-allowance/storage.js";
import { lockRecoveryContext } from "../../src/services/recovery-conversation/recovery-conversation.sql.js";
import { inspectScheduledFollowUpRetryLineage } from "../../src/services/recovery-delivery-retry/follow-up-lineage.js";
import { ScheduledFollowUpRetryFundingService } from "../../src/services/recovery-delivery-retry/follow-up-funding.js";
import { withOneRecoveryTransactionFault } from "./fixtures/recovery-transaction-fault.fixture.js";
import { FreeRecoveryReservationService } from "../../src/services/free-recovery-reservation.service.js";
import { prepareCompensatedFollowUp, registerHistoricalSender } from "./fixtures/follow-up-retry.fixture.js";

const suite = process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;


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


suite("Scheduled follow-up retry permit readiness (PostgreSQL; no provider dispatch)", () => {
  it.each(["free", "purchased"] as const)("keeps the %s retry block exclusive and validates its exact prepared opener", async source => {
    const fixture = await prepareCompensatedFollowUp(source);
    const { f, conversation, intent } = fixture;
    try {
      const scope = { shopId: f.shopId, recoveryId: f.recoveryId, conversationId: conversation.id, intentId: intent.id };
      const due = new Date(Math.max(Date.now(), intent.notBeforeAt!.getTime() + 1));
      await f.db.shopSettings.create({ data: { shopId: f.shopId, followUpEnabled: true, followUpDelayMinutes: 30 } });
      await registerHistoricalSender(fixture);
      const funding = await new ScheduledFollowUpRetryFundingService(f.db, () => due).claimAndFund(scope);
      expect(funding.kind).toBe("funded");
      if (funding.kind === "held") throw new Error(`Funding held: ${funding.reason}`);
      const originalBlock = await f.db.conversationAllowanceBlock.findUniqueOrThrow({ where: { id: funding.blockId } });
      const originalReservation = await f.db.usageReservation.findUniqueOrThrow({ where: { id: funding.reservationId } });
      const allowance = new RecoveryAllowanceService(f.db, undefined, () => due);
      await expect(allowance.attachFollowUp({ id: funding.blockId, token: "foreign" }, funding.admission.sourceKey))
        .rejects.toThrow("follow-up-retry-owner-required");
      await expect(new OutboundAdmissionReservationService(f.db).reserve({ shopId: f.shopId, conversationId: conversation.id,
        idempotencyKey: `ordinary-${randomUUID()}`, senderType: "AGENT", content: "Ordinary reply" }))
        .resolves.toEqual({ kind: "suppressed", reason: "allowance-funding-held" });
      await allowance.reconcileConversation(conversation.id);
      expect(await f.db.conversationAllowanceBlock.findUniqueOrThrow({ where: { id: funding.blockId } })).toEqual(originalBlock);
      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: funding.reservationId } })).toEqual(originalReservation);
      const content = "Prepared follow-up descriptor";
      // A prepared opener is seeded for the SQL readiness check. The worker is
      // still initial-only; this test does not mock provider delivery or claim it.
      const prepared = await f.db.conversationMessage.create({ data: { conversationId: conversation.id, direction: "OUTBOUND",
        senderType: "AUTOMATION", status: "PENDING", allowanceBlockId: funding.blockId, content } });
      const usage = await f.db.usageEvent.create({ data: { shopId: f.shopId, metric: "OUTBOUND_AUTOMATED_MESSAGE", quantity: 1,
        provider: f.provider, idempotencyKey: `recovery-outreach:${funding.attemptId}`, sourceType: "OUTBOUND_AUTOMATED_MESSAGE", sourceId: prepared.id } });
      const input = { ...scope, attemptId: funding.attemptId, messageId: prepared.id, recipient: "15551234567",
        expectedContent: content, sourceKey: funding.admission.sourceKey, now: due };
      const check = (overrides: Partial<typeof input> = {}) => f.db.$transaction(async tx => {
        const owner = await lockRecoveryContext(tx, conversation.id);
        if (!owner) throw new Error("Fixture owner missing");
        return checkScheduledFollowUpRetryPermit(tx, owner, { ...input, ...overrides });
      });
      await expect(check()).resolves.toMatchObject({ kind: "ready", blockId: funding.blockId,
        dispatchKey: followUpRetryDispatchKey(funding.attemptId) });
      await expect(check({ expectedContent: "Different" })).resolves.toEqual({ kind: "held", reason: "retry-prepared-message-mismatch" });
      await expect(check({ sourceKey: "foreign" })).resolves.toEqual({ kind: "held", reason: "retry-reservation-mismatch" });
      await f.db.usageEvent.update({ where: { id: usage.id }, data: { quantity: 2 } });
      await expect(check()).resolves.toEqual({ kind: "held", reason: "retry-outbound-usage-mismatch" });
      await f.db.usageEvent.update({ where: { id: usage.id }, data: { quantity: 1 } });
      await f.db.shopSettings.update({ where: { shopId: f.shopId }, data: { followUpEnabled: false, followUpDelayMinutes: null } });
      await expect(check()).resolves.toEqual({ kind: "held", reason: "follow-up-disabled" });
      await f.db.shopSettings.update({ where: { shopId: f.shopId }, data: { followUpEnabled: true, followUpDelayMinutes: 30 } });
      // A second bound message is never a new opener; the prepared original is held too.
      const other = await f.db.conversationMessage.create({ data: { conversationId: conversation.id, direction: "OUTBOUND",
        senderType: "AUTOMATION", status: "PENDING", allowanceBlockId: funding.blockId, content } });
      await expect(check()).resolves.toEqual({ kind: "held", reason: "funded-allowance" });
      await f.db.conversationMessage.delete({ where: { id: other.id } });
      const ready = await check();
      expect(ready.kind).toBe("ready");
      if (ready.kind !== "ready") throw new Error(`Permit held: ${ready.reason}`);
      // Persisted permit evidence is not a send outcome. No replay through the
      // readiness check or legacy repair can release or activate this block.
      await f.db.conversationMessage.update({ where: { id: prepared.id }, data: {
        providerDispatchKey: followUpRetryDispatchKey(funding.attemptId), providerDispatchAdmittedAt: due,
        providerDispatchControlRevision: conversation.controlRevision,
        dispatchProviderAccountId: ready.sender.providerAccountId, dispatchProviderPhoneNumberId: ready.sender.providerPhoneNumberId,
      } });
      await expect(check()).resolves.toEqual({ kind: "held", reason: "retry-prepared-message-mismatch" });
      await allowance.reconcileConversation(conversation.id);
      expect(await f.db.conversationAllowanceBlock.findUniqueOrThrow({ where: { id: funding.blockId } })).toEqual(originalBlock);
      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: funding.reservationId } })).toEqual(originalReservation);
    } finally { await f.close(); }
  }, 60_000);
});
