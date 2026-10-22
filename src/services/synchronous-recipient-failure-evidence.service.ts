import { MessageStatus, Prisma, UsageMetric, type PrismaClient } from "@prisma/client";
import prisma from "../lib/db.js";
import { canonicalizeRecoveryRecipient } from "./checkout-recovery/recovery-recipient-canonicalization.js";
import { isRetryableConflict } from "./whatsapp-provider-status-lifecycle.js";

/** One durable, identity-checked failure transition. Link the automated attempt
 * BEFORE accounting removes its outbound usage row: replay still has lineage.
 */
export class SynchronousRecipientFailureEvidenceService {
  constructor(private readonly database: Pick<PrismaClient, "$transaction"> = prisma) {}

  async record(messageId: string, recipient: string, failedAt: Date = new Date()): Promise<void> {
    for (let retry = 0; retry < 3; retry += 1) {
      try {
        await this.database.$transaction(async (tx) => {
          const message = await tx.conversationMessage.findUnique({
            where: { id: messageId },
            select: {
              status: true, direction: true, senderType: true, providerMessageId: true,
              providerFailureCode: true,
              conversation: { select: { shopId: true,
                checkoutRecovery: { select: { id: true, shopId: true } } } },
            },
          });
          if (!message || message.direction !== "OUTBOUND" || message.providerMessageId ||
              (message.status !== "PENDING" &&
               !(message.status === "FAILED" && message.providerFailureCode === "131026"))) {
            throw new Error("Synchronous failure lacks an unconfirmed outbound message");
          }
          const recovery = message.conversation.checkoutRecovery;
          const shopId = recovery?.shopId ?? message.conversation.shopId;
          if (!shopId || (message.conversation.shopId && message.conversation.shopId !== shopId)) {
            throw new Error("Synchronous failure lacks consistent Shop ownership");
          }

          if (message.senderType === "AUTOMATION" && recovery) {
            const usage = await tx.usageEvent.findMany({
              where: { sourceId: messageId, metric: UsageMetric.OUTBOUND_AUTOMATED_MESSAGE },
              select: { shopId: true, idempotencyKey: true }, take: 2,
            });
            if (usage.length > 1 || (usage[0] && usage[0].shopId !== shopId)) {
              throw new Error("Synchronous failure outbound usage ownership conflict");
            }
            const match = /^recovery-outreach:([A-Za-z0-9_-]+)$/.exec(usage[0]?.idempotencyKey ?? "");
            const byMessage = await tx.recoveryOutreachAttempt.findUnique({
              where: { outboundMessageId: messageId },
              select: { id: true, checkoutRecoveryId: true, recipient: true },
            });
            if (match || byMessage) {
              if (match && byMessage && match[1] !== byMessage.id) {
                throw new Error("Synchronous failure attempt identity conflict");
              }
              const attemptId = match?.[1] ?? byMessage!.id;
              const attempt = await tx.recoveryOutreachAttempt.findUnique({
                where: { id: attemptId },
                select: { checkoutRecoveryId: true, recipient: true, outboundMessageId: true },
              });
              if (!attempt || attempt.checkoutRecoveryId !== recovery.id ||
                  (attempt.outboundMessageId && attempt.outboundMessageId !== messageId) ||
                  canonicalizeRecoveryRecipient(recipient) !== attempt.recipient ||
                  (byMessage && byMessage.recipient !== attempt.recipient)) {
                throw new Error("Synchronous failure recovery recipient/attempt mismatch");
              }
              if (!attempt.outboundMessageId) {
                const linked = await tx.recoveryOutreachAttempt.updateMany({
                  where: { id: attemptId, checkoutRecoveryId: recovery.id,
                    outboundMessageId: null, status: { in: ["PENDING", "CAPACITY_BLOCKED"] } },
                  data: { outboundMessageId: messageId, status: "FAILED",
                    failureCode: "WHATSAPP_RECIPIENT_UNDELIVERABLE", closedAt: failedAt },
                });
                if (linked.count !== 1) throw new Error("Synchronous failure attempt link conflict");
              }
            }
          }
          const applied = await tx.conversationMessage.updateMany({
            where: { id: messageId, direction: "OUTBOUND", status: MessageStatus.PENDING,
              providerMessageId: null },
            data: { status: MessageStatus.FAILED, providerFailureCode: "131026", failedAt },
          });
          if (applied.count !== 1 &&
              !(message.status === "FAILED" && message.providerFailureCode === "131026")) {
            throw new Error("Synchronous rejection message transition conflict");
          }
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        return;
      } catch (error) {
        if (retry === 2 || !isRetryableConflict(error)) throw error;
      }
    }
  }
}

export const synchronousRecipientFailureEvidenceService = new SynchronousRecipientFailureEvidenceService();
