import "dotenv/config";
import { describe, expect, it } from "vitest";
import { MerchantSendCommandService } from "../../src/services/recovery-conversation/merchant-send-command.service.js";
import { humanDispatchFixture } from "./fixtures/recovery-human-dispatch.fixture.js";

const suite = process.env.TEST_DATABASE_URL && process.env.REDIS_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

async function waitForShopLockWaiters(db: { $queryRawUnsafe<T>(query: string): Promise<T> }, minimum: number) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const [row] = await db.$queryRawUnsafe<Array<{ count: number }>>(`
      SELECT count(*)::int AS "count" FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'
        AND query ILIKE '%commerce%Shop%' AND query ILIKE '%FOR UPDATE%'`);
    if ((row?.count ?? 0) >= minimum) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${minimum} PostgreSQL shop-lock waiters`);
}

suite("ARCH-055 persisted follow-up ownership identity", () => {
  it("cancels only the migrated persisted owner when its value differs from public idempotency", async () => {
    const f = await humanDispatchFixture("arch055-historical-identity");
    try {
      const historicalKey = `historical-${f.recoveryId}`;
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand("recovery_follow_up", historicalKey);
      const lease = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const command = await f.commands.loadClaimedCommand(commandId, lease.leaseToken);
      expect(command).toMatchObject({ kind: "claimed", command: {
        idempotencyKey: `merchant-${f.recoveryId}`, followUpClaimKey: historicalKey,
      } });
      // A new service instance simulates worker restart: persisted identity is
      // loaded from the command row and is not reconstructed from HTTP replay.
      expect(await new MerchantSendCommandService(f.db).loadClaimedCommand(commandId, lease.leaseToken))
        .toMatchObject({ kind: "claimed", command: { followUpClaimKey: historicalKey } });
      expect(await f.cancellationService().cancelClaimed(commandId, lease.leaseToken,
        "human_content_moderation_blocked")).toBe("released");
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
        .initiationKey).toBeNull();
      expect(f.providerHttpRequests).toHaveLength(0);
    } finally { await f.close(); }
  }, 60_000);

  it("isolates identical public idempotency keys across Shops by persisted ownership", async () => {
    const first = await humanDispatchFixture("arch055-shared-public-key-a");
    const second = await humanDispatchFixture("arch055-shared-public-key-b");
    try {
      const publicKey = "same-http-replay-key";
      const firstOwner = `legacy-owner-${first.recoveryId}`;
      const secondOwner = `legacy-owner-${second.recoveryId}`;
      const a = await first.addMerchantFollowUpCommand("recovery_follow_up", firstOwner, publicKey);
      const b = await second.addMerchantFollowUpCommand("recovery_follow_up", secondOwner, publicKey);
      const aLease = (await first.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const bLease = (await second.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      expect(await first.commands.loadClaimedCommand(a.commandId, aLease.leaseToken))
        .toMatchObject({ kind: "claimed", command: { idempotencyKey: publicKey, followUpClaimKey: firstOwner } });
      expect(await second.commands.loadClaimedCommand(b.commandId, bLease.leaseToken))
        .toMatchObject({ kind: "claimed", command: { idempotencyKey: publicKey, followUpClaimKey: secondOwner } });
      expect(await first.cancellationService().cancelClaimed(a.commandId, aLease.leaseToken,
        "human_content_moderation_blocked")).toBe("released");
      expect((await second.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: b.attemptId } }))
        .initiationKey).toBe(secondOwner);
      expect(first.providerHttpRequests).toHaveLength(0);
      expect(second.providerHttpRequests).toHaveLength(0);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  }, 60_000);

  it("fences an old worker behind cancellation before a reclaimed attempt can be changed", async () => {
    const f = await humanDispatchFixture("arch055-barrier-reclaimed-owner");
    let releaseBlocker: (() => void) | undefined;
    let blocker: Promise<unknown> | undefined;
    try {
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand();
      const oldLease = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      let signalAcquired!: () => void;
      const blockerRelease = new Promise<void>((resolve) => { releaseBlocker = resolve; });
      const blockerAcquired = new Promise<void>((resolve) => { signalAcquired = resolve; });
      blocker = f.db.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT "id" FROM "commerce"."Shop" WHERE "id"=$1 FOR UPDATE`, f.shopId);
        signalAcquired();
        await blockerRelease;
      });
      await blockerAcquired;

      const nextKey = `reclaimed-${f.recoveryId}`;
      const cancellation = f.cancellationService().cancelClaimed(commandId, oldLease.leaseToken,
        "human_content_moderation_blocked");
      await waitForShopLockWaiters(f.db, 1);
      const nextClaim = f.followUps.claimSequenceTwo({ recoveryId: f.recoveryId,
        initiator: "merchant_post_window", expectedRevision: 1,
        initiationKey: nextKey, recipient: f.recipient, now: new Date() });
      await waitForShopLockWaiters(f.db, 2);

      releaseBlocker!();
      const [cancelled, claimed] = await Promise.all([cancellation, nextClaim]);
      await blocker;
      expect(cancelled).toBe("released");
      expect(claimed).toEqual({ kind: "claimed", attemptId,
        billingSource: `recovery-outreach:${attemptId}` });
      const newCommandId = await f.addCommand({ kind: "RECOVERY_FOLLOW_UP_TEMPLATE",
        idempotencyKey: `public-${nextKey}`, followUpClaimKey: nextKey, attemptId });

      const oldWorker = f.dispatcher();
      await oldWorker.processClaim(commandId, oldLease.leaseToken);
      await oldWorker.close();
      expect((await f.db.merchantConversationSendCommand.findUniqueOrThrow({ where: { id: newCommandId } }))
        .followUpClaimKey).toBe(nextKey);
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
        .initiationKey).toBe(nextKey);
      expect(f.providerHttpRequests).toHaveLength(0);
      expect(await f.db.usageEvent.count({ where: { shopId: f.shopId } })).toBe(0);
      expect(await f.db.usageReservation.count({ where: { shopId: f.shopId } })).toBe(0);
    } finally {
      releaseBlocker?.();
      await blocker?.catch(() => {});
      await f.close();
    }
  }, 60_000);

  it("fails closed for a template command without a persisted key and leaves the attempt held", async () => {
    const f = await humanDispatchFixture("arch055-missing-identity");
    try {
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand("recovery_follow_up", null);
      const lease = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const dispatcher = f.dispatcher();
      await dispatcher.processClaim(commandId, lease.leaseToken);
      await dispatcher.close();
      expect(await f.commandState(commandId)).toEqual(expect.objectContaining({
        state: "CANCELLED", providerDispatchKey: null, outboundMessageId: null,
      }));
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
        .initiationKey).toBe(`merchant-${f.recoveryId}`);
      expect(f.providerHttpRequests).toHaveLength(0);
      expect(await f.db.usageEvent.count({ where: { shopId: f.shopId } })).toBe(0);
      expect(await f.db.usageReservation.count({ where: { shopId: f.shopId } })).toBe(0);
    } finally { await f.close(); }
  }, 60_000);
});
