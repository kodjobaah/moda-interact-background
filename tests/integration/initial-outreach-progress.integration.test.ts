import "dotenv/config";
import { describe, expect, it } from "vitest";
import { createInitialOutreachProgressFixture } from "./fixtures/initial-outreach-progress.fixture.js";

const suite = process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe
  : describe.skip;

suite("initial outreach progress finalization (PostgreSQL)", () => {
  it("settles exact confirmed credit and replays Support/status without changing receipt identity", async () => {
    const f = await createInitialOutreachProgressFixture();
    try {
      const recovery = await f.recovery();
      const attempt = await f.attempt();
      const message = await f.message();
      const input = {
        recovery,
        attempt,
        message: { ...message, sentAt: message.sentAt! },
        policy: { followUpEnabled: false, followUpDelayMinutes: null },
      };

      await expect(f.finalizer.finalizeConfirmedInitialOutreach(input)).resolves.toEqual({
        kind: "finalized", outboundMessageId: f.messageId, sentAt: f.sentAt,
      });
      const finalizedAttempt = await f.attempt();
      await expect(f.finalizer.finalizeConfirmedInitialOutreach({
        ...input, recovery: await f.recovery(), attempt: finalizedAttempt,
      })).resolves.toEqual({ kind: "finalized", outboundMessageId: f.messageId, sentAt: f.sentAt });

      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId! } }))
        .toMatchObject({ status: "COMMITTED", shopId: f.shopId, sourceKey: f.sourceKey });
      expect(await f.attempt()).toMatchObject({
        status: "WAITING_FOR_RESPONSE", outboundMessageId: f.messageId,
        sentAt: f.sentAt, followUpDueAt: null,
      });
      expect((await f.recovery()).status).toBe("MESSAGE_SENT");
      expect(await f.db.merchantSupportMessage.count({
        where: { sourceKey: `recovery-initial-outreach:v1:${f.attemptId}` },
      })).toBe(1);
      expect(f.records.some((record) => record.event === "recovery.initial_outreach_support_notice.created")).toBe(true);
      expect(f.records.some((record) => record.event === "recovery.initial_outreach_support_notice.replayed")).toBe(true);
    } finally {
      await f.db.shop.deleteMany({ where: { id: f.shopId } });
      await f.close();
    }
  }, 45_000);

  it("keeps ambiguous confirmed credit held before Support, attempt, or recovery success", async () => {
    const f = await createInitialOutreachProgressFixture();
    try {
      await f.db.usageReservation.update({ where: { id: f.reservationId! }, data: { status: "AMBIGUOUS" } });
      const result = await f.finalizer.finalizeConfirmedInitialOutreach({
        recovery: await f.recovery(),
        attempt: await f.attempt(),
        message: { ...(await f.message()), sentAt: f.sentAt },
      });

      expect(result).toMatchObject({ kind: "held", reason: "reservation-ambiguous",
        reservationId: f.reservationId, sourceKey: f.sourceKey });
      expect((await f.attempt()).status).toBe("PENDING");
      expect((await f.recovery()).status).toBe("DETECTED");
      expect(await f.db.merchantSupportMessage.count({ where: { checkoutRecoveryId: f.recoveryId } })).toBe(0);
      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId! } }))
        .toMatchObject({ status: "AMBIGUOUS", committedUsageEventId: null });
    } finally {
      await f.db.shop.deleteMany({ where: { id: f.shopId } });
      await f.close();
    }
  }, 45_000);
});