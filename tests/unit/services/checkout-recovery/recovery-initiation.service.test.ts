import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    checkoutRecovery: {
      update: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    recoveryOutreachAttempt: { findUnique: vi.fn() },
  },
  customer: { resolveCustomer: vi.fn() },
  conversation: { getOrCreateRecoveryConversation: vi.fn() },
  message: { buildRecoveryTemplateDescriptor: vi.fn() },
  outbound: {
    getProviderAccountId: vi.fn(),
    sendTemplate: vi.fn(),
    findExistingAdmission: vi.fn(),
  },
  selector: { select: vi.fn() },
  policy: { resolve: vi.fn() },
  attempt: {
    getOrCreate: vi.fn(),
    markStatus: vi.fn(),
    markWaitingAfterConfirmedSend: vi.fn(),
  },
  followUp: { schedule: vi.fn() },
}));

vi.mock("../../../../src/lib/db.js", () => ({ default: mocks.prisma }));
vi.mock("../../../../src/services/customer.service.js", () => ({
  customerService: mocks.customer,
}));
vi.mock("../../../../src/services/conversation.service.js", () => ({
  conversationService: mocks.conversation,
}));
vi.mock("../../../../src/services/conversation.message.service.js", () => ({
  conversationMessageService: mocks.message,
}));
vi.mock("../../../../src/services/outbound-whatsapp-admission.service.js", () => ({
  outboundWhatsAppAdmissionService: mocks.outbound,
}));
vi.mock("../../../../src/services/whatsapp-template-selector.service.js", () => ({
  whatsappTemplateSelectorService: mocks.selector,
}));
vi.mock("../../../../src/services/recovery-policy.service.js", () => ({
  recoveryPolicyService: mocks.policy,
}));
vi.mock("../../../../src/services/recovery-outreach-attempt.service.js", () => ({
  recoveryOutreachAttemptService: mocks.attempt,
}));
vi.mock("../../../../src/services/recovery-outreach-follow-up.service.js", () => ({
  recoveryOutreachFollowUpService: mocks.followUp,
}));

import type { RecoveryBillingService } from "../../../../src/services/recovery-billing.service.js";
import { RecoveryInitiationService } from "../../../../src/services/checkout-recovery/recovery-initiation.service.js";
import { RecoveryOutreachFinalizationService } from "../../../../src/services/checkout-recovery/recovery-outreach-finalization.service.js";
import { findLatestRecovery } from "../../../../src/services/checkout-recovery/latest-recovery.js";

const recovery = {
  id: "recovery-1",
  shopId: "shop-1",
  status: "DETECTED",
  customerId: null,
};
const attempt = { id: "attempt-1", sequence: 1, followUpDueAt: null };
const admission = { kind: "paid", sourceKey: "recovery:shop-1:recovery-1" };
const sentAt = new Date("2026-09-16T10:00:00Z");
const confirmedMessage = {
  id: "message-1",
  conversationId: "conversation-1",
  status: "SENT",
  sentAt,
};
const event = {
  shop: "shop.myshopify.com",
  checkoutToken: "checkout-1",
  customer: { phone: "+15551234567" },
  internationalContext: { countryCode: "US" },
} as any;

function createInitiation(overrides: {
  recovery?: typeof recovery;
  billing?: Partial<RecoveryBillingService>;
} = {}) {
  const billing = {
    admit: vi.fn(async () => ({ kind: "admitted" as const, admission })),
    revalidateBeforeProvider: vi.fn(async () => ({ kind: "admitted" as const, admission })),
    releaseBeforeProvider: vi.fn(async () => undefined),
    handleProviderFailure: vi.fn(async () => undefined),
    commitSuccessfulInitiation: vi.fn(async () => undefined),
    ...overrides.billing,
  } as unknown as RecoveryBillingService;
  const finalizer = new RecoveryOutreachFinalizationService(billing);
  const ports = {
    upsertRecovery: vi.fn(async () => overrides.recovery ?? recovery),
    resolveRecipient: vi.fn(() => "+15551234567"),
    markRecoveryCapacityBlocked: vi.fn(async () => undefined),
  };
  return { service: new RecoveryInitiationService(billing, finalizer, ports), billing, finalizer, ports };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.customer.resolveCustomer.mockResolvedValue(null);
  mocks.prisma.checkoutRecovery.update.mockResolvedValue(recovery);
  mocks.prisma.checkoutRecovery.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.checkoutRecovery.findUnique.mockResolvedValue(null);
  mocks.prisma.recoveryOutreachAttempt.findUnique.mockResolvedValue(null);
  mocks.conversation.getOrCreateRecoveryConversation.mockResolvedValue({ id: "conversation-1" });
  mocks.message.buildRecoveryTemplateDescriptor.mockReturnValue("template-content");
  mocks.outbound.getProviderAccountId.mockReturnValue("provider-1");
  mocks.outbound.sendTemplate.mockResolvedValue({ kind: "admitted" });
  mocks.outbound.findExistingAdmission.mockResolvedValue(confirmedMessage);
  mocks.selector.select.mockResolvedValue({
    outcome: "selected",
    providerTemplateName: "checkout_recovery",
    canonicalLanguageTag: "en-US",
    providerLanguageCode: "en_US",
  });
  mocks.policy.resolve.mockResolvedValue({ followUpEnabled: false, followUpDelayMinutes: null });
  mocks.attempt.getOrCreate.mockResolvedValue(attempt);
  mocks.attempt.markStatus.mockResolvedValue(undefined);
  mocks.attempt.markWaitingAfterConfirmedSend.mockResolvedValue({ count: 1 });
});

describe("findLatestRecovery", () => {
  it("uses generation then id descending as the latest-generation tie-breaker", async () => {
    await findLatestRecovery("shop-1", "checkout-1");

    expect(mocks.prisma.checkoutRecovery.findFirst).toHaveBeenCalledWith({
      where: { shopId: "shop-1", checkoutToken: "checkout-1" },
      orderBy: [{ generation: "desc" }, { id: "desc" }],
    });
  });
});

describe("RecoveryInitiationService", () => {
  it("durably blocks capacity-exhausted admissions without a failure code", async () => {
    const { service, billing, ports } = createInitiation({
      billing: { admit: vi.fn(async () => ({ kind: "blocked" as const, reason: "capacity-exhausted" })) },
    });

    await service.handleCheckoutCreated(event);

    expect(ports.markRecoveryCapacityBlocked).toHaveBeenCalledWith(recovery.id);
    expect(mocks.attempt.markStatus).toHaveBeenCalledWith(attempt.id, "CAPACITY_BLOCKED");
    expect(mocks.outbound.sendTemplate).not.toHaveBeenCalled();
    expect(billing.releaseBeforeProvider).not.toHaveBeenCalled();
  });

  it("releases admission when conversation creation fails before provider send", async () => {
    const error = new Error("conversation unavailable");
    mocks.conversation.getOrCreateRecoveryConversation.mockRejectedValue(error);
    const { service, billing } = createInitiation();

    await expect(service.handleCheckoutCreated(event)).rejects.toBe(error);

    expect(billing.releaseBeforeProvider).toHaveBeenCalledWith(admission);
    expect(mocks.outbound.sendTemplate).not.toHaveBeenCalled();
  });

  it("marks revalidation blocks without durably blocking recovery or releasing admission", async () => {
    const { service, billing, ports } = createInitiation({
      billing: {
        revalidateBeforeProvider: vi.fn(async () => ({ kind: "blocked" as const, reason: "policy-changed" })),
      },
    });

    await service.handleCheckoutCreated(event);

    expect(mocks.attempt.markStatus).toHaveBeenCalledWith(attempt.id, "CAPACITY_BLOCKED", {
      failureCode: "policy-changed",
    });
    expect(ports.markRecoveryCapacityBlocked).not.toHaveBeenCalled();
    expect(billing.releaseBeforeProvider).not.toHaveBeenCalled();
    expect(mocks.outbound.sendTemplate).not.toHaveBeenCalled();
  });

  it("routes provider errors through billing failure handling and marks the attempt failed", async () => {
    const error = new Error("provider unavailable");
    mocks.outbound.sendTemplate.mockRejectedValue(error);
    const { service, billing } = createInitiation();

    await expect(service.handleCheckoutCreated(event)).rejects.toBe(error);

    expect(billing.handleProviderFailure).toHaveBeenCalledWith({ admission, error });
    expect(mocks.attempt.markStatus).toHaveBeenCalledWith(attempt.id, "FAILED", {
      failureCode: "PROVIDER_FAILURE",
    });
  });

  it("finalizes a duplicate only when its durable message is confirmed", async () => {
    mocks.outbound.sendTemplate.mockResolvedValue({ kind: "suppressed", reason: "duplicate" });
    const { service, billing } = createInitiation();

    await service.handleCheckoutCreated(event);

    expect(billing.commitSuccessfulInitiation).toHaveBeenCalledWith({
      admission,
      recoveryId: recovery.id,
      occurredAt: sentAt,
    });
    expect(mocks.attempt.markWaitingAfterConfirmedSend).toHaveBeenCalledWith(attempt.id, {
      sentAt,
      outboundMessageId: confirmedMessage.id,
      followUpDueAt: null,
    });
  });

  it.each([
    ["pending", { id: "message-1", conversationId: "conversation-1", status: "PENDING", sentAt: null }, /still pending/],
    ["missing", null, /has no durable message/],
  ])("keeps duplicate %s admission non-convergent", async (_label, durableMessage, expectedError) => {
    mocks.outbound.sendTemplate.mockResolvedValue({ kind: "suppressed", reason: "duplicate" });
    mocks.outbound.findExistingAdmission.mockResolvedValue(durableMessage);
    const { service, billing } = createInitiation();

    await expect(service.handleCheckoutCreated(event)).rejects.toThrow(expectedError);

    expect(billing.commitSuccessfulInitiation).not.toHaveBeenCalled();
    expect(billing.releaseBeforeProvider).not.toHaveBeenCalled();
    expect(mocks.attempt.markStatus).not.toHaveBeenCalled();
  });

  it("finalizes successful sends and transitions the recovery using provider sentAt", async () => {
    const { service, billing } = createInitiation();

    await service.handleCheckoutCreated(event);

    expect(billing.commitSuccessfulInitiation).toHaveBeenCalledWith({
      admission,
      recoveryId: recovery.id,
      occurredAt: sentAt,
    });
    expect(mocks.prisma.checkoutRecovery.updateMany).toHaveBeenCalledWith({
      where: { id: recovery.id, status: "DETECTED" },
      data: {
        status: "MESSAGE_SENT",
        messageSentAt: sentAt,
        admissionBlockedAt: null,
        admissionBlockReason: null,
      },
    });
  });

  it("repairs initial follow-up scheduling for an already-sent recovery", async () => {
    const dueAt = new Date("2026-09-17T10:00:00Z");
    mocks.prisma.checkoutRecovery.findUnique.mockResolvedValue({
      ...recovery,
      status: "MESSAGE_SENT",
      outreachAttempts: [{
        sequence: 1,
        status: "WAITING_FOR_RESPONSE",
        sentAt,
        followUpDueAt: dueAt,
        customerRespondedAt: null,
      }],
    });
    const { service } = createInitiation({ recovery: { ...recovery, status: "MESSAGE_SENT" } });

    await service.handleCheckoutCreated(event);

    expect(mocks.followUp.schedule).toHaveBeenCalledWith(
      { checkoutRecoveryId: recovery.id, sequence: 2 },
      dueAt,
    );
  });
});
