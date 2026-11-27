import { randomUUID } from "node:crypto";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { describe, expect, it } from "vitest";
import { adoptInitial } from "../../src/services/recovery-allowance/storage.js";
import { lockRecoveryContext } from "../../src/services/recovery-conversation/recovery-conversation.sql.js";
import { RecoveryDeliveryCompensationService } from "../../src/services/recovery-delivery-compensation/reconcile.service.js";
import { inspectScheduledFollowUpRetryLineage } from "../../src/services/recovery-delivery-retry/follow-up-lineage.js";
import { FreeRecoveryReservationService } from "../../src/services/free-recovery-reservation.service.js";
import { createInitialOutreachCreditFixture } from "./fixtures/arch056-initial-outreach-credit.fixture.js";

const suite = process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

suite("Scheduled follow-up retry lineage (PostgreSQL)", () => {
  it.each(["free", "purchased"] as const)("proves the compensated follow-up on the %s initial-credit fixture without creating a successor", async source => {
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
