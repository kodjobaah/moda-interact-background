import "dotenv/config";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { describe, expect, it } from "vitest";
import { allowModerationFixture } from "./fixtures/arch040-allow-moderation.fixture.js";
import { humanDispatchFixture } from "./fixtures/recovery-human-dispatch.fixture.js";

const suite = process.env.TEST_DATABASE_URL && process.env.REDIS_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

suite("ARCH-040 HUMAN follow-up credit release and repair", () => {
  it("releases reserved recovery credit when suspension wins after billing but before permit", async () => {
    const f = await humanDispatchFixture("suspension-after-credit");
    try {
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand();
      // Billing admission must have a real durable reservation. BG007, not the
      // dispatcher's mock billing port, owns its pre-provider release.
      const sourceKey = createRecoveryIdempotencyKey(f.shopId, `recovery-outreach:${attemptId}`);
      const counter = await f.db.shopEntitlementCounter.create({ data: {
        shopId: f.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS",
        grantedQuantity: 1, reservedQuantity: 1,
      } });
      await f.db.usageReservation.create({ data: {
        shopId: f.shopId, counterId: counter.id, sourceKey, quantity: 1, status: "RESERVED",
      } });
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      f.billing.admitAndRevalidate.mockImplementationOnce(async (input) => {
        await f.suspendShop();
        return { kind: "admitted", admission: { sourceKey: `recovery-outreach:${input.sequenceTwoAttemptId}` } } as const;
      });
      const service = f.dispatcher();
      await service.processClaim(commandId, claim.leaseToken);
      await service.close();
      expect(f.billing.admitAndRevalidate).toHaveBeenCalledTimes(1);
      expect(f.releaseExistingCredit).toHaveBeenCalledTimes(1);
      expect(f.billing.releaseBeforePermit).not.toHaveBeenCalled();
      expect((await f.db.usageReservation.findUniqueOrThrow({ where: { sourceKey } })).status)
        .toBe("RELEASED");
      expect((await f.db.shopEntitlementCounter.findUniqueOrThrow({ where: { id: counter.id } }))
        .reservedQuantity).toBe(0);
      expect(f.billing.onConfirmedProviderSend).not.toHaveBeenCalled();
      expect(f.billing.onDefinitiveProviderFailure).not.toHaveBeenCalled();
      expect(f.durableEligibility).not.toHaveBeenCalled();
      expect(f.provider.sendWhatsAppTemplate).not.toHaveBeenCalled();
      expect((await f.commandState(commandId))?.state).toBe("CANCELLED");
    } finally { await f.close(); }
  }, 60_000);

  it("releases a provisional credit after moderation rejection before resetting the same follow-up", async () => {
    const f = await humanDispatchFixture("reserved-credit-fail-closed");
    try {
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand();
      const sourceKey = createRecoveryIdempotencyKey(f.shopId, `recovery-outreach:${attemptId}`);
      // Reserved credit must name its capacity source. Match the live billing
      // constraint rather than inserting an impossible reservation row.
      const counter = await f.db.shopEntitlementCounter.create({ data: {
        shopId: f.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS",
        grantedQuantity: 1, reservedQuantity: 1,
      } });
      await f.db.usageReservation.create({ data: {
        shopId: f.shopId, counterId: counter.id, sourceKey, quantity: 1, status: "RESERVED",
      } });
      const moderation = allowModerationFixture();
      moderation.assessText = async () => ({
        kind: "block", assessmentId: "denied-existing-reservation", reasonCode: "fixture_denial",
      });
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      await f.dispatcher(undefined, moderation).processClaim(commandId, claim.leaseToken);
      expect((await f.commandState(commandId))?.state).toBe("CANCELLED");
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
        .initiationKey).toBeNull();
      expect((await f.db.usageReservation.findUniqueOrThrow({ where: { sourceKey } }))
        .status).toBe("RELEASED");
      expect(await f.db.shopEntitlementCounter.findUniqueOrThrow({ where: { id: counter.id } }))
        .toMatchObject({ grantedQuantity: 1, reservedQuantity: 0, committedQuantity: 0 });
      expect(f.releaseExistingCredit).toHaveBeenCalledTimes(1);
      expect(await f.db.usageEvent.count({ where: { shopId: f.shopId } })).toBe(0);
      expect(await f.followUps.claimSequenceTwo({
        recoveryId: f.recoveryId, initiator: "merchant_post_window", expectedRevision: 1,
        initiationKey: "second-command", recipient: f.recipient, now: new Date(),
      })).toEqual({ kind: "claimed", attemptId, billingSource: `recovery-outreach:${attemptId}` });
      expect(f.billing.admitAndRevalidate).not.toHaveBeenCalled();
      expect(f.providerHttpRequests).toHaveLength(0);
    } finally { await f.close(); }
  }, 60_000);

  it("keeps the claim and cancelled command when releasing a provisional credit fails", async () => {
    const f = await humanDispatchFixture("reserved-credit-release-failed");
    try {
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand();
      const sourceKey = createRecoveryIdempotencyKey(f.shopId, `recovery-outreach:${attemptId}`);
      const counter = await f.db.shopEntitlementCounter.create({ data: {
        shopId: f.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS",
        grantedQuantity: 1, reservedQuantity: 1,
      } });
      await f.db.usageReservation.create({ data: {
        shopId: f.shopId, counterId: counter.id, sourceKey, quantity: 1, status: "RESERVED",
      } });
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const failure = f.cancellationService(async () => { throw new Error("simulated release outage"); });
      expect(await failure.cancelClaimed(commandId, claim.leaseToken, "human_content_moderation_blocked"))
        .toBe("held");
      expect((await f.commandState(commandId))?.state).toBe("CANCELLED");
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
        .initiationKey).toBe(`merchant-${f.recoveryId}`);
      expect((await f.db.usageReservation.findUniqueOrThrow({ where: { sourceKey } })).status)
        .toBe("RESERVED");
      expect(f.providerHttpRequests).toHaveLength(0);
      // The next bounded repair poll uses the original command and credit.
      await f.db.merchantConversationSendCommand.update({ where: { id: commandId },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });
      expect(await f.cancellationService().repairCancelledClaims()).toBe(1);
      expect((await f.db.usageReservation.findUniqueOrThrow({ where: { sourceKey } })).status)
        .toBe("RELEASED");
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
        .initiationKey).toBeNull();
    } finally { await f.close(); }
  }, 60_000);

  it("repairs a crash after durable release but before attempt reset", async () => {
    const f = await humanDispatchFixture("released-before-claim-reset");
    try {
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand();
      const sourceKey = createRecoveryIdempotencyKey(f.shopId, `recovery-outreach:${attemptId}`);
      const counter = await f.db.shopEntitlementCounter.create({ data: {
        shopId: f.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS",
        grantedQuantity: 1, reservedQuantity: 1,
      } });
      await f.db.usageReservation.create({ data: {
        shopId: f.shopId, counterId: counter.id, sourceKey, quantity: 1, status: "RESERVED",
      } });
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const crashesAfterRelease = f.cancellationService(async (admission) => {
        await f.releaseExistingCredit(admission);
        throw new Error("simulated crash after durable release");
      });
      expect(await crashesAfterRelease.cancelClaimed(commandId, claim.leaseToken,
        "human_content_moderation_blocked")).toBe("held");
      expect((await f.commandState(commandId))?.state).toBe("CANCELLED");
      expect((await f.db.usageReservation.findUniqueOrThrow({ where: { sourceKey } })).status)
        .toBe("RELEASED");
      await f.db.merchantConversationSendCommand.update({ where: { id: commandId },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });
      f.releaseExistingCredit.mockClear();
      expect(await f.cancellationService().repairCancelledClaims()).toBe(1);
      expect(f.releaseExistingCredit).not.toHaveBeenCalled();
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
        .initiationKey).toBeNull();
      expect(f.providerHttpRequests).toHaveLength(0);
    } finally { await f.close(); }
  }, 60_000);

  it("does not release an ambiguous credit or let a new claimant take its attempt", async () => {
    const f = await humanDispatchFixture("ambiguous-credit-holds");
    try {
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand();
      const sourceKey = createRecoveryIdempotencyKey(f.shopId, `recovery-outreach:${attemptId}`);
      const counter = await f.db.shopEntitlementCounter.create({ data: {
        shopId: f.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS",
        grantedQuantity: 1, reservedQuantity: 1,
      } });
      await f.db.usageReservation.create({ data: {
        shopId: f.shopId, counterId: counter.id, sourceKey, quantity: 1, status: "AMBIGUOUS",
      } });
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      expect(await f.cancellationService().cancelClaimed(commandId, claim.leaseToken,
        "human_content_moderation_blocked")).toBe("held");
      expect((await f.commandState(commandId))?.state).toBe("CANCELLED");
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
        .initiationKey).toBe(`merchant-${f.recoveryId}`);
      expect(f.releaseExistingCredit).not.toHaveBeenCalled();
    } finally { await f.close(); }
  }, 60_000);
});
