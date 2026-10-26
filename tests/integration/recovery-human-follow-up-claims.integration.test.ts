import "dotenv/config";
import { describe, expect, it } from "vitest";
import { allowModerationFixture } from "./fixtures/arch040-allow-moderation.fixture.js";
import { FollowUpClaimCancellationService } from "../../src/services/recovery-conversation/follow-up-claim-cancellation.service.js";
import { humanDispatchFixture } from "./fixtures/recovery-human-dispatch.fixture.js";

const suite = process.env.TEST_DATABASE_URL && process.env.REDIS_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

suite("ARCH-040 HUMAN follow-up claims and moderation", () => {
  it("lets only the eligible HUMAN path claim the shared sequence-two attempt", async () => {
    const f = await humanDispatchFixture("sequence-two-claim-race");
    try {
      await f.addInitialOutreach();
      const [scheduled, merchant] = await Promise.all([
        f.followUps.claimSequenceTwo({
          recoveryId: f.recoveryId, initiator: "scheduled_no_response",
          initiationKey: `scheduled-${f.recoveryId}`, recipient: f.recipient, now: new Date(),
        }),
        f.followUps.claimSequenceTwo({
          recoveryId: f.recoveryId, initiator: "merchant_post_window",
          initiationKey: `merchant-${f.recoveryId}`, recipient: f.recipient,
          expectedRevision: 1, now: new Date(),
        }),
      ]);

      expect(merchant.kind).toBe("claimed");
      expect(scheduled).toEqual({ kind: "suppressed", reason: "human-controlled" });
      await expect(f.followUps.claimSequenceTwo({
        recoveryId: f.recoveryId, initiator: "merchant_post_window",
        initiationKey: `merchant-retry-${f.recoveryId}`, recipient: f.recipient,
        expectedRevision: 1, now: new Date(),
      })).resolves.toEqual({ kind: "suppressed", reason: "already-claimed" });
      expect(await f.db.recoveryOutreachAttempt.count({
        where: { checkoutRecoveryId: f.recoveryId, sequence: 2 },
      })).toBe(1);
      expect(await f.db.recoveryOutreachAttempt.findUnique({
        where: { checkoutRecoveryId_sequence: { checkoutRecoveryId: f.recoveryId, sequence: 2 } },
        select: { initiatedBy: true, initiationKey: true, status: true, outboundMessageId: true },
      })).toEqual(expect.objectContaining({
        initiatedBy: "HUMAN", initiationKey: `merchant-${f.recoveryId}`,
        status: "PENDING", outboundMessageId: null,
      }));

      const commandId = await f.addCommand({
        kind: "RECOVERY_FOLLOW_UP_TEMPLATE",
        idempotencyKey: `merchant-${f.recoveryId}`,
        attemptId: merchant.attemptId,
      });
      const dispatcher = f.dispatcher();
      await dispatcher.poll();
      await dispatcher.close();

      await f.whatsapp.waitForMessageCount(1);
      expect(f.providerHttpRequests).toEqual([{ type: "template" }]);
      expect(await f.commandState(commandId)).toEqual(expect.objectContaining({
        state: "SENT", dispatchAttemptCount: 1,
        outboundMessageId: expect.any(String), providerDispatchKey: expect.any(String),
      }));
      expect(await f.db.recoveryOutreachAttempt.count({
        where: { checkoutRecoveryId: f.recoveryId, sequence: 2 },
      })).toBe(1);
      expect(f.billing.admitAndRevalidate).toHaveBeenCalledTimes(1);
      expect(f.billing.onConfirmedProviderSend).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  }, 60_000);

  it.each(["block", "review_required"] as const)(
    "releases the same sequence-two attempt after HUMAN moderation %s, without billing or Meta",
    async (outcome) => {
      const f = await humanDispatchFixture(`moderation-reclaim-${outcome}`);
      try {
        const { commandId, attemptId } = await f.addMerchantFollowUpCommand();
        const moderation = allowModerationFixture();
        moderation.assessText = async () => ({
          kind: outcome, assessmentId: `denied-${outcome}`, reasonCode: "fixture_denial",
        });
        const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
        await f.dispatcher(undefined, moderation).processClaim(commandId, claim.leaseToken);

        expect(await f.commandState(commandId)).toEqual(expect.objectContaining({
          state: "CANCELLED", outboundMessageId: null, providerDispatchKey: null,
        }));
        expect(await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId },
          select: { initiatedBy: true, initiationKey: true, claimedAt: true, outboundMessageId: true },
        })).toEqual({ initiatedBy: null, initiationKey: null, claimedAt: null, outboundMessageId: null });
        expect(f.billing.admitAndRevalidate).not.toHaveBeenCalled();
        expect(f.billing.releaseBeforePermit).not.toHaveBeenCalled();
        expect(f.providerHttpRequests).toHaveLength(0);
        expect(await f.db.usageReservation.count({ where: { shopId: f.shopId } })).toBe(0);
        expect(await f.db.usageEvent.count({ where: { shopId: f.shopId } })).toBe(0);

        const correctedKey = `corrected-${f.recoveryId}`;
        expect(await f.followUps.claimSequenceTwo({
          recoveryId: f.recoveryId, initiator: "merchant_post_window", expectedRevision: 1,
          initiationKey: correctedKey, recipient: f.recipient, now: new Date(),
        })).toEqual({ kind: "claimed", attemptId, billingSource: `recovery-outreach:${attemptId}` });
        expect(await f.db.recoveryOutreachAttempt.count({
          where: { checkoutRecoveryId: f.recoveryId, sequence: 2 },
        })).toBe(1);
        expect((await f.db.merchantConversationSendCommand.findUniqueOrThrow({ where: { id: commandId } }))
          .idempotencyKey).toBe(`merchant-${f.recoveryId}`);
      } finally { await f.close(); }
    }, 60_000,
  );

  it("recovers cancelled-but-claimed follow-ups after a crash without resending", async () => {
    const f = await humanDispatchFixture("historical-cancel-reclaim");
    try {
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand();
      const lease = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      expect(await f.commands.rejectCommand(commandId, lease.leaseToken, "human_content_moderation_blocked"))
        .toBe(true); // Simulates a previous worker's cancellation before claim release.
      const a = new FollowUpClaimCancellationService(f.db, f.commands);
      const b = new FollowUpClaimCancellationService(f.db, f.commands);
      const results = await Promise.all([a.repairCancelledClaims(), b.repairCancelledClaims()]);
      expect(results.reduce((sum, value) => sum + value, 0)).toBe(1);
      expect(await a.repairCancelledClaims()).toBe(0);
      expect(await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId },
        select: { initiationKey: true, initiatedBy: true },
      })).toEqual({ initiationKey: null, initiatedBy: null });
      expect(f.billing.admitAndRevalidate).not.toHaveBeenCalled();
      expect(f.providerHttpRequests).toHaveLength(0);
    } finally { await f.close(); }
  }, 60_000);
});
