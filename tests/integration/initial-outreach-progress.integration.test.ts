import "dotenv/config";
import { describe, expect, it, vi } from "vitest";
import { createInitialOutreachProgressFixture } from "./fixtures/initial-outreach-progress.fixture.js";
import { RecoveryOutreachFinalizationService } from "../../src/services/checkout-recovery/recovery-outreach-finalization.service.js";

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

  it("retries confirmed settlement after a billing interruption without creating Support early", async () => {
    const f = await createInitialOutreachProgressFixture();
    try {
      const original = Object.assign(new Error("billing settlement temporarily unavailable"), {
        code: "P1001", clientVersion: "6.19.3",
      });
      const interrupted = new RecoveryOutreachFinalizationService({
        settleConfirmedInitialOutreach: vi.fn().mockRejectedValue(original),
      } as never, f.support, f.logger, f.db);
      const input = {
        recovery: await f.recovery(),
        attempt: await f.attempt(),
        message: { ...(await f.message()), sentAt: f.sentAt },
      };

      await expect(interrupted.finalizeConfirmedInitialOutreach(input)).rejects.toBe(original);
      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId! } }))
        .toMatchObject({ status: "RESERVED" });
      expect((await f.attempt()).status).toBe("PENDING");
      expect((await f.recovery()).status).toBe("DETECTED");
      expect(await f.db.merchantSupportMessage.count({ where: { checkoutRecoveryId: f.recoveryId } })).toBe(0);
      expect(f.records).toContainEqual(expect.objectContaining({
        event: "recovery.initial_outreach_support_notice.shopify_finalization_failed",
        data: expect.objectContaining({ stage: "billing", sourceError: expect.objectContaining({
          message: "billing settlement temporarily unavailable", code: "P1001", clientVersion: "6.19.3",
        }) }),
      }));

      await expect(f.finalizer.finalizeConfirmedInitialOutreach(input)).resolves.toMatchObject({
        kind: "finalized", outboundMessageId: f.messageId, sentAt: f.sentAt,
      });
      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId! } }))
        .toMatchObject({ status: "COMMITTED", sourceKey: f.sourceKey });
      expect(await f.db.merchantSupportMessage.count({ where: { checkoutRecoveryId: f.recoveryId } })).toBe(1);
      expect((await f.recovery()).status).toBe("MESSAGE_SENT");
    } finally {
      await f.db.shop.deleteMany({ where: { id: f.shopId } });
      await f.close();
    }
  }, 45_000);

  it("retries a conditional recovery-status failure after committed Support without changing the receipt", async () => {
    const f = await createInitialOutreachProgressFixture();
    const statusError = Object.assign(new Error("recovery status write unavailable"), {
      code: "P2034", clientVersion: "6.19.3",
    });
    const updateStatus = vi.spyOn(f.db.checkoutRecovery, "updateMany").mockRejectedValueOnce(statusError);
    try {
      const input = {
        recovery: await f.recovery(),
        attempt: await f.attempt(),
        message: { ...(await f.message()), sentAt: f.sentAt },
      };
      await expect(f.finalizer.finalizeConfirmedInitialOutreach(input)).rejects.toBe(statusError);
      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId! } }))
        .toMatchObject({ status: "COMMITTED", sourceKey: f.sourceKey });
      expect(await f.db.merchantSupportMessage.count({ where: { checkoutRecoveryId: f.recoveryId } })).toBe(1);
      expect((await f.recovery()).status).toBe("DETECTED");
      expect(await f.attempt()).toMatchObject({ status: "WAITING_FOR_RESPONSE", sentAt: f.sentAt,
        outboundMessageId: f.messageId, followUpDueAt: null });

      await expect(f.finalizer.finalizeConfirmedInitialOutreach({
        ...input, recovery: await f.recovery(), attempt: await f.attempt(),
      })).resolves.toMatchObject({ kind: "finalized", outboundMessageId: f.messageId, sentAt: f.sentAt });
      expect(updateStatus).toHaveBeenCalledTimes(2);
      expect(await f.db.merchantSupportMessage.count({ where: { checkoutRecoveryId: f.recoveryId } })).toBe(1);
      expect((await f.recovery()).status).toBe("MESSAGE_SENT");
      expect(f.records).toContainEqual(expect.objectContaining({
        event: "recovery.initial_outreach_support_notice.shopify_finalization_failed",
        data: expect.objectContaining({ stage: "recovery_status", sourceError: expect.objectContaining({
          message: "recovery status write unavailable", code: "P2034", clientVersion: "6.19.3",
        }) }),
      }));
    } finally {
      updateStatus.mockRestore();
      await f.db.shop.deleteMany({ where: { id: f.shopId } });
      await f.close();
    }
  }, 45_000);

  it("retries follow-up publication with the persisted due date after SQL finalization", async () => {
    const f = await createInitialOutreachProgressFixture();
    const { recoveryOutreachFollowUpService } = await import("../../src/services/recovery-outreach-follow-up.service.js");
    const queueError = new Error("follow-up queue unavailable");
    const schedule = vi.spyOn(recoveryOutreachFollowUpService, "schedule")
      .mockRejectedValueOnce(queueError).mockResolvedValue(undefined);
    try {
      const input = {
        recovery: await f.recovery(),
        attempt: await f.attempt(),
        message: { ...(await f.message()), sentAt: f.sentAt },
        policy: { followUpEnabled: true, followUpDelayMinutes: 60 },
      };
      const dueAt = new Date(f.sentAt.getTime() + 60 * 60_000);
      await expect(f.finalizer.finalizeConfirmedInitialOutreach(input)).rejects.toBe(queueError);
      expect(await f.attempt()).toMatchObject({ status: "WAITING_FOR_RESPONSE", sentAt: f.sentAt,
        outboundMessageId: f.messageId, followUpDueAt: dueAt });
      expect((await f.recovery()).status).toBe("MESSAGE_SENT");
      expect(await f.db.merchantSupportMessage.count({ where: { checkoutRecoveryId: f.recoveryId } })).toBe(1);

      await expect(f.finalizer.finalizeConfirmedInitialOutreach({
        ...input, recovery: await f.recovery(), attempt: await f.attempt(),
      })).resolves.toMatchObject({ kind: "finalized", outboundMessageId: f.messageId, sentAt: f.sentAt });
      expect(schedule).toHaveBeenCalledTimes(2);
      expect(schedule).toHaveBeenNthCalledWith(1,
        { checkoutRecoveryId: f.recoveryId, sequence: 2 }, dueAt);
      expect(schedule).toHaveBeenNthCalledWith(2,
        { checkoutRecoveryId: f.recoveryId, sequence: 2 }, dueAt);
      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId! } }))
        .toMatchObject({ status: "COMMITTED", sourceKey: f.sourceKey });
      expect(f.records).toContainEqual(expect.objectContaining({
        event: "recovery.initial_outreach_support_notice.shopify_finalization_failed",
        data: expect.objectContaining({ stage: "follow_up", sourceError: expect.objectContaining({
          message: "follow-up queue unavailable",
        }) }),
      }));
    } finally {
      schedule.mockRestore();
      await f.db.shop.deleteMany({ where: { id: f.shopId } });
      await f.close();
    }
  }, 45_000);
});