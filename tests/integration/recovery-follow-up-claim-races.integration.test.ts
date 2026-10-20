import "dotenv/config";
import { describe, expect, it } from "vitest";
import { FollowUpClaimCancellationService } from
  "../../src/services/recovery-conversation/follow-up-claim-cancellation.service.js";
import type { RecoveryDatabase, SqlTransaction } from
  "../../src/services/recovery-conversation/recovery-conversation.sql.js";
import { humanDispatchFixture } from "./fixtures/recovery-human-dispatch.fixture.js";

const suite = process.env.TEST_DATABASE_URL && process.env.REDIS_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

suite("ARCH-040 BACKGROUND-007 follow-up cancellation concurrency proofs", () => {
  it("rolls back cancellation if the attempt-reset CAS changes zero rows", async () => {
    const f = await humanDispatchFixture("follow-up-reset-cas-rollback");
    try {
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand();
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      let simulatedCasMiss = 0;

      // Fault-inject only the compare-and-swap return value. All other SQL runs
      // inside the real PostgreSQL transaction, proving its earlier command
      // cancellation is rolled back when the reset fails.
      const database = {
        $queryRawUnsafe: f.db.$queryRawUnsafe.bind(f.db),
        $executeRawUnsafe: f.db.$executeRawUnsafe.bind(f.db),
        $transaction: (callback: (tx: SqlTransaction) => Promise<unknown>) =>
          f.db.$transaction(async (tx) => callback({
            $queryRawUnsafe: tx.$queryRawUnsafe.bind(tx),
            $executeRawUnsafe: (statement: string, ...parameters: unknown[]) => {
              if (statement.includes('SET "initiatedBy"=NULL')) {
                simulatedCasMiss++;
                return Promise.resolve(0);
              }
              return tx.$executeRawUnsafe(statement, ...parameters);
            },
          } as SqlTransaction)),
      } as unknown as RecoveryDatabase;

      await expect(new FollowUpClaimCancellationService(database, f.commands)
        .cancelClaimed(commandId, claim.leaseToken, "human_content_moderation_blocked"))
        .rejects.toThrow("Follow-up claim reset lost its owner");
      expect(simulatedCasMiss).toBe(1);
      expect(await f.commandState(commandId)).toEqual(expect.objectContaining({
        state: "CLAIMED", providerDispatchKey: null, outboundMessageId: null,
      }));
      expect((await f.db.merchantConversationSendCommand.findUniqueOrThrow({
        where: { id: commandId }, select: { leaseToken: true, failureCode: true },
      }))).toEqual({ leaseToken: claim.leaseToken, failureCode: null });
      expect(await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId },
        select: { initiatedBy: true, initiationKey: true, status: true },
      })).toEqual({ initiatedBy: "HUMAN", initiationKey: `merchant-${f.recoveryId}`, status: "PENDING" });
      expect(f.providerHttpRequests).toHaveLength(0);
      expect(await f.db.usageReservation.count({ where: { shopId: f.shopId } })).toBe(0);
      expect(await f.db.usageEvent.count({ where: { shopId: f.shopId } })).toBe(0);

      // A real retry can subsequently cancel and release exactly the same slot.
      expect(await f.cancellationService().cancelClaimed(commandId, claim.leaseToken,
        "human_content_moderation_blocked")).toBe("released");
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
        .initiationKey).toBeNull();
    } finally { await f.close(); }
  }, 60_000);

  it("serializes cancellation against a concurrent new HUMAN claim on the same attempt", async () => {
    const f = await humanDispatchFixture("cancel-new-human-race");
    try {
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand();
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const nextKey = `new-human-${f.recoveryId}`;
      const nextClaim = () => f.followUps.claimSequenceTwo({
        recoveryId: f.recoveryId, initiator: "merchant_post_window", expectedRevision: 1,
        initiationKey: nextKey, recipient: f.recipient, now: new Date(),
      });

      const [cancel, competingClaim] = await Promise.all([
        f.cancellationService().cancelClaimed(commandId, claim.leaseToken,
          "human_content_moderation_blocked"),
        nextClaim(),
      ]);
      expect(cancel).toBe("released");
      // If the new claimant reached the lock first, retry after cancellation.
      // It must never steal an uncleared claim; both schedules end in one owner.
      const winner = competingClaim.kind === "claimed" ? competingClaim : await nextClaim();
      if (competingClaim.kind !== "claimed") {
        expect(competingClaim).toEqual({ kind: "suppressed", reason: "already-claimed" });
      }
      expect(winner).toEqual({ kind: "claimed", attemptId,
        billingSource: `recovery-outreach:${attemptId}` });
      const newCommandId = await f.addCommand({
        kind: "RECOVERY_FOLLOW_UP_TEMPLATE", idempotencyKey: nextKey, attemptId,
      });
      expect(newCommandId).not.toBe(commandId);
      expect(await f.db.recoveryOutreachAttempt.count({
        where: { checkoutRecoveryId: f.recoveryId, sequence: 2 },
      })).toBe(1);
      expect(await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId },
        select: { initiatedBy: true, initiationKey: true, status: true },
      })).toEqual({ initiatedBy: "HUMAN", initiationKey: nextKey, status: "PENDING" });
      expect(await f.db.merchantConversationSendCommand.findUniqueOrThrow({ where: { id: commandId },
        select: { state: true, recoveryOutreachAttemptId: true, providerDispatchKey: true },
      })).toEqual({ state: "CANCELLED", recoveryOutreachAttemptId: attemptId, providerDispatchKey: null });
      expect(await f.cancellationService().cancelClaimed(commandId, claim.leaseToken,
        "human_content_moderation_blocked")).toBe("stale");
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
        .initiationKey).toBe(nextKey);
      expect(f.providerHttpRequests).toHaveLength(0);
    } finally { await f.close(); }
  }, 60_000);
});
