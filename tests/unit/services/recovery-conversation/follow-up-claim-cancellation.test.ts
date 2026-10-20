import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/lib/db.js", () => ({ default: {} }));
import { FollowUpClaimCancellationService } from
  "../../../../src/services/recovery-conversation/follow-up-claim-cancellation.service.js";
import type { RecoveryDatabase } from
  "../../../../src/services/recovery-conversation/recovery-conversation.sql.js";

/** Small SQL-port fake: exercises decisions and the lock/CAS order. Real row
 * constraints and concurrent transactions are covered by PostgreSQL tests.
 */
function fixture(options: { reservation?: "RESERVED" | "RELEASED"; providerEvidence?: boolean;
  leased?: boolean; owner?: string } = {}) {
  const ordered: string[] = [];
  const context = {
    id: "conversation", shopId: "shop", recoveryId: "recovery", checkoutToken: "checkout",
    recoveryStatus: "MESSAGE_SENT", mode: "HUMAN", revision: 1, lastInboundAt: null,
  };
  const cmd = {
    id: "command", shopId: "shop", conversationId: "conversation", kind: "RECOVERY_FOLLOW_UP_TEMPLATE",
    state: "CLAIMED", idempotencyKey: "original", leaseToken: "lease", leaseValid: options.leased !== false,
    recoveryOutreachAttemptId: "attempt", providerDispatchKey: null, providerDispatchAdmittedAt: null,
    outboundMessageId: null, failureCode: null as string | null,
  };
  const attempt: {
    id: string; initiatedBy: string | null; initiationKey: string | null;
    status: string; outboundMessageId: null; sentAt: null;
  } = {
    id: "attempt", initiatedBy: "HUMAN", initiationKey: options.owner ?? "original",
    status: "PENDING", outboundMessageId: null, sentAt: null,
  };
  const queries = vi.fn(async (statement: string) => {
    if (statement.includes('FROM "whatsapp"."Conversation" c')) return [context];
    if (statement.includes('FROM "commerce"."Shop" WHERE')) { ordered.push("shop"); return [{ id: "shop" }]; }
    if (statement.includes('FROM "whatsapp"."Conversation" WHERE')) { ordered.push("conversation"); return [{ id: "conversation" }]; }
    if (statement.includes('FROM "whatsapp"."MerchantConversationSendCommand" WHERE "id"=$1 FOR UPDATE')) {
      ordered.push("command"); return [cmd];
    }
    if (statement.includes('FROM "commerce"."RecoveryOutreachAttempt"') && statement.includes('FOR UPDATE')) {
      ordered.push("attempt"); return [attempt];
    }
    if (statement.includes('FROM "whatsapp"."MerchantConversationSendCommand" cmd')) {
      return cmd.state === "CANCELLED" && attempt.initiationKey === cmd.idempotencyKey
        ? [{ id: cmd.id, shopId: cmd.shopId, conversationId: cmd.conversationId, kind: cmd.kind }]
        : [];
    }
    if (statement.includes('FROM "whatsapp"."MerchantConversationSendCommand"') && statement.includes("providerDispatchKey")) {
      return options.providerEvidence ? [{ id: "older-admission" }] : [];
    }
    if (statement.includes('FROM "billing"."UsageReservation"')) {
      return options.reservation ? [{ status: options.reservation, committedUsageEventId: null,
        compensationUsageEventId: null }] : [];
    }
    if (statement.includes('FROM "billing"."UsageEvent"')) return [];
    if (statement.includes('FROM "whatsapp"."MerchantConversationSendCommand" WHERE "id"=$1')) return [cmd];
    throw new Error(`Unexpected SELECT in cancellation SQL: ${statement.slice(0, 90)}`);
  });
  const execute = vi.fn(async (statement: string, ...params: unknown[]) => {
    if (statement.includes('SET "state"=\'CANCELLED\'')) {
      if (cmd.state !== "CLAIMED" || cmd.leaseToken !== params[1] || !cmd.leaseValid) return 0;
      cmd.state = "CANCELLED"; cmd.failureCode = String(params[2]); cmd.leaseToken = "";
      return 1;
    }
    if (statement.includes('SET "initiatedBy"=NULL')) {
      if (attempt.initiationKey !== params[2]) return 0;
      attempt.initiationKey = null;
      attempt.initiatedBy = null;
      return 1;
    }
    if (statement.includes('SET "nextAttemptAt"=')) return 1;
    throw new Error(`Unexpected UPDATE in cancellation SQL: ${statement.slice(0, 90)}`);
  });
  const db: RecoveryDatabase = {
    $queryRawUnsafe: queries, $executeRawUnsafe: execute,
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(db),
  } as unknown as RecoveryDatabase;
  const fallback = { rejectCommand: vi.fn(async () => true) };
  return { cmd, attempt, ordered, queries, execute, fallback,
    service: new FollowUpClaimCancellationService(db, fallback) };
}

describe("ARCH-040-BACKGROUND-007 claim cancellation", () => {
  it("cancels the original command and resets the original attempt under canonical locks", async () => {
    const f = fixture();
    expect(await f.service.cancelClaimed("command", "lease", "human_content_moderation_blocked"))
      .toBe("released");
    expect(f.cmd.state).toBe("CANCELLED");
    expect(f.cmd.failureCode).toBe("human_content_moderation_blocked");
    expect(f.attempt.initiationKey).toBeNull();
    expect(f.attempt.initiatedBy).toBeNull();
    expect(f.ordered).toEqual(["shop", "conversation", "command", "attempt"]);
    expect(f.fallback.rejectCommand).not.toHaveBeenCalled();
  });

  it("cancels blocked content but keeps the claim when a credit is reserved", async () => {
    const f = fixture({ reservation: "RESERVED" });
    expect(await f.service.cancelClaimed("command", "lease", "human_moderation_review_required"))
      .toBe("held");
    expect(f.cmd.state).toBe("CANCELLED");
    expect(f.attempt.initiationKey).toBe("original");
    expect(f.execute.mock.calls.some(([sql]) => String(sql).includes('SET "initiatedBy"=NULL')))
      .toBe(false);
  });

  it("never changes a claim on expired leases, unrelated owners or provider evidence", async () => {
    for (const options of [{ leased: false }, { owner: "new-owner" }, { providerEvidence: true }]) {
      const f = fixture(options);
      const result = await f.service.cancelClaimed("command", "lease", "human_content_moderation_blocked");
      expect(result).not.toBe("released");
      expect(f.attempt.initiationKey).not.toBeNull();
    }
  });

  it("repairs cancelled-but-claimed rows idempotently without reclaiming a worker lease", async () => {
    const f = fixture();
    f.cmd.state = "CANCELLED";
    expect(await f.service.repairCancelledClaims()).toBe(1);
    expect(await f.service.repairCancelledClaims()).toBe(0);
    expect(f.attempt.initiationKey).toBeNull();
    expect(f.fallback.rejectCommand).not.toHaveBeenCalled();
  });
});
