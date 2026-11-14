import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createLogger, type LogRecord } from "@modainteract/moda-interact-shared/logging";
vi.mock("../../../../src/lib/db.js", () => ({ default: {} }));
import type { ConfirmedInitialRecoveryOutreachInput } from
  "../../../../src/services/checkout-recovery/recovery-initial-outreach-support-notice.contracts.js";
import { RecoveryInitialOutreachSupportNoticeService } from
  "../../../../src/services/checkout-recovery/recovery-initial-outreach-support-notice.service.js";

const emittedRecords: LogRecord[] = [];
const sharedPackageJson = JSON.parse(readFileSync(new URL(
  "../../../../node_modules/@modainteract/moda-interact-shared/package.json", import.meta.url,
), "utf8")) as { version: string };
const sharedLoggerResolution = import.meta.resolve("@modainteract/moda-interact-shared/logging");

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

function context(options: {
  enabled?: boolean; status?: string; initiatedBy?: string | null; failureCode?: string | null;
  sharedLogger?: boolean;
} = {}) {
  const attempt = {
    id: input.outreachAttemptId,
    checkoutRecoveryId: input.checkoutRecoveryId,
    sequence: 1,
    trigger: "INITIAL",
    initiatedBy: options.initiatedBy ?? "AUTOMATION",
    status: options.status ?? "PENDING",
    failureCode: options.failureCode ?? null,
    closedAt: null,
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
    $queryRaw: vi.fn()
      .mockResolvedValueOnce([{ id: input.shopId }])
      .mockResolvedValueOnce([{ id: attempt.id }]),
    recoveryOutreachAttempt: {
      findUnique: vi.fn(async () => attempt),
      updateMany: vi.fn(async ({ data }: { data: Partial<typeof attempt> }) => {
        Object.assign(attempt, data);
        return { count: 1 };
      }),
    },
    conversationMessage: { findUnique: vi.fn(async () => message) },
    usageEvent: { findUnique: vi.fn(async () => ({ id: "usage-1", shopId: input.shopId,
      metric: "OUTBOUND_AUTOMATED_MESSAGE", sourceType: "OUTBOUND_AUTOMATED_MESSAGE",
      sourceId: input.outboundMessageId, quantity: 1 })) },
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
  const logger = options.sharedLogger ? createLogger({
    serviceName: "moda-recovery-worker",
    environment: "test",
    sink: (record) => emittedRecords.push(JSON.parse(JSON.stringify(record)) as LogRecord),
  }) : { info: vi.fn(), error: vi.fn() };
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
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(f.tx.recoveryOutreachAttempt.findUnique).toHaveBeenCalledTimes(2);
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
    await expect(f.service.finalizeConfirmedInitial(input)).rejects.toThrow("routing pointer");
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

  it("repairs only the exact legacy provider-failure state from canonical confirmed usage", async () => {
    const f = context({ status: "FAILED", failureCode: "PROVIDER_FAILURE" });
    await expect(f.service.finalizeConfirmedInitial(input)).resolves.toEqual({
      outcome: "created", outreachAttemptId: input.outreachAttemptId,
    });
    expect(f.tx.usageEvent.findUnique).toHaveBeenCalledWith({
      where: { idempotencyKey: `recovery-outreach:${input.outreachAttemptId}` },
      select: { id: true, shopId: true, metric: true, sourceType: true, sourceId: true, quantity: true },
    });
    expect(f.tx.recoveryOutreachAttempt.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: "FAILED", failureCode: "PROVIDER_FAILURE", closedAt: null,
        sentAt: null, outboundMessageId: null, followUpDueAt: null,
      }),
      data: expect.objectContaining({ status: "WAITING_FOR_RESPONSE", failureCode: null,
        sentAt, outboundMessageId: input.outboundMessageId, followUpDueAt: dueAt }),
    }));
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
        sourceError: expect.objectContaining({ name: "Error", message: "database unavailable" }),
      }),
    );
  });

  it("emits the redacted Support failure and bounded cause through the installed Shared logger", async () => {
    emittedRecords.length = 0;
    expect(sharedPackageJson.version).toBe("6.0.1");
    expect(sharedLoggerResolution).toContain("@modainteract/moda-interact-shared");
    const f = context({ sharedLogger: true });
    const cause = Object.assign(new Error("Support database unavailable for phone +447000111222"), {
      code: "P1001", clientVersion: "6.19.3",
    });
    const original = Object.assign(new Error("Support write failed for phone +447000111222 token=private-value"), {
      code: "P2025", clientVersion: "6.19.3", cause,
    });
    f.database.$transaction.mockRejectedValueOnce(original);

    await expect(f.service.finalizeConfirmedInitial(input)).rejects.toBe(original);

    expect(emittedRecords).toContainEqual(expect.objectContaining({
      event: "recovery.initial_outreach_support_notice.failed",
      level: "error",
      "service.name": "moda-recovery-worker",
      "deployment.environment.name": "test",
      data: expect.objectContaining({
        shopId: input.shopId,
        checkoutRecoveryId: input.checkoutRecoveryId,
        outreachAttemptId: input.outreachAttemptId,
        outboundMessageId: input.outboundMessageId,
        errorCategory: "PERSISTENCE_FAILURE",
        sourceError: expect.objectContaining({
          message: "Support write failed for phone [REDACTED_PHONE] [REDACTED_CREDENTIAL]",
          code: "P2025",
          clientVersion: "6.19.3",
          cause: expect.objectContaining({
            message: "Support database unavailable for phone [REDACTED_PHONE]",
            code: "P1001",
            clientVersion: "6.19.3",
          }),
        }),
      }),
    }));
    expect(JSON.stringify(emittedRecords)).not.toContain("+447000111222");
    expect(JSON.stringify(emittedRecords)).not.toContain("private-value");
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
