import { describe, expect, it, vi } from "vitest";
vi.mock("../../../../src/lib/db.js", () => ({ default: {} }));
import type { ConfirmedInitialRecoveryOutreachInput } from
  "../../../../src/services/checkout-recovery/recovery-initial-outreach-support-notice.contracts.js";
import { RecoveryInitialOutreachSupportNoticeService } from
  "../../../../src/services/checkout-recovery/recovery-initial-outreach-support-notice.service.js";

const sentAt = new Date("2026-10-27T10:00:00.000Z");
const dueAt = new Date("2026-10-27T11:00:00.000Z");
const input: ConfirmedInitialRecoveryOutreachInput = {
  shopId: "shop-1",
  checkoutRecoveryId: "recovery-1",
  outreachAttemptId: "attempt-1",
  outboundMessageId: "outbound-1",
  sentAt,
  followUpDueAt: dueAt,
};

function context(options: { enabled?: boolean; status?: string; initiatedBy?: string | null } = {}) {
  const attempt = {
    id: input.outreachAttemptId,
    checkoutRecoveryId: input.checkoutRecoveryId,
    sequence: 1,
    trigger: "INITIAL",
    initiatedBy: options.initiatedBy ?? "AUTOMATION",
    status: options.status ?? "PENDING",
    sentAt: null as Date | null,
    outboundMessageId: null as string | null,
    followUpDueAt: null as Date | null,
    checkoutRecovery: {
      shopId: input.shopId,
      conversation: { id: "conversation-1", shopId: input.shopId },
    },
  };
  const message = {
    id: input.outboundMessageId,
    conversationId: "conversation-1",
    direction: "OUTBOUND",
    senderType: "AUTOMATION",
    status: "SENT",
    sentAt,
  };
  const thread = { id: "thread-1" };
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: attempt.id }]),
    recoveryOutreachAttempt: {
      findUnique: vi.fn(async () => attempt),
      updateMany: vi.fn(async ({ data }: { data: Partial<typeof attempt> }) => {
        Object.assign(attempt, data);
        return { count: 1 };
      }),
    },
    conversationMessage: { findUnique: vi.fn(async () => message) },
    shopSettings: { findUnique: vi.fn(async () => ({ notifyOnInitialRecoveryOutreach: options.enabled ?? true })) },
    merchantSupportThread: {
      createMany: vi.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: vi.fn(async () => thread),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    merchantSupportMessage: {
      createMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const database = {
    $transaction: vi.fn(async (callback: (arg: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const logger = { info: vi.fn(), error: vi.fn() };
  const now = vi.fn(() => new Date("2026-10-27T10:01:00.000Z"));
  const service = new RecoveryInitialOutreachSupportNoticeService(database as never, now, logger as never);
  return { service, attempt, message, tx, database, logger, now };
}

describe("RecoveryInitialOutreachSupportNoticeService", () => {
  it("transitions once and creates one bounded SYSTEM Support notice atomically", async () => {
    const f = context();
    await expect(f.service.finalizeConfirmedInitial(input)).resolves.toEqual({
      outcome: "created", outreachAttemptId: input.outreachAttemptId,
    });
    expect(f.tx.$queryRaw).toHaveBeenCalledOnce();
    expect(f.tx.recoveryOutreachAttempt.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: input.outreachAttemptId, sentAt: null, outboundMessageId: null }),
      data: expect.objectContaining({ status: "WAITING_FOR_RESPONSE", sentAt, outboundMessageId: input.outboundMessageId, followUpDueAt: dueAt }),
    }));
    expect(f.tx.shopSettings.findUnique).toHaveBeenCalledWith({
      where: { shopId: input.shopId }, select: { notifyOnInitialRecoveryOutreach: true },
    });
    expect(f.tx.merchantSupportThread.createMany).toHaveBeenCalledWith({
      data: [{ shopId: input.shopId }], skipDuplicates: true,
    });
    expect(f.tx.merchantSupportMessage.createMany).toHaveBeenCalledWith({
      skipDuplicates: true,
      data: [{
        threadId: "thread-1", kind: "SYSTEM", state: "AVAILABLE",
        originalBody: "A checkout recovery message was sent to a customer.",
        sourceLanguageTag: "en-GB", systemCode: "RECOVERY_INITIAL_OUTREACH_SENT",
        systemVersion: "1", sourceKey: "recovery-initial-outreach:v1:attempt-1",
        checkoutRecoveryId: input.checkoutRecoveryId, readAt: null,
        availableAt: new Date("2026-10-27T10:01:00.000Z"),
      }],
    });
    expect(f.tx.merchantSupportThread.updateMany).toHaveBeenCalledOnce();
    expect(f.logger.info).toHaveBeenCalledOnce();
    expect(f.logger.info).toHaveBeenCalledWith(
      "recovery.initial_outreach_support_notice.created",
      expect.objectContaining({ outcome: "created", shopId: input.shopId, checkoutRecoveryId: input.checkoutRecoveryId }),
    );
    expect(f.logger.error).not.toHaveBeenCalled();
    const logged = JSON.stringify(f.logger.info.mock.calls);
    expect(logged).not.toContain("A recovery message was sent.");
    expect(logged).not.toContain("originalBody");
  });

  it("commits disabled first-send transitions without creating Support data", async () => {
    const f = context({ enabled: false });
    await expect(f.service.finalizeConfirmedInitial(input)).resolves.toEqual({
      outcome: "disabled", outreachAttemptId: input.outreachAttemptId,
    });
    expect(f.tx.recoveryOutreachAttempt.updateMany).toHaveBeenCalledOnce();
    expect(f.tx.merchantSupportThread.createMany).not.toHaveBeenCalled();
    expect(f.tx.merchantSupportMessage.createMany).not.toHaveBeenCalled();
    expect(f.logger.info).toHaveBeenCalledWith(
      "recovery.initial_outreach_support_notice.disabled", expect.objectContaining({ outcome: "disabled" }),
    );
  });

  it("replays the same finalisation without resampling the preference", async () => {
    const f = context({ status: "ENGAGED" });
    Object.assign(f.attempt, { sentAt, outboundMessageId: input.outboundMessageId, followUpDueAt: dueAt });
    await expect(f.service.finalizeConfirmedInitial(input)).resolves.toEqual({
      outcome: "replayed", outreachAttemptId: input.outreachAttemptId,
    });
    expect(f.tx.shopSettings.findUnique).not.toHaveBeenCalled();
    expect(f.tx.recoveryOutreachAttempt.updateMany).not.toHaveBeenCalled();
    expect(f.tx.merchantSupportMessage.createMany).not.toHaveBeenCalled();
    expect(f.logger.info).toHaveBeenCalledWith(
      "recovery.initial_outreach_support_notice.replayed", expect.objectContaining({ outcome: "replayed" }),
    );
  });

  it("fails closed for malformed input and does not log unvalidated identifiers", async () => {
    const f = context();
    await expect(f.service.finalizeConfirmedInitial({ ...input, shopId: "  " })).rejects.toThrow("shopId");
    await expect(f.service.finalizeConfirmedInitial({ ...input, sentAt: new Date("bad") })).rejects.toThrow("sentAt");
    await expect(f.service.finalizeConfirmedInitial({ ...input, followUpDueAt: sentAt })).rejects.toThrow("followUpDueAt");
    expect(f.database.$transaction).not.toHaveBeenCalled();
    expect(f.logger.error).toHaveBeenCalledTimes(3);
    expect(f.logger.error).toHaveBeenCalledWith(
      "recovery.initial_outreach_support_notice.failed",
      expect.objectContaining({ errorCategory: "INVALID_INPUT", outcome: "failed" }),
    );
    expect(f.logger.error.mock.calls[0]?.[1]).not.toHaveProperty("shopId");
  });

  it("rejects mismatched persisted lineage and never samples a preference", async () => {
    const f = context();
    f.attempt.checkoutRecovery.shopId = "other-shop";
    await expect(f.service.finalizeConfirmedInitial(input)).rejects.toThrow("tenant or conversation lineage");
    expect(f.tx.shopSettings.findUnique).not.toHaveBeenCalled();
    expect(f.logger.error).toHaveBeenCalledWith(
      "recovery.initial_outreach_support_notice.failed",
      expect.objectContaining({ errorCategory: "LINEAGE_MISMATCH", shopId: input.shopId }),
    );
  });

  it("rejects HUMAN, wrong sender, failed message, and changed message identity", async () => {
    const human = context({ initiatedBy: "HUMAN" });
    await expect(human.service.finalizeConfirmedInitial(input)).rejects.toThrow("attempt lineage");
    const wrongSender = context();
    wrongSender.message.senderType = "HUMAN";
    await expect(wrongSender.service.finalizeConfirmedInitial(input)).rejects.toThrow("outbound message lineage");
    const failedMessage = context();
    failedMessage.message.status = "FAILED";
    await expect(failedMessage.service.finalizeConfirmedInitial(input)).rejects.toThrow("outbound message lineage");
    const changed = context({ status: "WAITING_FOR_RESPONSE" });
    Object.assign(changed.attempt, { sentAt, outboundMessageId: "other-message", followUpDueAt: dueAt });
    await expect(changed.service.finalizeConfirmedInitial(input)).rejects.toThrow("different message identity");
    const wrongTrigger = context();
    wrongTrigger.attempt.trigger = "NO_RESPONSE_FOLLOW_UP";
    await expect(wrongTrigger.service.finalizeConfirmedInitial(input)).rejects.toThrow("attempt lineage");
    const wrongSequence = context();
    wrongSequence.attempt.sequence = 2;
    await expect(wrongSequence.service.finalizeConfirmedInitial(input)).rejects.toThrow("attempt lineage");
    const cancelled = context({ status: "CANCELLED" });
    await expect(cancelled.service.finalizeConfirmedInitial(input)).rejects.toThrow("current state");
  });

  it("rethrows the exact transaction error and emits one failed event even when the sink throws", async () => {
    const f = context();
    const original = new Error("database unavailable");
    f.database.$transaction.mockRejectedValueOnce(original);
    f.logger.error.mockImplementation(() => { throw new Error("sink failure"); });
    await expect(f.service.finalizeConfirmedInitial(input)).rejects.toBe(original);
    expect(f.logger.error).toHaveBeenCalledOnce();
    expect(f.logger.error).toHaveBeenCalledWith(
      "recovery.initial_outreach_support_notice.failed",
      expect.objectContaining({
        outcome: "failed",
        errorCategory: "PERSISTENCE_FAILURE",
        error: original,
      }),
    );
  });

  it("does not turn a committed success into failure when the logger throws", async () => {
    const f = context();
    f.logger.info.mockImplementation(() => { throw new Error("sink failure"); });
    await expect(f.service.finalizeConfirmedInitial(input)).resolves.toMatchObject({ outcome: "created" });
    expect(f.tx.merchantSupportMessage.createMany).toHaveBeenCalledOnce();
    expect(f.logger.info).toHaveBeenCalledOnce();
    expect(f.logger.error).not.toHaveBeenCalled();
  });
});
