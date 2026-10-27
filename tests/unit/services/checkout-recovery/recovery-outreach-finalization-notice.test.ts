import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: { checkoutRecovery: { updateMany: vi.fn() } },
  attempt: { markWaitingAfterConfirmedSend: vi.fn(), findUnique: vi.fn() },
  followUp: { schedule: vi.fn() },
}));

vi.mock("../../../../src/lib/db.js", () => ({ default: mocks.prisma }));
vi.mock("../../../../src/services/recovery-outreach-attempt.service.js", () => ({
  recoveryOutreachAttemptService: mocks.attempt,
}));
vi.mock("../../../../src/services/recovery-outreach-follow-up.service.js", () => ({
  recoveryOutreachFollowUpService: mocks.followUp,
}));

import type { RecoveryBillingService } from "../../../../src/services/recovery-billing.service.js";
import { RecoveryOutreachFinalizationService } from
  "../../../../src/services/checkout-recovery/recovery-outreach-finalization.service.js";

const sentAt = new Date("2026-10-27T10:00:00.000Z");
const followUpDueAt = new Date("2026-10-27T11:00:00.000Z");
const input = {
  recovery: { id: "recovery-1", shopId: "shop-1", status: "DETECTED" },
  attempt: { id: "attempt-1", sequence: 1, followUpDueAt: null },
  admission: { kind: "paid", sourceKey: "recovery:shop-1:recovery-1" },
  message: { id: "message-1", conversationId: "conversation-1", status: "SENT", sentAt },
  policy: { followUpEnabled: true, followUpDelayMinutes: 60 },
};

function createFinalizer(options: {
  billingError?: Error;
  noticeError?: Error;
  statusError?: Error;
  followUpError?: Error;
  sinkThrows?: boolean;
  noticeOutcome?: "created" | "disabled" | "replayed";
} = {}) {
  const billing = {
    commitSuccessfulInitiation: vi.fn(async () => {
      if (options.billingError) throw options.billingError;
    }),
  } as unknown as RecoveryBillingService;
  const initialOutreachFinalizer = {
    finalizeConfirmedInitial: vi.fn(async () => {
      if (options.noticeError) throw options.noticeError;
      return { outcome: options.noticeOutcome ?? "created", outreachAttemptId: input.attempt.id };
    }),
  };
  const logger = { error: vi.fn(() => {
    if (options.sinkThrows) throw new Error("log sink unavailable");
  }) };
  const finalizer = new RecoveryOutreachFinalizationService(
    billing,
    initialOutreachFinalizer as never,
    logger as never,
  );
  const ensureFollowUp = vi.spyOn(finalizer, "ensureScheduledInitialFollowUp").mockImplementation(async () => {
    if (options.followUpError) throw options.followUpError;
  });
  if (options.statusError) mocks.prisma.checkoutRecovery.updateMany.mockRejectedValue(options.statusError);
  return { finalizer, billing, initialOutreachFinalizer, logger, ensureFollowUp };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.checkoutRecovery.updateMany.mockResolvedValue({ count: 1 });
  mocks.attempt.markWaitingAfterConfirmedSend.mockResolvedValue({ count: 1 });
  mocks.attempt.findUnique.mockResolvedValue({ id: input.attempt.id, outboundMessageId: input.message.id, status: "WAITING_FOR_RESPONSE" });
  mocks.followUp.schedule.mockResolvedValue(undefined);
});

describe("RecoveryOutreachFinalizationService initial Support notice wiring", () => {
  it("commits billing, delegates sequence one, then preserves recovery status and follow-up work", async () => {
    const { finalizer, billing, initialOutreachFinalizer, ensureFollowUp } = createFinalizer({ noticeOutcome: "replayed" });

    await expect(finalizer.finalizeConfirmedOutreach(input)).resolves.toBeUndefined();

    expect(billing.commitSuccessfulInitiation).toHaveBeenCalledWith({
      admission: input.admission, recoveryId: input.recovery.id, occurredAt: sentAt,
    });
    expect(initialOutreachFinalizer.finalizeConfirmedInitial).toHaveBeenCalledWith({
      shopId: input.recovery.shopId,
      checkoutRecoveryId: input.recovery.id,
      outreachAttemptId: input.attempt.id,
      outboundMessageId: input.message.id,
      sentAt,
      followUpDueAt,
    });
    expect(billing.commitSuccessfulInitiation).toHaveBeenCalledBefore(initialOutreachFinalizer.finalizeConfirmedInitial);
    expect(initialOutreachFinalizer.finalizeConfirmedInitial).toHaveBeenCalledBefore(mocks.prisma.checkoutRecovery.updateMany);
    expect(mocks.prisma.checkoutRecovery.updateMany).toHaveBeenCalledWith({
      where: { id: input.recovery.id, status: "DETECTED" },
      data: {
        status: "MESSAGE_SENT", messageSentAt: sentAt,
        admissionBlockedAt: null, admissionBlockReason: null,
      },
    });
    expect(mocks.prisma.checkoutRecovery.updateMany).toHaveBeenCalledBefore(ensureFollowUp);
    expect(mocks.attempt.markWaitingAfterConfirmedSend).not.toHaveBeenCalled();
  });

  it.each([
    ["billing", "billingError", "billing"],
    ["notice", "noticeError", "support_notice"],
    ["recovery status", "statusError", "recovery_status"],
    ["follow-up", "followUpError", "follow_up"],
  ] as const)("logs the %s stage and rethrows the exact error", async (_label, errorOption, stage) => {
    const original = new Error(`${stage} failed`);
    const { finalizer, logger } = createFinalizer({ [errorOption]: original });

    await expect(finalizer.finalizeConfirmedOutreach(input)).rejects.toBe(original);

    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      "recovery.initial_outreach_support_notice.shopify_finalization_failed",
      {
        shopId: input.recovery.shopId,
        checkoutRecoveryId: input.recovery.id,
        outreachAttemptId: input.attempt.id,
        outboundMessageId: input.message.id,
        stage,
        error: original,
      },
    );
  });

  it("does not let a failing log sink mask a Support persistence failure or continue status/follow-up work", async () => {
    const original = new Error("notice persistence unavailable");
    const { finalizer, initialOutreachFinalizer, logger, ensureFollowUp } = createFinalizer({
      noticeError: original,
      sinkThrows: true,
    });

    await expect(finalizer.finalizeConfirmedOutreach(input)).rejects.toBe(original);

    expect(initialOutreachFinalizer.finalizeConfirmedInitial).toHaveBeenCalledOnce();
    expect(mocks.prisma.checkoutRecovery.updateMany).not.toHaveBeenCalled();
    expect(ensureFollowUp).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "recovery.initial_outreach_support_notice.shopify_finalization_failed",
      expect.objectContaining({ stage: "support_notice", error: original }),
    );
  });

  it("keeps sequence two on its existing billing and attempt transition path", async () => {
    const { finalizer, billing, initialOutreachFinalizer, logger, ensureFollowUp } = createFinalizer();
    const sequenceTwo = {
      ...input,
      attempt: { id: "attempt-2", sequence: 2, followUpDueAt: null },
    };

    await expect(finalizer.finalizeConfirmedOutreach(sequenceTwo)).resolves.toBeUndefined();

    expect(billing.commitSuccessfulInitiation).toHaveBeenCalledOnce();
    expect(mocks.attempt.markWaitingAfterConfirmedSend).toHaveBeenCalledWith("attempt-2", {
      sentAt, outboundMessageId: input.message.id, followUpDueAt: null,
    });
    expect(initialOutreachFinalizer.finalizeConfirmedInitial).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(ensureFollowUp).not.toHaveBeenCalled();
  });
});
