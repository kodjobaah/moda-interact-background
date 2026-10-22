import type { PrismaClient } from "@prisma/client";
import prisma from "../lib/db.js";
import { classifyWhatsAppProviderFailure } from "../domain/whatsapp-recipient-failure.js";
import { canonicalizeRecoveryRecipient } from "./checkout-recovery/recovery-recipient-canonicalization.js";
import type { RecoveryDeliveryCompensationOutcome } from "./recovery-delivery-compensation/types.js";
import { recipientReachabilityStore, type RecipientReachabilityStore } from "./recipient-reachability-store.js";

export type ReachabilityFailureOutcome =
  | "not-applicable" | "deferred" | "suppressed" | "unchanged";
export type FailedMessageIdentity = { providerMessageId: string } | { messageId: string };

const CORRECTED: readonly RecoveryDeliveryCompensationOutcome[] = [
  "released", "already-released", "restored-spendable", "historical-only",
];

/** The compensation result is an explicit prerequisite, not inferred from FAILED. */
export class RecipientReachabilityFailureService {
  constructor(
    private readonly database: Pick<PrismaClient, "conversationMessage"> = prisma,
    private readonly store: Pick<RecipientReachabilityStore, "recordFailure"> = recipientReachabilityStore,
  ) {}

  async afterCorrection(
    identity: FailedMessageIdentity,
    correction: RecoveryDeliveryCompensationOutcome,
  ): Promise<ReachabilityFailureOutcome> {
    const message = await this.database.conversationMessage.findUnique({
      where: "messageId" in identity
        ? { id: identity.messageId }
        : { providerMessageId: identity.providerMessageId },
      select: {
        id: true, conversationId: true, direction: true, senderType: true,
        status: true, failedAt: true, providerFailureCode: true,
        conversation: {
          select: {
            shopId: true,
            checkoutRecovery: { select: { id: true, shopId: true } },
          },
        },
        recoveryOutreachAttempt: {
          select: { id: true, checkoutRecoveryId: true, outboundMessageId: true, recipient: true },
        },
        merchantSendCommand: {
          select: {
            shopId: true, conversationId: true, kind: true, recoveryOutreachAttemptId: true,
            recoveryOutreachAttempt: {
              select: { id: true, checkoutRecoveryId: true, outboundMessageId: true, recipient: true },
            },
          },
        },
      },
    });
    if (!message || message.direction !== "OUTBOUND" || message.status !== "FAILED" ||
      classifyWhatsAppProviderFailure(message.providerFailureCode) !== "RECIPIENT_UNDELIVERABLE") {
      return "not-applicable";
    }
    if (correction === "purchased-compensation-required") return "deferred";
    if (!CORRECTED.includes(correction)) return "not-applicable";

    const recovery = message.conversation.checkoutRecovery;
    const shopId = recovery?.shopId;
    const command = message.merchantSendCommand;
    const linkedAttempt = message.recoveryOutreachAttempt;
    const attempt = linkedAttempt ?? command?.recoveryOutreachAttempt;
    if (!shopId || !recovery || !attempt || !message.failedAt ||
      (message.conversation.shopId && message.conversation.shopId !== shopId) ||
      attempt.checkoutRecoveryId !== recovery.id ||
      (attempt.outboundMessageId && attempt.outboundMessageId !== message.id) ||
      (linkedAttempt && command?.recoveryOutreachAttemptId &&
        linkedAttempt.id !== command.recoveryOutreachAttemptId) ||
      (command && (command.shopId !== shopId || command.conversationId !== message.conversationId)) ||
      (message.senderType === "HUMAN" &&
        (!command || command.kind !== "RECOVERY_FOLLOW_UP_TEMPLATE" ||
         command.recoveryOutreachAttemptId !== attempt.id)) ||
      (message.senderType === "AUTOMATION" && command) ||
      !["HUMAN", "AUTOMATION"].includes(message.senderType)) {
      throw new Error("Corrected failure lacks exact recovery/attempt/Shop reachability lineage");
    }
    const recipient = canonicalizeRecoveryRecipient(attempt.recipient);
    if (!recipient || recipient !== attempt.recipient) {
      throw new Error("Corrected attempt has no canonical recipient snapshot");
    }
    const recorded = await this.store.recordFailure(shopId, recipient, message.failedAt, "131026");
    return recorded === "recorded" ? "suppressed" : "unchanged";
  }
}

export const recipientReachabilityFailureService = new RecipientReachabilityFailureService();
