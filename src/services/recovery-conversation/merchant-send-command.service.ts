import { randomUUID } from "node:crypto";
import { HumanSendReconciliationService } from "./human-send-reconciliation.service.js";
import { first, rows, changed, recoveryDatabase, readRecoveryContext,
  type RecoveryDatabase } from "./recovery-conversation.sql.js";

export type HumanCommand = {
  id: string; idempotencyKey: string; shopId: string; conversationId: string;
  kind: "HUMAN_TEXT" | "RECOVERY_FOLLOW_UP_TEMPLATE";
  state: "ACCEPTED" | "CLAIMED" | "DISPATCH_ADMITTED" | "SENT" | "FAILED" | "CANCELLED" | "UNKNOWN";
  leaseToken: string | null; leaseExpiresAt: Date | null;
  expectedControlRevision: number; recipientSnapshot: string;
  textBody: string | null; templateName: string | null;
  templateLanguageCode: string | null; templateParameters: unknown;
  recoveryOutreachAttemptId: string | null; outboundMessageId: string | null;
  providerDispatchKey: string | null;
};
export type CommandDecision = { kind: "claimed"; command: HumanCommand }
  | { kind: "refused"; reason: "invalid-lease" | "shop-mismatch" | "not-recovery-linked" | "stale-control-revision" | "human-inactive" | "invalid-recipient" | "terminal-recovery" };

export class MerchantSendCommandService {
  constructor(private readonly database: RecoveryDatabase = recoveryDatabase) {}

  /** One SQL statement claims a bounded due batch using SKIP LOCKED; each gets a
   * unique unpredictable token. Admitted/unknown commands are never reclaimed.
   */
  async claimDueHumanCommands(input: { limit: number; now: Date; ownerToken?: string; leaseMs?: number }): Promise<Array<{ id: string; leaseToken: string }>> {
    const limit = Math.max(0, Math.min(100, Math.floor(input.limit)));
    if (!limit) return [];
    const leaseMs = Math.min(300_000, Math.max(5_000, input.leaseMs ?? 60_000));
    const claimed: Array<{ id: string; leaseToken: string }> = [];
    // Each row uses independent CAS/lease token; no HTTP or Redis here.
    await this.database.$transaction(async (tx) => {
      const due = await rows<{ id: string }>(tx, `
        SELECT "id" FROM "whatsapp"."MerchantConversationSendCommand"
        WHERE "providerDispatchKey" IS NULL AND (
          ("state" IN ('ACCEPTED','FAILED') AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= $1))
          OR ("state"='CLAIMED' AND "leaseExpiresAt" <= $1))
        ORDER BY "createdAt", "id" LIMIT $2 FOR UPDATE SKIP LOCKED`, input.now, limit);
      for (const row of due) {
        const leaseToken = `${input.ownerToken ? input.ownerToken.slice(0, 32) + ":" : ""}${randomUUID()}`;
        const next = await rows<{ id: string }>(tx, `
          UPDATE "whatsapp"."MerchantConversationSendCommand"
          SET "state"='CLAIMED', "leaseToken"=$2,
            "leaseExpiresAt"=$3, "dispatchAttemptCount"="dispatchAttemptCount"+1,
            "nextAttemptAt"=NULL, "failureCode"=NULL, "updatedAt"=statement_timestamp()
          WHERE "id"=$1 AND "providerDispatchKey" IS NULL RETURNING "id"`,
          row.id, leaseToken, new Date(input.now.getTime() + leaseMs));
        if (next.length) claimed.push({ id: row.id, leaseToken });
      }
    });
    return claimed;
  }

  async loadClaimedCommand(commandId: string, leaseToken: string, now = new Date()): Promise<CommandDecision> {
    const command = await first<HumanCommand>(this.database, `
      SELECT * FROM "whatsapp"."MerchantConversationSendCommand"
      WHERE "id"=$1 AND "state"='CLAIMED' AND "leaseToken"=$2
        AND "leaseExpiresAt">$3 AND "providerDispatchKey" IS NULL`, commandId, leaseToken, now);
    if (!command) return { kind: "refused", reason: "invalid-lease" };
    const context = await readRecoveryContext(this.database, command.conversationId);
    if (!context) return { kind: "refused", reason: "not-recovery-linked" };
    if (context.shopId !== command.shopId) return { kind: "refused", reason: "shop-mismatch" };
    if (context.mode !== "HUMAN") return { kind: "refused", reason: "human-inactive" };
    if (context.revision !== command.expectedControlRevision) return { kind: "refused", reason: "stale-control-revision" };
    if (!command.recipientSnapshot.trim()) return { kind: "refused", reason: "invalid-recipient" };
    if (["COMPLETED", "EXPIRED", "CANCELLED"].includes(context.recoveryStatus))
      return { kind: "refused", reason: "terminal-recovery" };
    return { kind: "claimed", command };
  }

  /** Idempotent lease-fenced state updates. Never demote a provider-admitted send. */
  private async endUnadmitted(input: { commandId: string; leaseToken: string; state: "FAILED" | "CANCELLED"; code: string; nextAttemptAt?: Date }): Promise<boolean> {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(input.code)) throw new Error("invalid bounded failure code");
    return (await changed(this.database, `
      UPDATE "whatsapp"."MerchantConversationSendCommand"
      SET "state"=$3::"whatsapp"."MerchantConversationSendState", "failureCode"=$4,
        "nextAttemptAt"=$5, "leaseToken"=NULL, "leaseExpiresAt"=NULL,
        "updatedAt"=statement_timestamp(), "completedAt"=CASE WHEN $3='CANCELLED' THEN statement_timestamp() ELSE NULL END
      WHERE "id"=$1 AND "leaseToken"=$2 AND "state"='CLAIMED'
        AND "leaseExpiresAt">statement_timestamp() AND "providerDispatchKey" IS NULL`,
      input.commandId, input.leaseToken, input.state, input.code, input.nextAttemptAt ?? null)) === 1;
  }
  rejectCommand(commandId: string, leaseToken: string, code: string): Promise<boolean> {
    return this.endUnadmitted({ commandId, leaseToken, state: "CANCELLED", code });
  }
  deferCommand(commandId: string, leaseToken: string, code: string, dueAt: Date): Promise<boolean> {
    return this.endUnadmitted({ commandId, leaseToken, state: "FAILED", code, nextAttemptAt: dueAt });
  }
  async completeCommand(input: {commandId: string; leaseToken: string; providerMessageId: string;
    providerVerified: boolean}): Promise<boolean> {
    // Completion requires a verified provider acknowledgement; a lease alone
    // must never manufacture SENT or a second provider request.
    const result = await new HumanSendReconciliationService(this.database)
      .recordProviderAccepted(input);
    return result.kind === "sent";
  }
}
