import type { PrismaClient } from "@prisma/client";
import prisma from "../lib/db.js";
import { canonicalizeRecoveryRecipient } from "./checkout-recovery/recovery-recipient-canonicalization.js";
import { recipientReachabilityStore, type RecipientReachabilityStore } from "./recipient-reachability-store.js";

export type ReachabilityPositiveOutcome = "recorded" | "unchanged" | "not-applicable";

type PositiveDatabase = Pick<PrismaClient, "conversationMessage">;

/** Only verified delivered/read message or persisted, singly routed inbound evidence. */
export class RecipientReachabilityPositiveService {
  constructor(
    private readonly database: PositiveDatabase = prisma,
    private readonly store: Pick<RecipientReachabilityStore, "recordSuccess"> = recipientReachabilityStore,
  ) {}

  async fromProviderDelivery(providerMessageId: string): Promise<ReachabilityPositiveOutcome> {
    const message = await this.database.conversationMessage.findUnique({
      where: { providerMessageId },
      select: {
        id: true, direction: true, status: true, senderType: true,
        deliveredAt: true, readAt: true, failedAt: true,
        conversation: { select: {
          shopId: true, checkoutRecovery: { select: { id: true, shopId: true } },
        } },
        recoveryOutreachAttempt: {
          select: { id: true, checkoutRecoveryId: true, recipient: true, outboundMessageId: true },
        },
        merchantSendCommand: { select: {
          shopId: true, kind: true, recoveryOutreachAttemptId: true,
          recoveryOutreachAttempt: {
            select: { id: true, checkoutRecoveryId: true, recipient: true, outboundMessageId: true },
          },
        } },
      },
    });
    if (!message || message.direction !== "OUTBOUND" ||
      !["DELIVERED", "READ"].includes(message.status)) return "not-applicable";

    const recovery = message.conversation.checkoutRecovery;
    const attempt = message.recoveryOutreachAttempt ?? message.merchantSendCommand?.recoveryOutreachAttempt;
    const shopId = recovery?.shopId;
    if (!shopId || !recovery || !attempt || attempt.checkoutRecoveryId !== recovery.id ||
      (attempt.outboundMessageId && attempt.outboundMessageId !== message.id) ||
      (message.conversation.shopId && message.conversation.shopId !== shopId) ||
      (message.merchantSendCommand && message.merchantSendCommand.shopId !== shopId) ||
      (message.senderType === "HUMAN" &&
        (!message.merchantSendCommand ||
         message.merchantSendCommand.kind !== "RECOVERY_FOLLOW_UP_TEMPLATE" ||
         message.merchantSendCommand.recoveryOutreachAttemptId !== attempt.id)) ||
      (message.senderType === "AUTOMATION" && message.merchantSendCommand) ||
      !["HUMAN", "AUTOMATION"].includes(message.senderType)) {
      return "not-applicable";
    }
    const recipient = canonicalizeRecoveryRecipient(attempt.recipient);
    if (!recipient || recipient !== attempt.recipient) return "not-applicable";
    const recordedSuccessAt = message.readAt ?? message.deliveredAt;
    if (!recordedSuccessAt) return "not-applicable";
    // Same-message DELIVERED/READ outranks its FAILED status even if the
    // provider timestamps were out of order. Never trump a newer OTHER failure.
    const successfulAt = message.failedAt && message.failedAt > recordedSuccessAt
      ? message.failedAt : recordedSuccessAt;
    return this.store.recordSuccess(shopId, recipient, successfulAt);
  }

  async fromRoutedInbound(input: {
    shopId: string; conversationId: string; providerMessageId: string;
    customerPhone: string;
  }): Promise<ReachabilityPositiveOutcome> {
    const recipient = canonicalizeRecoveryRecipient(input.customerPhone);
    if (!recipient) return "not-applicable";
    // Do not trust phone-only routing or an uncommitted inbound job as evidence.
    const inbound = await this.database.conversationMessage.findUnique({
      where: { providerMessageId: input.providerMessageId },
      select: {
        conversationId: true, direction: true, senderType: true, createdAt: true,
        conversation: { select: {
          shopId: true,
          checkoutRecovery: { select: { shopId: true } },
        } },
      },
    });
    if (!inbound || inbound.direction !== "INBOUND" || inbound.senderType !== "CUSTOMER" ||
      inbound.conversationId !== input.conversationId ||
      (inbound.conversation.checkoutRecovery?.shopId ?? inbound.conversation.shopId) !== input.shopId ||
      (inbound.conversation.shopId && inbound.conversation.shopId !== input.shopId)) {
      return "not-applicable";
    }
    return this.store.recordSuccess(input.shopId, recipient, inbound.createdAt);
  }
}

export const recipientReachabilityPositiveService = new RecipientReachabilityPositiveService();
