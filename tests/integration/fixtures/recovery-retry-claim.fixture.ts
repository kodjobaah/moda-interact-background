import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { InitialDeliveryRetryClaimService } from "../../../src/services/recovery-delivery-retry/claim.js";
import { RecoveryDeliveryCompensationService } from "../../../src/services/recovery-delivery-compensation/reconcile.service.js";
import type { RecoveryPolicySnapshot } from "../../../src/services/recovery-policy.service.js";
import { createInitialOutreachCreditFixture } from "./arch056-initial-outreach-credit.fixture.js";

export const policy: RecoveryPolicySnapshot = {
  recoveryDelayMinutes: 15,
  recoveryOfferMode: "NONE",
  fixedShopifyDiscountId: null,
  followUpEnabled: false,
  followUpDelayMinutes: null,
  source: "MERCHANT",
  offerSnapshot: null,
};
export type Fixture = Awaited<
  ReturnType<typeof createInitialOutreachCreditFixture>
>;

export async function failure(
  f: Fixture,
  code = "131016",
  fixtureSender?: { phone: string; account: string; recipient: string },
) {
  const conversation = await f.db.conversation.findUniqueOrThrow({
    where: { checkoutRecoveryId: f.recoveryId },
  });
  // Simulate an existing verified sender assignment and the exact immutable
  // provider stamps of its accepted message. No credentials or provider calls.
  const senderPhone =
    fixtureSender?.phone ??
    BigInt(`0x${randomUUID().replace(/-/g, "")}`).toString();
  const senderAccount = fixtureSender?.account ?? "918273645546372819";
  const recipient = fixtureSender?.recipient ?? "15551234567";
  if (fixtureSender)
    expect(
      await f.db.recoveryOutreachAttempt.findUniqueOrThrow({
        where: { id: f.attemptId },
      }),
    ).toMatchObject({ recipient });
  const sender = await f.db.whatsAppPoolSender.upsert({
    where: { providerPhoneNumberId: senderPhone },
    update: {},
    create: {
      providerPhoneNumberId: senderPhone,
      providerAccountId: senderAccount,
      verifiedAt: f.sentAt,
      allocationEnabled: false,
    },
  });
  expect(sender.providerAccountId).toBe(senderAccount);
  const thread = await f.db.recoverySenderThread.create({
    data: {
      canonicalRecipient: recipient,
      providerPhoneNumberId: sender.providerPhoneNumberId,
      openedAt: f.sentAt,
    },
  });
  const route = await f.db.recoverySenderRoute.create({
    data: {
      shopId: f.shopId,
      threadId: thread.id,
      canonicalRecipient: recipient,
      providerPhoneNumberId: sender.providerPhoneNumberId,
      openedAt: f.sentAt,
    },
  });
  await f.db.recoverySenderAssignment.create({
    data: {
      conversationId: conversation.id,
      routeId: route.id,
      assignedAt: f.sentAt,
    },
  });
  expect(
    await f.service.settleConfirmedInitialOutreach({
      shopId: f.shopId,
      recoveryId: f.recoveryId,
      outreachAttemptId: f.attemptId,
      outboundMessageId: f.messageId,
    }),
  ).toMatchObject({ kind: "settled" });
  await f.db.conversationMessage.update({
    where: { id: f.messageId },
    data: {
      dispatchProviderAccountId: senderAccount,
      dispatchProviderPhoneNumberId: senderPhone,
      status: "FAILED",
      providerFailureCode: code,
      failedAt: new Date(f.sentAt.getTime() + 1_000),
    },
  });
  expect(
    await new RecoveryDeliveryCompensationService(f.db).reconcile(
      f.providerMessageId,
    ),
  ).toBe("restored-spendable");
  const intent = await f.db.recoveryOutreachRetryIntent.findUniqueOrThrow({
    where: { failedAttemptId: f.attemptId },
  });
  const original = await f.db.recoveryOutreachAttempt.findUniqueOrThrow({
    where: { id: f.attemptId },
  });
  const reservation = await f.db.usageReservation.findUniqueOrThrow({
    where: { id: intent.fundingReservationId },
  });
  return {
    conversation,
    intent,
    original,
    reservation,
    claim: new InitialDeliveryRetryClaimService(f.db),
  };
}
