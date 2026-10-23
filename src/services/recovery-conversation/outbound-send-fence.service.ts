import { createHash, randomUUID } from "node:crypto";
import { first, rows, changed, lockRecoveryContext, readRecoveryWindowEvidence, recoveryDatabase, terminalRecovery,
  type RecoveryContext, type RecoveryDatabase, type SqlTransaction } from "./recovery-conversation.sql.js";
import { customerWindow } from "./recovery-follow-up-policy.service.js";
import { hasLocalNoContact } from "../whatsapp-contact-opt-out/local-no-contact.js";

export type DispatchActor = "HUMAN" | "AGENT" | "AUTOMATION";
export type DispatchPermit = { kind: "admitted"; messageId: string; dispatchKey: string; admittedAt: Date }
  | { kind: "suppressed"; reason: string };
export type DispatchInput = {
  senderType: DispatchActor;
  conversationId: string; shopId: string; recoveryId: string;
  expectedControlRevision: number;
  commandId?: string; leaseToken?: string; messageId?: string;
  recipient: string; now: Date;
  /** Explicitly distinguish approved Meta templates from automated free text. */
  deliveryKind?: "TEXT" | "TEMPLATE";
};

/** BG002 injects synchronous, database-only checks for shop entitlement, recovery
 * capacity and billing admission. It MUST NOT perform HTTP/Redis/provider I/O.
 * Without the checker this service fails closed; preflight alone is insufficient.
 */
export type DurableEligibility = (tx: SqlTransaction, input: DispatchInput, context: RecoveryContext) =>
  Promise<null | string>;

export class OutboundSendFenceService {
  constructor(
    private readonly database: RecoveryDatabase = recoveryDatabase,
    private readonly durableEligibility?: DurableEligibility,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async admitProviderDispatch(input: DispatchInput): Promise<DispatchPermit> {
    return this.admitFinalSend(input);
  }

  async admitFinalSend(input: DispatchInput): Promise<DispatchPermit> {
    if (input.senderType === "HUMAN" && (!input.commandId || !input.leaseToken))
      return { kind: "suppressed", reason: "invalid-lease" };
    if (input.senderType !== "HUMAN" && !input.messageId)
      return { kind: "suppressed", reason: "missing-prepared-message" };
    const durableEligibility = this.durableEligibility;
    if (!durableEligibility) return { kind: "suppressed", reason: "durable-eligibility-unavailable" };
    return this.database.$transaction(async (tx) => {
      // Linearization point: the commit of this short transaction. Shop row
      // serializes initial restriction INSERT (restriction row may be absent).
      const context = await lockRecoveryContext(tx, input.conversationId);
      if (!context) return { kind: "suppressed", reason: "not-recovery-linked" } as const;
      // Sample after waiting for the Shop/Conversation lock, not when a queued
      // worker began preflight. An expired window cannot pass a delayed permit.
      const now = this.clock();
      if (!Number.isFinite(now.getTime())) return { kind: "suppressed", reason: "invalid-clock" } as const;
      if (context.shopId !== input.shopId || context.recoveryId !== input.recoveryId)
        return { kind: "suppressed", reason: "shop-mismatch" } as const;
      if (terminalRecovery(context.recoveryStatus))
        return { kind: "suppressed", reason: "terminal-recovery" } as const;
      if (context.revision !== input.expectedControlRevision)
        return { kind: "suppressed", reason: "stale-control-revision" } as const;
      if (context.mode !== (input.senderType === "HUMAN" ? "HUMAN" : "AI"))
        return { kind: "suppressed", reason: input.senderType === "HUMAN" ? "human-inactive" : "human-controlled" } as const;
      const shop = await first<{ status: string }>(tx,
        `SELECT "status"::text FROM "commerce"."Shop" WHERE "id"=$1`, context.shopId);
      if (shop?.status !== "ACTIVE") return { kind: "suppressed", reason: "shop-inactive" } as const;
      const restriction = await first<{ status: string; revision: number }>(tx, `
        SELECT "status"::text,"revision" FROM "commerce"."ShopHumanMessagingRestriction"
        WHERE "shopId"=$1`, context.shopId);
      if (input.senderType === "HUMAN" && restriction?.status === "SUSPENDED")
        return { kind: "suppressed", reason: "human_messaging_suspended" } as const;
      // STOP/merchant blocks apply to all outbound actors, even during the
      // customer-service window. Shop locking serialises this negative check
      // with committed STOP updates; no external I/O in the transaction.
      if (await hasLocalNoContact(tx, { shopId: context.shopId, recipient: input.recipient }))
        return { kind: "suppressed", reason: "local-no-contact" } as const;
      const recipient = await first<{ suppressUntil: Date | null }>(tx, `
        SELECT "suppressUntil" FROM "whatsapp"."WhatsAppRecipientReachability"
        WHERE "shopId"=$1 AND "recipient"=$2`, context.shopId, input.recipient);
      if (recipient?.suppressUntil && recipient.suppressUntil > now)
        return { kind: "suppressed", reason: "recipient-suppressed" } as const;
      let command: {
        state: string; leaseToken: string | null; leaseExpiresAt: Date | null;
        expectedControlRevision: number; kind: string; recipientSnapshot: string;
        textBody: string | null; templateName: string | null;
        idempotencyKey: string; recoveryOutreachAttemptId: string | null; providerDispatchKey: string | null;
      } | null = null;
      if (input.senderType === "HUMAN") {
        command = await first(tx, `
          SELECT "state"::text, "leaseToken", "leaseExpiresAt", "expectedControlRevision",
            "kind"::text, "recipientSnapshot", "textBody", "templateName",
            "idempotencyKey", "recoveryOutreachAttemptId", "providerDispatchKey"
          FROM "whatsapp"."MerchantConversationSendCommand"
          WHERE "id"=$1 AND "conversationId"=$2 AND "shopId"=$3 FOR UPDATE`,
          input.commandId, context.id, context.shopId);
        if (!command || command.state !== "CLAIMED" || command.leaseToken !== input.leaseToken ||
            !command.leaseExpiresAt || command.leaseExpiresAt <= now || command.providerDispatchKey)
          return { kind: "suppressed", reason: "invalid-lease" } as const;
        if (command.expectedControlRevision !== context.revision)
          return { kind: "suppressed", reason: "stale-control-revision" } as const;
        if (command.recipientSnapshot !== input.recipient)
          return { kind: "suppressed", reason: "recipient-mismatch" } as const;
        if (command.kind !== "HUMAN_TEXT" && command.kind !== "RECOVERY_FOLLOW_UP_TEMPLATE")
          return { kind: "suppressed", reason: "unsupported-human-command" } as const;
        if (command.kind === "RECOVERY_FOLLOW_UP_TEMPLATE") {
          const attempt = await first<{ initiatedBy: string | null; initiationKey: string | null;
            outboundMessageId: string | null; sentAt: Date | null; status: string }>(tx, `
            SELECT "initiatedBy"::text,"initiationKey","outboundMessageId","sentAt","status"::text
            FROM "commerce"."RecoveryOutreachAttempt"
            WHERE "id"=$1 AND "checkoutRecoveryId"=$2 AND "sequence"=2 FOR UPDATE`,
            command.recoveryOutreachAttemptId, context.recoveryId);
          if (!attempt || attempt.initiatedBy !== "HUMAN" ||
              attempt.initiationKey !== command.idempotencyKey ||
              attempt.outboundMessageId || attempt.sentAt || attempt.status !== "PENDING")
            return { kind: "suppressed", reason: "follow-up-already-used" } as const;
        }
      }
      const furtherDenial = await durableEligibility(tx, input, context);
      if (furtherDenial) return { kind: "suppressed", reason: furtherDenial } as const;

      // This is the last reversible policy decision before the irreversible
      // provider permit. Sample time after all potentially blocking row locks
      // and eligibility work; the queue's earlier input.now is only a hint.
      const permitNow = this.clock();
      if (!Number.isFinite(permitNow.getTime()))
        return { kind: "suppressed", reason: "invalid-clock" } as const;
      if (command?.leaseExpiresAt && command.leaseExpiresAt <= permitNow)
        return { kind: "suppressed", reason: "invalid-lease" } as const;
      const freeText = input.senderType === "AGENT" ||
        (input.senderType === "AUTOMATION" && input.deliveryKind !== "TEMPLATE") ||
        command?.kind === "HUMAN_TEXT";
      if (freeText || command?.kind === "RECOVERY_FOLLOW_UP_TEMPLATE") {
        const evidence = await readRecoveryWindowEvidence(tx, {
          recoveryId: context.recoveryId, conversationId: context.id, now: permitNow,
        });
        if (!evidence?.initialSentAt || evidence.initialSentAt > permitNow)
          return { kind: "suppressed", reason: "no-initial-outreach" } as const;
        const open = customerWindow(evidence.verifiedInboundAt, permitNow).open;
        if (freeText && !open)
          return { kind: "suppressed", reason: "customer-window-closed" } as const;
        if (command?.kind === "RECOVERY_FOLLOW_UP_TEMPLATE") {
          if (open) return { kind: "suppressed", reason: "customer-window-open" } as const;
          if (!evidence.followUpDueAt || evidence.followUpDueAt > permitNow)
            return { kind: "suppressed", reason: "follow-up-not-due" } as const;
          if (evidence.recipient !== input.recipient)
            return { kind: "suppressed", reason: "recipient-mismatch" } as const;
        }
      }

      const dispatchKey = input.senderType === "HUMAN"
        ? `arch040-human-${createHash("sha256").update(input.commandId!).digest("hex")}`
        : `arch040-auto-${createHash("sha256").update(input.messageId!).digest("hex")}`;
      const messageId = input.senderType === "HUMAN" ? randomUUID() : input.messageId!;
      if (input.senderType === "HUMAN") {
        // Exactly one canonical HUMAN message, at the durable admission point.
        // Provider HTTP MUST occur after commit and never inside this callback.
        const content = command!.kind === "HUMAN_TEXT"
          ? command!.textBody! : `[Recovery template: ${command!.templateName ?? "unknown"}]`;
        await changed(tx, `
          INSERT INTO "whatsapp"."ConversationMessage"
            ("id","conversationId","direction","senderType","status","content",
              "providerDispatchKey","providerDispatchAdmittedAt","providerDispatchControlRevision")
          VALUES ($1,$2,'OUTBOUND','HUMAN','PENDING',$3,$4,statement_timestamp(),$5)`,
          messageId, context.id, content, dispatchKey, context.revision);
        const cmd = await rows<{ providerDispatchAdmittedAt: Date }>(tx, `
          UPDATE "whatsapp"."MerchantConversationSendCommand"
          SET "state"='DISPATCH_ADMITTED',"outboundMessageId"=$3,
            "providerDispatchKey"=$4,"providerDispatchAdmittedAt"=statement_timestamp(),
            "providerDispatchControlRevision"=$5,
            "providerDispatchRestrictionRevision"=$6,"updatedAt"=statement_timestamp()
          WHERE "id"=$1 AND "leaseToken"=$2 AND "state"='CLAIMED'
          RETURNING "providerDispatchAdmittedAt"`,
          input.commandId, input.leaseToken, messageId, dispatchKey,
          context.revision, restriction?.revision ?? 0);
        if (!cmd.length) throw new Error("ARCH040 provider permit lost its lease");
        if (command!.recoveryOutreachAttemptId) {
          await rows(tx, `
            UPDATE "commerce"."RecoveryOutreachAttempt"
            SET "outboundMessageId"=$2,"updatedAt"=statement_timestamp()
            WHERE "id"=$1 AND "outboundMessageId" IS NULL`,
            command!.recoveryOutreachAttemptId, messageId);
        }
        return { kind: "admitted", messageId, dispatchKey, admittedAt: cmd[0]!.providerDispatchAdmittedAt } as const;
      }
      const message = await rows<{ providerDispatchAdmittedAt: Date }>(tx, `
        UPDATE "whatsapp"."ConversationMessage"
        SET "providerDispatchKey"=$2,"providerDispatchAdmittedAt"=statement_timestamp(),
          "providerDispatchControlRevision"=$3
        WHERE "id"=$1 AND "conversationId"=$4 AND "direction"='OUTBOUND'
          AND "senderType"=$5::"whatsapp"."MessageSenderType"
          AND "providerDispatchKey" IS NULL AND "status"='PENDING'
        RETURNING "providerDispatchAdmittedAt"`,
        messageId, dispatchKey, context.revision, context.id, input.senderType);
      if (!message.length) return { kind: "suppressed", reason: "already-admitted-or-sent" } as const;
      return { kind: "admitted", messageId, dispatchKey, admittedAt: message[0]!.providerDispatchAdmittedAt } as const;
    });
  }
}
