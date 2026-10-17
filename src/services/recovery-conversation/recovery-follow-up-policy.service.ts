import { randomUUID } from "node:crypto";
import { first, rows, changed, recoveryDatabase, readRecoveryContext, lockRecoveryContext,
  terminalRecovery, type RecoveryDatabase } from "./recovery-conversation.sql.js";

export const CUSTOMER_WINDOW_MS = 24 * 60 * 60 * 1000;
export type FollowUpClaim = { kind: "claimed"; attemptId: string; billingSource: string }
  | { kind: "suppressed"; reason: "not-recovery-linked" | "terminal-recovery" | "human-controlled" | "customer-window-open" | "customer-engaged" | "no-initial-outreach" | "already-claimed" | "recipient-mismatch" | "invalid-claim" | "human-inactive-or-stale" };
export type FollowUpInitiation = "scheduled_no_response" | "merchant_post_window";
export type FollowUpClaimInput = {
  recoveryId: string; initiationKey: string; recipient: string; now: Date;
} & (
  | { initiator: "merchant_post_window"; expectedRevision: number }
  | { initiator: "scheduled_no_response"; expectedRevision?: never }
);

export function customerWindow(lastVerifiedInbound: Date | null, now: Date) {
  const closesAt = lastVerifiedInbound ? new Date(lastVerifiedInbound.getTime() + CUSTOMER_WINDOW_MS) : null;
  return { open: closesAt !== null && now.getTime() < closesAt.getTime(), closesAt };
}

export class RecoveryFollowUpPolicyService {
  constructor(private readonly database: RecoveryDatabase = recoveryDatabase) {}

  async checkServiceWindow(conversationId: string, now = new Date()) {
    const context = await readRecoveryContext(this.database, conversationId);
    return context ? { kind: "known" as const, ...customerWindow(context.lastInboundAt, now) }
      : { kind: "not-recovery-linked" as const };
  }

  async validateHumanFollowUp(input: { conversationId: string; now: Date; expectedRevision: number }) {
    const context = await readRecoveryContext(this.database, input.conversationId);
    if (!context) return { kind: "suppressed", reason: "not-recovery-linked" } as const;
    if (context.mode !== "HUMAN" || context.revision !== input.expectedRevision)
      return { kind: "suppressed", reason: "human-inactive-or-stale" } as const;
    if (terminalRecovery(context.recoveryStatus)) return { kind: "suppressed", reason: "terminal-recovery" } as const;
    if (customerWindow(context.lastInboundAt, input.now).open)
      return { kind: "suppressed", reason: "customer-window-open" } as const;
    return { kind: "allowed" } as const;
  }

  /** Sequence 2 is the *only* recovery follow-up claim. Lock Shop and Conversation,
   * then claim the existing pending attempt or create once from initial snapshot.
   * Merchant claims require an expected HUMAN control revision under the same locks.
   * External checkout lock and RecoveryBillingService admission remain BG002's ports.
   */
  async claimSequenceTwo(input: FollowUpClaimInput): Promise<FollowUpClaim> {
    if (!input.initiationKey.trim() || input.initiationKey.length > 255 || !input.recipient.trim())
      return { kind: "suppressed", reason: "invalid-claim" };
    return this.database.$transaction(async (tx) => {
      const root = await first<{ conversationId: string }>(tx, `
        SELECT c."id" AS "conversationId" FROM "whatsapp"."Conversation" c
        WHERE c."checkoutRecoveryId"=$1 AND c."type"='RECOVERY'`, input.recoveryId);
      if (!root) return { kind: "suppressed", reason: "not-recovery-linked" } as const;
      const context = await lockRecoveryContext(tx, root.conversationId);
      if (!context || context.recoveryId !== input.recoveryId)
        return { kind: "suppressed", reason: "not-recovery-linked" } as const;
      if (terminalRecovery(context.recoveryStatus)) return { kind: "suppressed", reason: "terminal-recovery" } as const;
      // The claim consumes the one shared follow-up slot. Check HUMAN ownership
      // under the same Shop -> Conversation locks as the attempt mutation so a
      // stale merchant command cannot burn the slot while AI owns the chat.
      if (input.initiator === "merchant_post_window" &&
          (context.mode !== "HUMAN" || input.expectedRevision === undefined ||
           !Number.isSafeInteger(input.expectedRevision) || context.revision !== input.expectedRevision))
        return { kind: "suppressed", reason: "human-inactive-or-stale" } as const;
      if (input.initiator === "scheduled_no_response" && context.mode === "HUMAN")
        return { kind: "suppressed", reason: "human-controlled" } as const;
      if (input.initiator === "merchant_post_window" && customerWindow(context.lastInboundAt, input.now).open)
        return { kind: "suppressed", reason: "customer-window-open" } as const;
      const initial = await first<{ id: string; recipient: string; sentAt: Date | null; status: string }>(tx, `
        SELECT "id", "recipient", "sentAt", "status"::text FROM "commerce"."RecoveryOutreachAttempt"
        WHERE "checkoutRecoveryId"=$1 AND "sequence"=1 FOR UPDATE`, input.recoveryId);
      if (!initial?.sentAt) return { kind: "suppressed", reason: "no-initial-outreach" } as const;
      if (initial.recipient !== input.recipient) return { kind: "suppressed", reason: "recipient-mismatch" } as const;
      if (input.initiator === "scheduled_no_response") {
        const inbound = await first<{ id: string }>(tx, `
          SELECT "id" FROM "whatsapp"."ConversationMessage"
          WHERE "conversationId"=$1 AND "senderType"='CUSTOMER' AND "direction"='INBOUND'
            AND "createdAt">=$2 LIMIT 1`, context.id, initial.sentAt);
        if (inbound) return { kind: "suppressed", reason: "customer-engaged" } as const;
      }
      // Reuse existing attempt. A prior empty PENDING scheduled row can be won by HUMAN.
      await changed(tx, `
        INSERT INTO "commerce"."RecoveryOutreachAttempt"
          ("id","checkoutRecoveryId","recipient","sequence","trigger","status",
           "configuredOfferMode","fixedShopifyDiscountId","offerSnapshot","createdAt","updatedAt")
        SELECT $2, a."checkoutRecoveryId", a."recipient", 2,
          'NO_RESPONSE_FOLLOW_UP'::"commerce"."RecoveryOutreachTrigger",
          'PENDING'::"commerce"."RecoveryOutreachStatus",
          a."configuredOfferMode",a."fixedShopifyDiscountId",a."offerSnapshot",
          statement_timestamp(),statement_timestamp()
        FROM "commerce"."RecoveryOutreachAttempt" a WHERE a."id"=$3
        ON CONFLICT ("checkoutRecoveryId","sequence") DO NOTHING`,
        input.recoveryId, randomUUID(), initial.id);
      const attempt = await first<{ id: string; initiatedBy: string | null; initiationKey: string | null; status: string; outboundMessageId: string | null }>(tx, `
        SELECT "id", "initiatedBy"::text, "initiationKey", "status"::text, "outboundMessageId"
        FROM "commerce"."RecoveryOutreachAttempt"
        WHERE "checkoutRecoveryId"=$1 AND "sequence"=2 FOR UPDATE`, input.recoveryId);
      if (!attempt || attempt.initiationKey || attempt.status !== "PENDING" || attempt.outboundMessageId)
        return { kind: "suppressed", reason: "already-claimed" } as const;
      const updated = await rows<{ id: string }>(tx, `
        UPDATE "commerce"."RecoveryOutreachAttempt"
        SET "initiatedBy"=$2::"commerce"."RecoveryOutreachInitiator", "initiationKey"=$3,
          "claimedAt"=statement_timestamp(),
          "trigger"=$4::"commerce"."RecoveryOutreachTrigger", "updatedAt"=statement_timestamp()
        WHERE "id"=$1 AND "initiationKey" IS NULL AND "status"='PENDING'
          AND "outboundMessageId" IS NULL RETURNING "id"`,
        attempt.id, input.initiator === "merchant_post_window" ? "HUMAN" : "AUTOMATION",
        input.initiationKey,
        input.initiator === "merchant_post_window" ? "POST_WINDOW_FOLLOW_UP" : "NO_RESPONSE_FOLLOW_UP");
      if (!updated.length) return { kind: "suppressed", reason: "already-claimed" } as const;
      return { kind: "claimed", attemptId: attempt.id, billingSource: `recovery-outreach:${attempt.id}` } as const;
    });
  }
}
