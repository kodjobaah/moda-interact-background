import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dependencies: undefined as
    { finalize: { confirmed(input: any): Promise<unknown> } } | undefined,
  settle: vi.fn(),
  finalizeNotice: vi.fn(),
  findConversation: vi.fn(),
  updateRecovery: vi.fn(),
  readRecovery: vi.fn(),
  policy: vi.fn(),
  schedule: vi.fn(),
}));

vi.mock("../../../../src/lib/db.js", () => ({
  default: {
    conversation: { findUnique: mocks.findConversation },
    checkoutRecovery: {
      updateMany: mocks.updateRecovery,
      findUnique: mocks.readRecovery,
    },
  },
}));
vi.mock("../../../../src/services/recovery-billing.service.js", () => ({
  recoveryBillingService: { settleConfirmedInitialOutreach: mocks.settle },
}));
vi.mock(
  "../../../../src/services/checkout-recovery/recovery-initial-outreach-support-notice.service.js",
  () => ({
    recoveryInitialOutreachSupportNoticeService: {
      finalizeConfirmedInitial: mocks.finalizeNotice,
    },
  }),
);
vi.mock(
  "../../../../src/services/woocommerce-recovery/woo-recovery-outreach.service.js",
  () => ({
    WooRecoveryOutreachService: class {
      constructor(dependencies: typeof mocks.dependencies) {
        mocks.dependencies = dependencies;
      }
    },
  }),
);
vi.mock(
  "../../../../src/services/checkout-recovery/recovery-recipient-resolver.service.js",
  () => ({ recoveryRecipientResolverService: {} }),
);
vi.mock(
  "../../../../src/services/recovery-outreach-attempt.service.js",
  () => ({ recoveryOutreachAttemptService: { getOrCreate: vi.fn() } }),
);
vi.mock("../../../../src/services/recovery-policy.service.js", () => ({
  recoveryPolicyService: { resolve: mocks.policy },
}));
vi.mock(
  "../../../../src/services/recovery-outreach-follow-up.service.js",
  () => ({ recoveryOutreachFollowUpService: { schedule: mocks.schedule } }),
);
vi.mock("../../../../src/services/conversation.service.js", () => ({
  conversationService: {},
}));
vi.mock(
  "../../../../src/services/recovery-template-integration/automated-recovery-template.service.js",
  () => ({ automatedRecoveryTemplateService: {} }),
);
vi.mock(
  "../../../../src/services/woocommerce-recovery-consent.service.js",
  () => ({ wooRecoveryConsentReader: {} }),
);
vi.mock("../../../../src/services/whatsapp-provider-rejection.js", () => ({
  isSynchronousRecipientFailure: vi.fn(),
}));

import { createWooRecoveryOutreachService } from "../../../../src/services/woocommerce-recovery/woo-recovery-outreach.adapters.js";

const recovery = { id: "recovery-1", shopId: "shop-1" } as any;
const attempt = { id: "attempt-1", sequence: 1, followUpDueAt: null } as any;
const message = {
  id: "message-1",
  conversationId: "conversation-1",
  status: "SENT",
  sentAt: new Date("2026-10-27T10:00:00.000Z"),
} as any;
function makeAdapter(
  logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), child: vi.fn() },
) {
  createWooRecoveryOutreachService({
    coordinator: {} as any,
    orders: {} as any,
    guardedSender: {} as any,
    enqueue: {} as any,
    logger: logger as any,
  });
  return { confirmed: mocks.dependencies!.finalize.confirmed, logger };
}

describe("Woo initial outreach Support notice adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findConversation.mockResolvedValue({ id: "conversation-1" });
    mocks.settle.mockResolvedValue({
      kind: "settled",
      disposition: "committed",
      sourceKind: "purchased",
      sourceKey: "source-1",
      reservationId: "reservation-1",
      committedUsageEventId: "usage-1",
      outboundMessageId: message.id,
      sentAt: message.sentAt,
    });
    mocks.finalizeNotice.mockResolvedValue({
      outcome: "created",
      outreachAttemptId: attempt.id,
    });
    mocks.updateRecovery.mockResolvedValue({ count: 1 });
    mocks.readRecovery.mockResolvedValue(null);
    mocks.policy.mockResolvedValue({
      followUpEnabled: false,
      followUpDelayMinutes: null,
    });
    mocks.schedule.mockResolvedValue("follow-up-job");
  });

  it.each(["created", "disabled", "replayed"] as const)(
    "accepts the shared finalizer's %s outcome and updates Woo recovery state",
    async (outcome) => {
      mocks.finalizeNotice.mockResolvedValue({
        outcome,
        outreachAttemptId: attempt.id,
      });
      const { confirmed } = makeAdapter();
      await expect(confirmed({ recovery, attempt, message })).resolves.toEqual({
        kind: "finalized",
        outboundMessageId: message.id,
        sentAt: message.sentAt,
      });

      expect(mocks.settle).toHaveBeenCalledWith({
        shopId: recovery.shopId,
        recoveryId: recovery.id,
        outreachAttemptId: attempt.id,
        outboundMessageId: message.id,
      });
      expect(mocks.finalizeNotice).toHaveBeenCalledWith({
        shopId: recovery.shopId,
        checkoutRecoveryId: recovery.id,
        outreachAttemptId: attempt.id,
        outboundMessageId: message.id,
        sentAt: message.sentAt,
        followUpDueAt: null,
      });
      expect(mocks.schedule).not.toHaveBeenCalled();
      expect(mocks.updateRecovery).toHaveBeenCalledWith({
        where: { id: recovery.id, shopId: recovery.shopId, status: "DETECTED" },
        data: {
          status: "MESSAGE_SENT",
          messageSentAt: message.sentAt,
          admissionBlockedAt: null,
          admissionBlockReason: null,
        },
      });
    },
  );

  it.each(["billing", "support_notice", "recovery_status"] as const)(
    "logs %s failures and rethrows the original error even if the logger throws",
    async (stage) => {
      const original = new Error(`${stage} failed`);
      if (stage === "billing") mocks.settle.mockRejectedValueOnce(original);
      if (stage === "support_notice")
        mocks.finalizeNotice.mockRejectedValueOnce(original);
      if (stage === "recovery_status")
        mocks.updateRecovery.mockRejectedValueOnce(original);
      const logger = {
        error: vi.fn(() => {
          throw new Error("sink failed");
        }),
        info: vi.fn(),
        warn: vi.fn(),
        child: vi.fn(),
      };
      const { confirmed } = makeAdapter(logger);

      await expect(confirmed({ recovery, attempt, message })).rejects.toBe(
        original,
      );
      expect(logger.error).toHaveBeenCalledWith(
        "recovery.initial_outreach_support_notice.woocommerce_finalization_failed",
        {
          shopId: recovery.shopId,
          checkoutRecoveryId: recovery.id,
          outreachAttemptId: attempt.id,
          outboundMessageId: message.id,
          stage,
          sourceError: expect.objectContaining({
            name: "Error",
            message: `${stage} failed`,
          }),
        },
      );
    },
  );

  it("rejects non-initial or unconfirmed deadlines and protects conversation ownership", async () => {
    const { confirmed } = makeAdapter();
    await expect(
      confirmed({ recovery, attempt: { ...attempt, sequence: 2 }, message }),
    ).rejects.toThrow("WOO_INITIAL_ATTEMPT_CONFLICT");
    await expect(
      confirmed({
        recovery,
        attempt: { ...attempt, followUpDueAt: new Date() },
        message,
      }),
    ).rejects.toThrow("WOO_INITIAL_ATTEMPT_CONFLICT");
    await expect(
      confirmed({
        recovery,
        attempt,
        message: { ...message, conversationId: "other" },
      }),
    ).rejects.toThrow("WOO_INITIAL_MESSAGE_CONVERSATION_MISMATCH");
    expect(mocks.settle).not.toHaveBeenCalled();
    expect(mocks.finalizeNotice).not.toHaveBeenCalled();
    expect(mocks.updateRecovery).not.toHaveBeenCalled();
  });

  it("persists the configured deadline from confirmed send time and republishes it after a queue failure", async () => {
    const due = new Date(message.sentAt.getTime() + 15 * 60_000);
    const finalized = {
      ...attempt,
      status: "WAITING_FOR_RESPONSE",
      outboundMessageId: message.id,
      sentAt: message.sentAt,
      followUpDueAt: due,
    };
    mocks.policy.mockResolvedValue({
      followUpEnabled: true,
      followUpDelayMinutes: 15,
    });
    mocks.readRecovery.mockResolvedValue({
      ...recovery,
      status: "MESSAGE_SENT",
      outreachAttempts: [finalized],
    });
    const queueError = new Error("queue unavailable");
    mocks.schedule.mockRejectedValueOnce(queueError);
    const { confirmed, logger } = makeAdapter();
    await expect(confirmed({ recovery, attempt, message })).rejects.toBe(
      queueError,
    );
    expect(mocks.finalizeNotice).toHaveBeenCalledWith(
      expect.objectContaining({ followUpDueAt: due }),
    );
    expect(mocks.schedule).toHaveBeenCalledWith(
      { checkoutRecoveryId: recovery.id, sequence: 2 },
      due,
    );
    expect(logger.error).toHaveBeenCalledWith(
      "recovery.initial_outreach_support_notice.woocommerce_finalization_failed",
      expect.objectContaining({
        stage: "follow_up",
        sourceError: expect.objectContaining({ message: queueError.message }),
      }),
    );
    mocks.policy.mockResolvedValue({
      followUpEnabled: false,
      followUpDelayMinutes: null,
    });
    await expect(
      confirmed({ recovery, attempt: finalized, message }),
    ).resolves.toMatchObject({ kind: "finalized" });
    expect(mocks.policy).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeNotice).toHaveBeenLastCalledWith(
      expect.objectContaining({ followUpDueAt: due }),
    );
    expect(mocks.schedule).toHaveBeenCalledTimes(2);
    expect(mocks.schedule).toHaveBeenLastCalledWith(
      { checkoutRecoveryId: recovery.id, sequence: 2 },
      due,
    );
  });

  it("does not publish a follow-up for a terminal recovery", async () => {
    const due = new Date(message.sentAt.getTime() + 15 * 60_000);
    mocks.policy.mockResolvedValue({
      followUpEnabled: true,
      followUpDelayMinutes: 15,
    });
    mocks.readRecovery.mockResolvedValue({
      ...recovery,
      status: "COMPLETED",
      outreachAttempts: [
        {
          ...attempt,
          status: "WAITING_FOR_RESPONSE",
          outboundMessageId: message.id,
          sentAt: message.sentAt,
          followUpDueAt: due,
        },
      ],
    });
    const { confirmed } = makeAdapter();
    await expect(
      confirmed({ recovery, attempt, message }),
    ).resolves.toMatchObject({ kind: "finalized" });
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it("returns exact-source holds before Support or recovery status mutation", async () => {
    mocks.settle.mockResolvedValueOnce({
      kind: "held",
      reason: "reservation-released",
    });
    const { confirmed } = makeAdapter();
    await expect(confirmed({ recovery, attempt, message })).resolves.toEqual({
      kind: "held",
      reason: "reservation-released",
    });
    expect(mocks.finalizeNotice).not.toHaveBeenCalled();
    expect(mocks.updateRecovery).not.toHaveBeenCalled();
  });
});
