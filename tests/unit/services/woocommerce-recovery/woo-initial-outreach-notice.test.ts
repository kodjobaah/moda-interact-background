import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dependencies: undefined as { finalize: { confirmed(input: any): Promise<void> } } | undefined,
  commit: vi.fn(),
  finalizeNotice: vi.fn(),
  findConversation: vi.fn(),
  updateRecovery: vi.fn(),
}));

vi.mock("../../../../src/lib/db.js", () => ({
  default: {
    conversation: { findUnique: mocks.findConversation },
    checkoutRecovery: { updateMany: mocks.updateRecovery },
  },
}));
vi.mock("../../../../src/services/recovery-billing.service.js", () => ({
  recoveryBillingService: { commitSuccessfulInitiation: mocks.commit },
}));
vi.mock("../../../../src/services/checkout-recovery/recovery-initial-outreach-support-notice.service.js", () => ({
  recoveryInitialOutreachSupportNoticeService: { finalizeConfirmedInitial: mocks.finalizeNotice },
}));
vi.mock("../../../../src/services/woocommerce-recovery/woo-recovery-outreach.service.js", () => ({
  WooRecoveryOutreachService: class {
    constructor(dependencies: typeof mocks.dependencies) { mocks.dependencies = dependencies; }
  },
}));
vi.mock("../../../../src/services/checkout-recovery/recovery-recipient-resolver.service.js", () => ({ recoveryRecipientResolverService: {} }));
vi.mock("../../../../src/services/recovery-outreach-attempt.service.js", () => ({ recoveryOutreachAttemptService: { getOrCreate: vi.fn() } }));
vi.mock("../../../../src/services/recovery-policy.service.js", () => ({ recoveryPolicyService: {} }));
vi.mock("../../../../src/services/conversation.service.js", () => ({ conversationService: {} }));
vi.mock("../../../../src/services/recovery-template-integration/automated-recovery-template.service.js", () => ({ automatedRecoveryTemplateService: {} }));
vi.mock("../../../../src/services/woocommerce-recovery-consent.service.js", () => ({ wooRecoveryConsentReader: {} }));
vi.mock("../../../../src/services/whatsapp-provider-rejection.js", () => ({ isSynchronousRecipientFailure: vi.fn() }));

import { createWooRecoveryOutreachService } from "../../../../src/services/woocommerce-recovery/woo-recovery-outreach.adapters.js";

const recovery = { id: "recovery-1", shopId: "shop-1" } as any;
const attempt = { id: "attempt-1", sequence: 1, followUpDueAt: null } as any;
const message = {
  id: "message-1", conversationId: "conversation-1", status: "SENT",
  sentAt: new Date("2026-10-27T10:00:00.000Z"),
} as any;
const admission = { sourceKey: "durable-admission-1" } as any;

function makeAdapter(logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), child: vi.fn() }) {
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
    mocks.commit.mockResolvedValue(undefined);
    mocks.finalizeNotice.mockResolvedValue({ outcome: "created", outreachAttemptId: attempt.id });
    mocks.updateRecovery.mockResolvedValue({ count: 1 });
  });

  it.each(["created", "disabled", "replayed"] as const)(
    "accepts the shared finalizer's %s outcome and updates Woo recovery state",
    async (outcome) => {
      mocks.finalizeNotice.mockResolvedValue({ outcome, outreachAttemptId: attempt.id });
      const { confirmed } = makeAdapter();
      await confirmed({ recovery, attempt, message, admission });

      expect(mocks.commit).toHaveBeenCalledWith({
        admission, recoveryId: recovery.id, occurredAt: message.sentAt,
      });
      expect(mocks.finalizeNotice).toHaveBeenCalledWith({
        shopId: recovery.shopId,
        checkoutRecoveryId: recovery.id,
        outreachAttemptId: attempt.id,
        outboundMessageId: message.id,
        sentAt: message.sentAt,
        followUpDueAt: null,
      });
      expect(mocks.updateRecovery).toHaveBeenCalledWith({
        where: { id: recovery.id, shopId: recovery.shopId, status: "DETECTED" },
        data: {
          status: "MESSAGE_SENT", messageSentAt: message.sentAt,
          admissionBlockedAt: null, admissionBlockReason: null,
        },
      });
    },
  );

  it.each(["billing", "support_notice", "recovery_status"] as const)(
    "logs %s failures and rethrows the original error even if the logger throws",
    async (stage) => {
    const original = new Error(`${stage} failed`);
    if (stage === "billing") mocks.commit.mockRejectedValueOnce(original);
    if (stage === "support_notice") mocks.finalizeNotice.mockRejectedValueOnce(original);
    if (stage === "recovery_status") mocks.updateRecovery.mockRejectedValueOnce(original);
    const logger = { error: vi.fn(() => { throw new Error("sink failed"); }), info: vi.fn(), warn: vi.fn(), child: vi.fn() };
    const { confirmed } = makeAdapter(logger);

    await expect(confirmed({ recovery, attempt, message, admission })).rejects.toBe(original);
    expect(logger.error).toHaveBeenCalledWith(
      "recovery.initial_outreach_support_notice.woocommerce_finalization_failed",
      {
        shopId: recovery.shopId,
        checkoutRecoveryId: recovery.id,
        outreachAttemptId: attempt.id,
        outboundMessageId: message.id,
        stage,
        error: original,
      },
    );
    },
  );

  it("keeps the follow-up and conversation ownership guards ahead of finalization", async () => {
    const { confirmed } = makeAdapter();
    await expect(confirmed({ recovery, attempt: { ...attempt, sequence: 2 }, message, admission }))
      .rejects.toThrow("WOO_FOLLOW_UP_NOT_ALLOWED");
    await expect(confirmed({ recovery, attempt: { ...attempt, followUpDueAt: new Date() }, message, admission }))
      .rejects.toThrow("WOO_FOLLOW_UP_NOT_ALLOWED");
    await expect(confirmed({ recovery, attempt, message: { ...message, conversationId: "other" }, admission }))
      .rejects.toThrow("WOO_INITIAL_MESSAGE_CONVERSATION_MISMATCH");
    expect(mocks.finalizeNotice).not.toHaveBeenCalled();
    expect(mocks.updateRecovery).not.toHaveBeenCalled();
  });
});
