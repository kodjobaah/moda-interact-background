import type { PrismaClient } from "@prisma/client";
import type { WhatsAppInboundEvent } from "../../integration/whatsapp/types.js";
import {
  verifyInboundOwner,
  recipientDigits,
  type InboundOwnerEvidence,
} from "./inbound-authority.js";
import { recordProcessableInbound } from "../conversation-ai-delay/pending-turn-repository.js";
/** The provider identity, immutable owner and activity update commit together.
 * Unresolved input never enters this merchant transcript. No external I/O. */
export async function persistVerifiedInbound(
  db: PrismaClient,
  event: WhatsAppInboundEvent,
  evidence: InboundOwnerEvidence,
  mode: "active" | "historical",
) {
  if (
    event.providerAccountId !== evidence.providerAccountId ||
    event.providerPhoneNumberId !== evidence.providerPhoneNumberId ||
    recipientDigits(event.customerPhone) !== evidence.canonicalRecipient
  )
    throw new Error("INBOUND_EVENT_IDENTITY_MISMATCH");
  return db.$transaction(async (tx) => {
    await verifyInboundOwner(
      tx,
      evidence,
      event.providerMessageId,
      new Date(),
      mode === "active",
      new Date(event.occurredAt),
    );
    const existing = await tx.conversationMessage.findUnique({
      where: { providerMessageId: event.providerMessageId },
    });
    if (existing) {
      const c = await tx.conversation.findUniqueOrThrow({
        where: { id: evidence.conversationId },
        select: { inboundVersion: true },
      });
      return { message: existing, version: c.inboundVersion, duplicate: true };
    }
    const audio = event.content.type === "audio",
      content =
        event.content.type === "text"
          ? event.content.text
          : event.content.type === "unsupported"
            ? `[Unsupported WhatsApp content: ${event.content.providerType.slice(0, 64)}]`
            : "";
    if (mode === "active")
      await tx.$executeRawUnsafe(
        `UPDATE commerce."RecoveryOutreachAttempt" SET status='ENGAGED',"customerRespondedAt"=LEAST(COALESCE("customerRespondedAt",$2),$2) WHERE "checkoutRecoveryId"=$1 AND status IN('WAITING_FOR_RESPONSE','ENGAGED') AND "sentAt"<=$2`,
        evidence.checkoutRecoveryId,
        new Date(event.occurredAt),
      );
    const message = await tx.conversationMessage.create({
      data: {
        conversationId: evidence.conversationId,
        providerMessageId: event.providerMessageId,
        inReplyToProviderId: event.contextMessageId,
        direction: "INBOUND",
        senderType: "CUSTOMER",
        status: "DELIVERED",
        content,
        contentType: audio
          ? "AUDIO"
          : event.content.type === "unsupported"
            ? "UNSUPPORTED"
            : "TEXT",
        createdAt: new Date(event.occurredAt),
        dispatchProviderAccountId: evidence.providerAccountId,
        dispatchProviderPhoneNumberId: evidence.providerPhoneNumberId,
        ...(event.content.type === "audio"
          ? {
              providerMediaId: event.content.mediaId,
              providerMediaMimeType: event.content.mimeType,
              providerMediaSha256: event.content.sha256,
              transcriptionStatus: "PENDING" as const,
            }
          : {}),
      },
    });
    const c =
      mode === "active" && !audio
        ? await recordProcessableInbound(
            tx,
            evidence.conversationId,
            new Date(),
            { conversationAlreadyLocked: true },
          )
        : await tx.conversation
            .findUniqueOrThrow({
              where: { id: evidence.conversationId },
              select: { inboundVersion: true },
            })
            .then((x) => ({ version: x.inboundVersion }));
    if (mode === "active" && !audio)
      await tx.$executeRawUnsafe(
        `UPDATE whatsapp."Conversation" SET "lastInboundAt"=GREATEST("lastInboundAt",$2),"lastMessageAt"=GREATEST("lastMessageAt",$2) WHERE id=$1`,
        evidence.conversationId,
        new Date(),
      );
    return { message, version: c.version, duplicate: false };
  });
}
