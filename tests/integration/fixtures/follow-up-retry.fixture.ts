import { randomUUID } from "node:crypto";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { expect } from "vitest";
import { adoptInitial } from "../../../src/services/recovery-allowance/storage.js";
import { lockRecoveryContext } from "../../../src/services/recovery-conversation/recovery-conversation.sql.js";
import { RecoveryDeliveryCompensationService } from "../../../src/services/recovery-delivery-compensation/reconcile.service.js";
import { FreeRecoveryReservationService } from "../../../src/services/free-recovery-reservation.service.js";
import { createInitialOutreachCreditFixture } from "./arch056-initial-outreach-credit.fixture.js";

export async function prepareCompensatedFollowUp(source: "free" | "purchased", recipient = "15551234567") {
  // The fixture uses Shopify for free and WooCommerce for purchased initial
  // funding. Historical acceptance is seeded; no provider is called.
  const f = await createInitialOutreachCreditFixture({ source, recipient, sentAgeMs: 60 * 60_000 });
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
      trigger: "NO_RESPONSE_FOLLOW_UP", status: "WAITING_FOR_RESPONSE", recipient, configuredOfferMode: "NONE",
      initiatedBy: "AUTOMATION", initiationKey: `scheduled-no-response:${f.recoveryId}`, claimedAt: sentAt,
      sentAt, outboundMessageId: message.id } });
    await f.db.usageEvent.create({ data: { shopId: f.shopId, metric: "OUTBOUND_AUTOMATED_MESSAGE", quantity: 1,
      provider: f.provider, idempotencyKey: `recovery-outreach:${attemptId}`, sourceType: "OUTBOUND_AUTOMATED_MESSAGE", sourceId: message.id } });
    await f.db.conversationMessage.update({ where: { id: message.id }, data: { status: "FAILED", failedAt, providerFailureCode: "131016" } });
    expect(await new RecoveryDeliveryCompensationService(f.db).reconcile(providerMessageId)).toBe("restored-spendable");
    const intent = await f.db.recoveryOutreachRetryIntent.findUniqueOrThrow({ where: { failedAttemptId: attemptId } });
    expect(intent).toMatchObject({ policy: "AFTER_COOLDOWN", fundingReservationId: reservation.id, failedMessageId: message.id });
    return { f, conversation, initial, attemptId, reservation, block, message, intent, failedAt, recipient };
  } catch (error) {
    await f.close();
    throw error;
  }
}

export async function registerHistoricalSender(f: Awaited<ReturnType<typeof prepareCompensatedFollowUp>>, identity?: { phone: string; account: string }) {
  const phone = identity?.phone ?? BigInt(`0x${randomUUID().replace(/-/g, "")}`).toString();
  const account = identity?.account ?? "918273645546372819";
  const recipient = f.recipient;
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
