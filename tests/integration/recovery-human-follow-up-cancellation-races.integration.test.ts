import "dotenv/config";
import { describe, expect, it, vi } from "vitest";
import { FollowUpClaimCancellationService } from "../../src/services/recovery-conversation/follow-up-claim-cancellation.service.js";
import { OutboundSendFenceService } from "../../src/services/recovery-conversation/outbound-send-fence.service.js";
import { humanDispatchFixture } from "./fixtures/recovery-human-dispatch.fixture.js";

const suite = process.env.TEST_DATABASE_URL && process.env.REDIS_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

suite("ARCH-040 HUMAN follow-up cancellation race and permit irreversibility", () => {
  it("serializes HUMAN cancellation with a scheduled AUTOMATION claim", async () => {
    const f = await humanDispatchFixture("human-automation-race");
    try {
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand();
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      await f.changeOwner("HUMAN", "AI", 1);
      const [cancel, automation] = await Promise.all([
        f.cancellationService().cancelClaimed(commandId, claim.leaseToken,
          "human_content_moderation_blocked"),
        f.followUps.claimSequenceTwo({ recoveryId: f.recoveryId,
          initiator: "scheduled_no_response", initiationKey: "automated-follow-up",
          recipient: f.recipient, now: new Date(),
        }),
      ]);
      expect(cancel).toBe("released");
      if (automation.kind !== "claimed") {
        expect(automation).toEqual({ kind: "suppressed", reason: "already-claimed" });
        expect(await f.followUps.claimSequenceTwo({ recoveryId: f.recoveryId,
          initiator: "scheduled_no_response", initiationKey: "automated-follow-up",
          recipient: f.recipient, now: new Date(),
        })).toEqual({ kind: "claimed", attemptId, billingSource: `recovery-outreach:${attemptId}` });
      } else {
        expect(automation.attemptId).toBe(attemptId);
      }
      expect(await f.db.recoveryOutreachAttempt.count({
        where: { checkoutRecoveryId: f.recoveryId, sequence: 2 },
      })).toBe(1);
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
        .initiationKey).toBe("automated-follow-up");
      expect(f.providerHttpRequests).toHaveLength(0);
    } finally { await f.close(); }
  }, 60_000);

  it("preserves the claim if the current worker lease expires before cancellation", async () => {
    const f = await humanDispatchFixture("cancel-lease-expiry");
    try {
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand();
      // The ARCH-040 database guard deliberately forbids shortening an active
      // CLAIMED lease with UPDATE. Let the shortest supported real lease expire
      // and use PostgreSQL's clock, which also governs the cancellation CAS.
      const claim = (await f.commands.claimDueHumanCommands({
        limit: 1, now: new Date(), leaseMs: 5_000,
      }))[0]!;
      await vi.waitFor(async () => {
        const [lease] = await f.db.$queryRawUnsafe<Array<{ expired: boolean }>>(`
          SELECT ("leaseExpiresAt" <= statement_timestamp()) AS "expired"
          FROM "whatsapp"."MerchantConversationSendCommand" WHERE "id"=$1`, commandId);
        expect(lease?.expired).toBe(true);
      }, { timeout: 12_000, interval: 100 });

      // Reclaim first so cancellation cannot race the SKIP LOCKED claim query.
      // Use PostgreSQL's clock for its due-time cutoff, matching the expiry CAS.
      const [databaseClock] = await f.db.$queryRawUnsafe<Array<{ now: Date }>>(
        `SELECT statement_timestamp() AS "now"`,
      );
      // A second worker may reclaim only after expiry; an old worker must
      // never cancel that new lease or release the HUMAN sequence-two claim.
      expect(databaseClock).toBeDefined();
      const successors = await f.commands.claimDueHumanCommands({
        limit: 1, now: databaseClock!.now,
      });
      expect(successors).toHaveLength(1);
      expect(successors[0]?.id).toBe(commandId);
      expect(successors[0]?.leaseToken).not.toBe(claim.leaseToken);
      const cancel = await f.cancellationService().cancelClaimed(
        commandId, claim.leaseToken, "human_content_moderation_blocked",
      );
      expect(cancel).toBe("stale");
      expect((await f.commandState(commandId))?.state).toBe("CLAIMED");
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
        .initiationKey).toBe(`merchant-${f.recoveryId}`);
      expect(f.releaseExistingCredit).not.toHaveBeenCalled();
      expect(f.providerHttpRequests).toHaveLength(0);
    } finally { await f.close(); }
  }, 60_000);

  it("serializes final provider admission against cancellation of the same command", async () => {
    const f = await humanDispatchFixture("provider-permit-cancel-race");
    try {
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand();
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const [cancel, permit] = await Promise.all([
        f.cancellationService().cancelClaimed(commandId, claim.leaseToken,
          "human_content_moderation_blocked"),
        new OutboundSendFenceService(f.db, f.durableEligibility).admitFinalSend({
          senderType: "HUMAN", conversationId: f.conversationId, shopId: f.shopId,
          recoveryId: f.recoveryId, expectedControlRevision: 1, commandId,
          leaseToken: claim.leaseToken, recipient: f.recipient, now: new Date(),
          proactive: { consent: null, verifiedCategory: "MARKETING",
            templateName: "recovery_follow_up", languageCode: "en_US" },
        }),
      ]);
      const attempt = await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      if (permit.kind === "admitted") {
        expect(cancel).toBe("stale");
        expect(attempt.initiationKey).toBe(`merchant-${f.recoveryId}`);
      } else {
        expect(cancel).toBe("released");
        expect(attempt.initiationKey).toBeNull();
      }
      expect(f.providerHttpRequests).toHaveLength(0);
    } finally { await f.close(); }
  }, 60_000);

  it("refuses any release after the durable provider permit", async () => {
    const f = await humanDispatchFixture("permit-irreversible");
    try {
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand();
      const lease = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const permit = await new OutboundSendFenceService(f.db, f.durableEligibility).admitFinalSend({
        senderType: "HUMAN", conversationId: f.conversationId, shopId: f.shopId,
        recoveryId: f.recoveryId, expectedControlRevision: 1, commandId, leaseToken: lease.leaseToken,
        recipient: f.recipient, now: new Date(),
        // Provider-verified category is mandatory for a recovery template.
        // These lock/CAS tests stub durable eligibility; dedicated ARCH-045
        // coverage exercises authoritative consent and category verification.
        proactive: { consent: null, verifiedCategory: "MARKETING",
          templateName: "recovery_follow_up", languageCode: "en_US" },
      });
      expect(permit.kind).toBe("admitted");
      const service = new FollowUpClaimCancellationService(f.db, f.commands);
      expect(await service.cancelClaimed(commandId, lease.leaseToken, "human_moderation_review_required"))
        .toBe("stale");
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
        .initiationKey).toBe(`merchant-${f.recoveryId}`);
      expect(await service.repairCancelledClaims()).toBe(0);
    } finally { await f.close(); }
  }, 60_000);
});
