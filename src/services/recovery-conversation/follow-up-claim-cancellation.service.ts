import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { MerchantSendCommandService } from "./merchant-send-command.service.js";
import {
  changed, first, lockRecoveryContext, recoveryDatabase, rows,
  type RecoveryDatabase, type SqlTransaction,
} from "./recovery-conversation.sql.js";

/** The dispatcher needs only these two operations. No billing mutations occur here:
 * moderation is evaluated before a follow-up credit is admitted.
 */
export interface FollowUpClaimCancellation {
  cancelClaimed(commandId: string, leaseToken: string, failureCode: string): Promise<CancellationResult>;
  repairCancelledClaims(limit?: number): Promise<number>;
}

export type CancellationResult = "not-follow-up" | "stale" | "released" | "held";

type CommandPointer = { conversationId: string; shopId: string; kind: string };
type LockedCommand = {
  id: string; shopId: string; conversationId: string; kind: string;
  state: string; idempotencyKey: string; leaseToken: string | null; leaseValid: boolean;
  recoveryOutreachAttemptId: string | null; providerDispatchKey: string | null;
  providerDispatchAdmittedAt: Date | null; outboundMessageId: string | null;
};
type LockedAttempt = {
  id: string; initiatedBy: string | null; initiationKey: string | null;
  status: string; outboundMessageId: string | null; sentAt: Date | null;
};

/** Application-owned cancellation of a HUMAN sequence-two claim. The accepted
 * DATABASE-006 guard permits a reset but does not decide who may perform it.
 * A single short transaction serializes with claimSequenceTwo/admitFinalSend by
 * locking Shop -> Conversation -> Command -> Attempt. Neither Meta nor Redis is
 * contacted, and there is deliberately no second credit ledger.
 */
export class FollowUpClaimCancellationService implements FollowUpClaimCancellation {
  constructor(
    private readonly database: RecoveryDatabase = recoveryDatabase,
    private readonly commands: Pick<MerchantSendCommandService, "rejectCommand"> =
      new MerchantSendCommandService(database),
  ) {}

  async cancelClaimed(commandId: string, leaseToken: string, failureCode: string): Promise<CancellationResult> {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(failureCode)) throw new Error("invalid bounded failure code");
    const pointer = await this.pointer(commandId);
    if (!pointer || pointer.kind !== "RECOVERY_FOLLOW_UP_TEMPLATE") return "not-follow-up";
    const result = await this.database.$transaction((tx) =>
      this.transition(tx, commandId, pointer, { kind: "claimed", leaseToken, failureCode }));
    if (result === "no-context") {
      // Invalid recovery linkage cannot authorise an attempt reset. Still fence
      // the original command using the existing lease-protected cancellation.
      await this.commands.rejectCommand(commandId, leaseToken, failureCode);
      return "held";
    }
    return result;
  }

  /** A bounded, read-only discovery of terminal commands stranded by a crash
   * between cancellation and claim reset. Never leases or resends these rows.
   */
  async repairCancelledClaims(limit = 25): Promise<number> {
    const boundedLimit = Math.max(0, Math.min(25, Math.floor(limit)));
    if (!boundedLimit) return 0;
    const pending = await rows<{ id: string; conversationId: string; shopId: string; kind: string }>(this.database, `
      SELECT cmd."id",cmd."conversationId",cmd."shopId",cmd."kind"::text
      FROM "whatsapp"."MerchantConversationSendCommand" cmd
      JOIN "commerce"."RecoveryOutreachAttempt" attempt ON attempt."id"=cmd."recoveryOutreachAttemptId"
      WHERE cmd."state"='CANCELLED' AND cmd."kind"='RECOVERY_FOLLOW_UP_TEMPLATE'
        AND cmd."providerDispatchKey" IS NULL AND cmd."providerDispatchAdmittedAt" IS NULL
        AND cmd."outboundMessageId" IS NULL
        AND attempt."sequence"=2 AND attempt."status"='PENDING'
        AND attempt."initiatedBy"='HUMAN' AND attempt."initiationKey"=cmd."idempotencyKey"
        AND attempt."outboundMessageId" IS NULL AND attempt."sentAt" IS NULL
        AND (cmd."nextAttemptAt" IS NULL OR cmd."nextAttemptAt"<=statement_timestamp())
      ORDER BY cmd."createdAt",cmd."id" LIMIT $1`, boundedLimit);
    let repaired = 0;
    for (const candidate of pending) {
      const outcome = await this.database.$transaction((tx) =>
        this.transition(tx, candidate.id, candidate, { kind: "cancelled" }));
      if (outcome === "released") repaired++;
    }
    return repaired;
  }

  private async pointer(commandId: string): Promise<CommandPointer | null> {
    return first<CommandPointer>(this.database, `
      SELECT "conversationId","shopId","kind"::text
      FROM "whatsapp"."MerchantConversationSendCommand" WHERE "id"=$1`, commandId);
  }

  private async transition(
    tx: SqlTransaction,
    commandId: string,
    pointer: CommandPointer,
    mode: { kind: "claimed"; leaseToken: string; failureCode: string } | { kind: "cancelled" },
  ): Promise<CancellationResult | "no-context"> {
    const context = await lockRecoveryContext(tx, pointer.conversationId);
    if (!context || context.shopId !== pointer.shopId) return "no-context";
    const command = await first<LockedCommand>(tx, `
      SELECT "id","shopId","conversationId","kind"::text,"state"::text,
        "idempotencyKey","leaseToken",("leaseExpiresAt">statement_timestamp()) AS "leaseValid",
        "recoveryOutreachAttemptId","providerDispatchKey","providerDispatchAdmittedAt","outboundMessageId"
      FROM "whatsapp"."MerchantConversationSendCommand" WHERE "id"=$1 FOR UPDATE`, commandId);
    if (!command || command.kind !== "RECOVERY_FOLLOW_UP_TEMPLATE" ||
        command.shopId !== context.shopId || command.conversationId !== context.id ||
        command.providerDispatchKey || command.providerDispatchAdmittedAt || command.outboundMessageId ||
        (mode.kind === "claimed"
          ? command.state !== "CLAIMED" || command.leaseToken !== mode.leaseToken || !command.leaseValid
          : command.state !== "CANCELLED")) return "stale";

    const attempt = command.recoveryOutreachAttemptId
      ? await first<LockedAttempt>(tx, `
          SELECT "id","initiatedBy"::text,"initiationKey","status"::text,"outboundMessageId","sentAt"
          FROM "commerce"."RecoveryOutreachAttempt"
          WHERE "id"=$1 AND "checkoutRecoveryId"=$2 AND "sequence"=2 FOR UPDATE`,
          command.recoveryOutreachAttemptId, context.recoveryId)
      : null;
    const ownerMatches = !!attempt && attempt.status === "PENDING" &&
      attempt.initiatedBy === "HUMAN" && attempt.initiationKey === command.idempotencyKey &&
      !attempt.outboundMessageId && !attempt.sentAt;
    const safeToRelease = ownerMatches && attempt !== null &&
      !(await this.hasProviderEvidence(tx, attempt.id)) &&
      (await this.creditIsUnused(tx, context.shopId, attempt.id));

    if (mode.kind === "claimed") {
      const cancelled = await changed(tx, `
        UPDATE "whatsapp"."MerchantConversationSendCommand"
        SET "state"='CANCELLED',"failureCode"=$3,"nextAttemptAt"=NULL,
          "completedAt"=statement_timestamp(),"leaseToken"=NULL,"leaseExpiresAt"=NULL,
          "updatedAt"=statement_timestamp()
        WHERE "id"=$1 AND "leaseToken"=$2 AND "state"='CLAIMED'
          AND "leaseExpiresAt">statement_timestamp()
          AND "providerDispatchKey" IS NULL AND "providerDispatchAdmittedAt" IS NULL
          AND "outboundMessageId" IS NULL`, commandId, mode.leaseToken, mode.failureCode);
      if (cancelled !== 1) throw new Error("Follow-up cancellation lost its lease");
    }
    if (!safeToRelease || !attempt) {
      // A terminal command cannot be dispatched again. A pre-existing RESERVED,
      // COMMITTED or ambiguous credit is never discarded just to free a slot.
      // Defer repeated historical checks to keep the bounded scan moving.
      if (ownerMatches) await changed(tx, `
        UPDATE "whatsapp"."MerchantConversationSendCommand"
        SET "nextAttemptAt"=statement_timestamp()+interval '1 minute',"updatedAt"=statement_timestamp()
        WHERE "id"=$1 AND "state"='CANCELLED'`, commandId);
      return "held";
    }
    const released = await changed(tx, `
      UPDATE "commerce"."RecoveryOutreachAttempt"
      SET "initiatedBy"=NULL,"initiationKey"=NULL,"claimedAt"=NULL,
        "updatedAt"=statement_timestamp()
      WHERE "id"=$1 AND "checkoutRecoveryId"=$2 AND "sequence"=2
        AND "status"='PENDING' AND "initiatedBy"='HUMAN' AND "initiationKey"=$3
        AND "outboundMessageId" IS NULL AND "sentAt" IS NULL`,
      attempt.id, context.recoveryId, command.idempotencyKey);
    if (released !== 1) throw new Error("Follow-up claim reset lost its owner");
    return "released";
  }

  private async hasProviderEvidence(tx: SqlTransaction, attemptId: string): Promise<boolean> {
    return !!(await first<{ id: string }>(tx, `
      SELECT "id" FROM "whatsapp"."MerchantConversationSendCommand"
      WHERE "recoveryOutreachAttemptId"=$1
        AND ("providerDispatchKey" IS NOT NULL OR "providerDispatchAdmittedAt" IS NOT NULL
          OR "outboundMessageId" IS NOT NULL OR "state" IN ('DISPATCH_ADMITTED','SENT','UNKNOWN'))
      LIMIT 1`, attemptId));
  }

  private async creditIsUnused(tx: SqlTransaction, shopId: string, attemptId: string): Promise<boolean> {
    const sourceKey = createRecoveryIdempotencyKey(shopId, `recovery-outreach:${attemptId}`);
    const reservation = await first<{
      status: string; committedUsageEventId: string | null; compensationUsageEventId: string | null;
    }>(tx, `
      SELECT "status"::text,"committedUsageEventId","compensationUsageEventId"
      FROM "billing"."UsageReservation" WHERE "sourceKey"=$1`, sourceKey);
    if (reservation && (reservation.status !== "RELEASED" ||
      reservation.committedUsageEventId || reservation.compensationUsageEventId)) return false;
    const usage = await first<{ id: string }>(tx, `
      SELECT "id" FROM "billing"."UsageEvent" WHERE "idempotencyKey"=$1 LIMIT 1`,
      createRecoveryIdempotencyKey(shopId, sourceKey));
    return !usage;
  }
}
