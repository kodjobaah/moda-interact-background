import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import prisma from "../../lib/db.js";
import { isRecoveryReservationRetryableConflict } from "../recovery-reservation/reservation-lifecycle.js";
import { classifyWhatsAppProviderFailure } from "../../domain/whatsapp-recipient-failure.js";
import { readExactAutomatedUsage, removeExactAutomatedUsage } from "./automated-usage.js";
import { compensateCommittedSource } from "./committed.js";
import { resolveExactRecoverySource } from "./lineage.js";
import { releaseReservedSource } from "./reserved.js";
import { requireLineage, type CompensationTransaction, type RecoveryDeliveryCompensationOutcome } from "./types.js";

export type { RecoveryDeliveryCompensationOutcome } from "./types.js";

/**
 * Correct a terminal failure using the durable provider-message identity. This
 * entrypoint intentionally owns no reachability writes or merchant messaging.
 */
export class RecoveryDeliveryCompensationService {
  constructor(
    private readonly database: Pick<PrismaClient, "$transaction"> = prisma,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reconcile(providerMessageId: string): Promise<RecoveryDeliveryCompensationOutcome> {
    return this.withRetry({ providerMessageId });
  }

  /** For a future confirmed synchronous failure without a Meta message ID. */
  async reconcileMessage(messageId: string): Promise<RecoveryDeliveryCompensationOutcome> {
    return this.withRetry({ messageId });
  }

  private async withRetry(identity: { providerMessageId: string } | { messageId: string }) {
    for (let retry = 0; retry < 3; retry += 1) {
      try {
        return await this.database.$transaction(
          (tx) => this.reconcileLocked(tx, identity),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (retry === 2 || !isRecoveryReservationRetryableConflict(error)) throw error;
      }
    }
    throw new Error("Recovery delivery compensation retry limit reached");
  }

  private async reconcileLocked(
    tx: CompensationTransaction,
    identity: { providerMessageId: string } | { messageId: string },
  ): Promise<RecoveryDeliveryCompensationOutcome> {
    // Serialize compensation against a late DELIVERED/READ provider-status update.
    const locked = "messageId" in identity
      ? await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "whatsapp"."ConversationMessage"
        WHERE "id"=${identity.messageId} FOR UPDATE`
      : await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "whatsapp"."ConversationMessage"
        WHERE "providerMessageId"=${identity.providerMessageId} FOR UPDATE`;
    if (!locked.length) return "not-terminal";
    const message = await tx.conversationMessage.findUnique({
      where: { id: locked[0]!.id },
      select: {
        id: true, conversationId: true, direction: true, senderType: true,
        status: true, providerFailureCode: true,
        conversation: {
          select: {
            shopId: true, checkoutRecovery: { select: { id: true, shopId: true } },
          },
        },
      },
    });
    if (!message || message.direction !== "OUTBOUND" || message.status !== "FAILED" ||
      classifyWhatsAppProviderFailure(message.providerFailureCode) !== "RECIPIENT_UNDELIVERABLE") {
      return "not-terminal";
    }
    const shopId = message.conversation.checkoutRecovery?.shopId ?? message.conversation.shopId;
    requireLineage(shopId && (!message.conversation.shopId ||
      message.conversation.shopId === shopId), "provider message has conflicting Shop ownership");
    const automatedUsage = await readExactAutomatedUsage(tx, shopId, message.id);
    const source = await resolveExactRecoverySource(tx, message, shopId, automatedUsage);
    let result: RecoveryDeliveryCompensationOutcome = "not-recovery";
    if (source) {
      switch (source.reservation.status) {
        case "RESERVED":
          requireLineage(!source.reservation.committedUsageEventId &&
            !source.reservation.compensationUsageEventId && !source.reservation.compensationReason,
            "reserved source has committed compensation evidence");
          result = await releaseReservedSource(tx, source);
          break;
        case "COMMITTED":
          result = await compensateCommittedSource(tx, source, this.now());
          break;
        case "RELEASED":
          requireLineage(!source.reservation.committedUsageEventId &&
            !source.reservation.compensationUsageEventId,
            "released source still has committed usage");
          result = "already-released";
          break;
        default:
          requireLineage(false, "ambiguous recovery reservation");
      }
    }
    await removeExactAutomatedUsage(tx, shopId, message.id, automatedUsage);
    return result;
  }
}

export const recoveryDeliveryCompensationService = new RecoveryDeliveryCompensationService();
