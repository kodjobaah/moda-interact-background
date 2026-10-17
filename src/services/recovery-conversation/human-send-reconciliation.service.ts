import { first, rows, changed, recoveryDatabase, type RecoveryDatabase } from "./recovery-conversation.sql.js";

export type ProviderDisposition =
  | { kind: "sent"; messageId: string; providerMessageId: string }
  | { kind: "definitive-failure"; messageId: string; reason: string }
  | { kind: "unknown"; messageId: string }
  | { kind: "ignored"; reason: "not-admitted" | "stale-lease" | "already-settled" | "unverified-provider-outcome" };

export class HumanSendReconciliationService {
  constructor(private readonly database: RecoveryDatabase = recoveryDatabase) {}

  /** Only an admitted, one-way identity may become SENT; provider delivery
   * receipts (DELIVERED/READ) remain owned by WhatsAppProviderStatusService.
   * The caller must supply a real provider acknowledgement/verified receipt.
   */
  async recordProviderAccepted(input: {
    commandId: string; leaseToken?: string; providerMessageId: string;
    providerVerified: boolean;
  }): Promise<ProviderDisposition> {
    if (!input.providerVerified || !input.providerMessageId.trim())
      return { kind: "ignored", reason: "unverified-provider-outcome" };
    return this.database.$transaction(async (tx) => {
      const command = await first<{ state: string; leaseToken: string | null; outboundMessageId: string | null }>(tx, `
        SELECT "state"::text,"leaseToken","outboundMessageId"
        FROM "whatsapp"."MerchantConversationSendCommand" WHERE "id"=$1 FOR UPDATE`, input.commandId);
      if (!command?.outboundMessageId || !["DISPATCH_ADMITTED", "UNKNOWN", "SENT"].includes(command.state))
        return { kind: "ignored", reason: "not-admitted" } as const;
      if (input.leaseToken && command.leaseToken !== input.leaseToken && command.state === "DISPATCH_ADMITTED")
        return { kind: "ignored", reason: "stale-lease" } as const;
      const existing = await first<{ providerMessageId: string | null; status: string }>(tx, `
        SELECT "providerMessageId","status"::text FROM "whatsapp"."ConversationMessage"
        WHERE "id"=$1 FOR UPDATE`, command.outboundMessageId);
      if (!existing || (existing.providerMessageId && existing.providerMessageId !== input.providerMessageId))
        return { kind: "ignored", reason: "already-settled" } as const;
      if (command.state === "SENT") return { kind: "sent", messageId: command.outboundMessageId, providerMessageId: input.providerMessageId } as const;
      await changed(tx, `
        UPDATE "whatsapp"."ConversationMessage"
        SET "status"='SENT',"providerMessageId"=$2,"sentAt"=COALESCE("sentAt",statement_timestamp())
        WHERE "id"=$1 AND "status"='PENDING'`, command.outboundMessageId, input.providerMessageId);
      await changed(tx, `
        UPDATE "whatsapp"."MerchantConversationSendCommand"
        SET "state"='SENT',"leaseToken"=NULL,"leaseExpiresAt"=NULL,
          "completedAt"=statement_timestamp(),"updatedAt"=statement_timestamp()
        WHERE "id"=$1 AND "state" IN ('DISPATCH_ADMITTED','UNKNOWN')`, input.commandId);
      return { kind: "sent", messageId: command.outboundMessageId, providerMessageId: input.providerMessageId } as const;
    });
  }

  /** Confirmed permanent provider rejection, never a network timeout. The
   * recovery billing admission compensator remains an injected BG002 hook.
   */
  async recordDefinitiveFailure(input: {
    commandId: string; leaseToken?: string; reason: string;
    definitiveProviderEvidence: boolean;
  }): Promise<ProviderDisposition> {
    if (!input.definitiveProviderEvidence || !/^[a-z][a-z0-9_-]{0,63}$/.test(input.reason))
      return { kind: "ignored", reason: "unverified-provider-outcome" };
    return this.database.$transaction(async (tx) => {
      const command = await first<{ state: string; leaseToken: string | null; outboundMessageId: string | null }>(tx, `
        SELECT "state"::text,"leaseToken","outboundMessageId"
        FROM "whatsapp"."MerchantConversationSendCommand" WHERE "id"=$1 FOR UPDATE`, input.commandId);
      if (!command?.outboundMessageId || !["DISPATCH_ADMITTED", "UNKNOWN"].includes(command.state))
        return { kind: "ignored", reason: "not-admitted" } as const;
      if (input.leaseToken && command.leaseToken !== input.leaseToken && command.state === "DISPATCH_ADMITTED")
        return { kind: "ignored", reason: "stale-lease" } as const;
      const recorded = await rows<{ id: string }>(tx, `
        UPDATE "whatsapp"."ConversationMessage"
        SET "status"='FAILED',"providerFailureCode"=$2,"failedAt"=statement_timestamp()
        WHERE "id"=$1 AND "status"='PENDING' AND "providerMessageId" IS NULL RETURNING "id"`,
        command.outboundMessageId, input.reason);
      if (!recorded.length) return { kind: "ignored", reason: "already-settled" } as const;
      await changed(tx, `
        UPDATE "whatsapp"."MerchantConversationSendCommand"
        SET "state"='FAILED',"failureCode"=$2,"leaseToken"=NULL,"leaseExpiresAt"=NULL,
          "completedAt"=statement_timestamp(),"updatedAt"=statement_timestamp()
        WHERE "id"=$1 AND "state" IN ('DISPATCH_ADMITTED','UNKNOWN')`, input.commandId, input.reason);
      return { kind: "definitive-failure", messageId: command.outboundMessageId, reason: input.reason } as const;
    });
  }

  async recordProviderUnknown(input: { commandId: string; leaseToken: string }): Promise<ProviderDisposition> {
    return this.database.$transaction(async (tx) => {
      const rowsUpdated = await rows<{ outboundMessageId: string }>(tx, `
        UPDATE "whatsapp"."MerchantConversationSendCommand"
        SET "state"='UNKNOWN',"leaseToken"=NULL,"leaseExpiresAt"=NULL,
          "failureCode"='provider_unknown',"updatedAt"=statement_timestamp()
        WHERE "id"=$1 AND "leaseToken"=$2 AND "state"='DISPATCH_ADMITTED'
          AND "providerDispatchKey" IS NOT NULL
        RETURNING "outboundMessageId"`, input.commandId, input.leaseToken);
      return rowsUpdated[0]?.outboundMessageId
        ? { kind: "unknown", messageId: rowsUpdated[0].outboundMessageId } as const
        : { kind: "ignored", reason: "stale-lease" } as const;
    });
  }

  async reconcileUnknown(input: {
    commandId: string;
    outcome: { kind: "accepted"; providerMessageId: string } | { kind: "definitive-failure"; reason: string };
    verified: boolean;
  }): Promise<ProviderDisposition> {
    if (!input.verified) return { kind: "ignored", reason: "unverified-provider-outcome" };
    const command = await first<{ state: string }>(this.database, `
      SELECT "state"::text FROM "whatsapp"."MerchantConversationSendCommand" WHERE "id"=$1`, input.commandId);
    if (command?.state !== "UNKNOWN") return { kind: "ignored", reason: "not-admitted" };
    return input.outcome.kind === "accepted"
      ? this.recordProviderAccepted({ commandId: input.commandId, providerMessageId: input.outcome.providerMessageId, providerVerified: true })
      : this.recordDefinitiveFailure({ commandId: input.commandId, reason: input.outcome.reason, definitiveProviderEvidence: true });
  }
}
