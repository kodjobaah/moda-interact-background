import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { hasLocalNoContact } from "../whatsapp-contact-opt-out/local-no-contact.js";

type GeneralSendDatabase = Pick<PrismaClient, "$transaction">;
export type GeneralSendPermit = { kind: "admitted" } |
  { kind: "suppressed"; reason: "shop-inactive" | "invalid-scope" | "local-no-contact" | "already-admitted-or-sent" };

/** Final, durable admission for prepared NON-recovery text and template sends.
 * The Shop row is the first lock, matching the STOP writer and recovery fence.
 * A STOP committed before this transaction acquires Shop prevents admission.
 * Admission commits before Meta I/O; a send admitted first may be in flight.
 */
export class GeneralOutboundSendFenceService {
  constructor(private readonly database: GeneralSendDatabase) {}

  async admitFinalSend(input: {
    shopId: string; conversationId: string; messageId: string; recipient: string;
  }): Promise<GeneralSendPermit> {
    return this.database.$transaction(async (tx): Promise<GeneralSendPermit> => {
      const shops = await tx.$queryRawUnsafe<Array<{ status: string }>>(`
        SELECT "status"::text FROM "commerce"."Shop"
        WHERE "id"=$1 FOR UPDATE`, input.shopId);
      if (shops[0]?.status !== "ACTIVE") return { kind: "suppressed", reason: "shop-inactive" };

      // Shop -> Conversation -> message is the common ordering contract. Do not
      // accidentally treat a recovery conversation as a general-send fallback.
      const conversations = await tx.$queryRawUnsafe<Array<{ controlRevision: number }>>(`
        SELECT "controlRevision" FROM "whatsapp"."Conversation"
        WHERE "id"=$1 AND "shopId"=$2 AND "checkoutRecoveryId" IS NULL
          AND "type" <> 'RECOVERY'
        FOR UPDATE`, input.conversationId, input.shopId);
      if (conversations.length !== 1) return { kind: "suppressed", reason: "invalid-scope" };

      const messages = await tx.$queryRawUnsafe<Array<{
        status: string; providerDispatchKey: string | null; providerDispatchAdmittedAt: Date | null;
      }>>(`
        SELECT "status"::text,"providerDispatchKey","providerDispatchAdmittedAt"
        FROM "whatsapp"."ConversationMessage"
        WHERE "id"=$1 AND "conversationId"=$2 AND "direction"='OUTBOUND'
          AND "senderType" IN ('AGENT','AUTOMATION')
        FOR UPDATE`, input.messageId, input.conversationId);
      if (!messages.length) return { kind: "suppressed", reason: "invalid-scope" };
      if (messages[0]!.status !== "PENDING" || messages[0]!.providerDispatchKey ||
          messages[0]!.providerDispatchAdmittedAt)
        return { kind: "suppressed", reason: "already-admitted-or-sent" };

      if (await hasLocalNoContact(tx, { shopId: input.shopId, recipient: input.recipient }))
        return { kind: "suppressed", reason: "local-no-contact" };

      // The message is admitted at most once, including across retries. Store
      // the permit before the provider call, never during external I/O.
      const dispatchKey = `arch045-general-${createHash("sha256").update(input.messageId).digest("hex")}`;
      const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(`
        UPDATE "whatsapp"."ConversationMessage"
        SET "providerDispatchKey"=$2,"providerDispatchAdmittedAt"=statement_timestamp(),
            "providerDispatchControlRevision"=$3
        WHERE "id"=$1 AND "conversationId"=$4 AND "direction"='OUTBOUND'
          AND "senderType" IN ('AGENT','AUTOMATION') AND "status"='PENDING'
          AND "providerDispatchKey" IS NULL AND "providerDispatchAdmittedAt" IS NULL
        RETURNING "id"`, input.messageId, dispatchKey,
        conversations[0]!.controlRevision, input.conversationId);
      return rows.length === 1 ? { kind: "admitted" } :
        { kind: "suppressed", reason: "already-admitted-or-sent" };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
}
