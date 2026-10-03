import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    checkoutRecovery: { findUnique: vi.fn(), updateMany: vi.fn() },
    conversationMessage: { findFirst: vi.fn() },
    recoveryOutreachAttempt: { findUnique: vi.fn() },
  },
  lock: { withCheckoutLock: vi.fn() },
  outbound: { getProviderAccountId: vi.fn(), sendTemplate: vi.fn(), findExistingAdmission: vi.fn() },
  selector: { select: vi.fn() },
  eligibility: { evaluate: vi.fn() },
  attempt: {
    markNoResponseIfWaiting: vi.fn(),
    getOrCreate: vi.fn(),
    getOrCreateFollowUp: vi.fn(),
    markEngagedFromInbound: vi.fn(),
    markStatus: vi.fn(),
    markWaitingAfterConfirmedSend: vi.fn(),
  },
  policy: { resolve: vi.fn() },
  message: { buildRecoveryTemplateDescriptor: vi.fn() },
  followUp: { schedule: vi.fn() },
}));

vi.mock("../../../../src/lib/db.js", () => ({ default: mocks.prisma }));
vi.mock("../../../../src/services/pending-recovery-candidate.service.js", () => ({
  pendingRecoveryCandidateService: mocks.lock,
}));
vi.mock("../../../../src/services/outbound-whatsapp-admission.service.js", () => ({
  outboundWhatsAppAdmissionService: mocks.outbound,
}));
vi.mock("../../../../src/services/whatsapp-template-selector.service.js", () => ({
  whatsappTemplateSelectorService: mocks.selector,
}));
vi.mock("../../../../src/services/shop-execution-eligibility.service.js", () => ({
  shopExecutionEligibilityService: mocks.eligibility,
}));
vi.mock("../../../../src/services/recovery-outreach-attempt.service.js", () => ({
  recoveryOutreachAttemptService: mocks.attempt,
}));
vi.mock("../../../../src/services/recovery-policy.service.js", () => ({ recoveryPolicyService: mocks.policy }));
vi.mock("../../../../src/services/conversation.message.service.js", () => ({ conversationMessageService: mocks.message }));
vi.mock("../../../../src/services/recovery-outreach-follow-up.service.js", () => ({ recoveryOutreachFollowUpService: mocks.followUp }));

import type { RecoveryBillingService } from "../../../../src/services/recovery-billing.service.js";
import { RecoveryOutreachFinalizationService } from "../../../../src/services/checkout-recovery/recovery-outreach-finalization.service.js";
import { RecoveryOutreachFollowUpProcessorService } from "../../../../src/services/checkout-recovery/recovery-outreach-follow-up-processor.service.js";

const sentAt = new Date("2026-09-16T10:00:00Z");
const dueAt = new Date("2026-09-16T11:00:00Z");
const recovery = {
  id: "recovery-1",
  shopId: "shop-1",
  checkoutToken: "checkout-1",
  status: "MESSAGE_SENT",
  shop: { domain: "shop.test", status: "ACTIVE" },
  outreachAttempts: [{ id: "attempt-1", sequence: 1, status: "WAITING_FOR_RESPONSE", sentAt, followUpDueAt: dueAt }],
  conversation: { id: "conversation-1", languageTag: "fr-CA", countryCode: "CA" },
  customer: { phone: "+15551234567" },
};
const attempt = { id: "attempt-2", sequence: 2, followUpDueAt: null };
const admission = { kind: "paid", sourceKey: "recovery:shop-1:recovery-1" };
const confirmedMessage = { id: "message-2", conversationId: "conversation-1", status: "SENT", sentAt: new Date("2026-09-16T11:01:00Z") };

function createProcessor(billingOverrides: Partial<RecoveryBillingService> = {}) {
  const billing = {
    admit: vi.fn(async () => ({ kind: "admitted" as const, admission })),
    revalidateBeforeProvider: vi.fn(async () => ({ kind: "admitted" as const, admission })),
    releaseBeforeProvider: vi.fn(async () => undefined),
    handleProviderFailure: vi.fn(async () => undefined),
    commitSuccessfulInitiation: vi.fn(async () => undefined),
    ...billingOverrides,
  } as unknown as RecoveryBillingService;
  const finalizer = new RecoveryOutreachFinalizationService(billing);
  return { processor: new RecoveryOutreachFollowUpProcessorService(billing, finalizer), billing };
}

function setRecovery(value: unknown = recovery) {
  mocks.prisma.checkoutRecovery.findUnique
    .mockResolvedValueOnce({ shopId: "shop-1", checkoutToken: "checkout-1" })
    .mockResolvedValueOnce(value);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lock.withCheckoutLock.mockImplementation(async (_shopId, _checkoutToken, callback) => callback());
  mocks.prisma.checkoutRecovery.findUnique.mockResolvedValue(null);
  mocks.prisma.checkoutRecovery.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.conversationMessage.findFirst.mockResolvedValue(null);
  mocks.prisma.recoveryOutreachAttempt.findUnique.mockResolvedValue(null);
  mocks.outbound.getProviderAccountId.mockReturnValue("provider-1");
  mocks.outbound.sendTemplate.mockResolvedValue({ kind: "admitted" });
  mocks.outbound.findExistingAdmission.mockResolvedValue(confirmedMessage);
  mocks.selector.select.mockResolvedValue({ outcome: "selected", providerTemplateName: "follow_up", canonicalLanguageTag: "fr-CA", providerLanguageCode: "fr_CA" });
  mocks.eligibility.evaluate.mockResolvedValue({ allowed: true });
  mocks.attempt.markNoResponseIfWaiting.mockResolvedValue({ count: 1 });
  mocks.attempt.getOrCreate.mockResolvedValue({ id: "attempt-1", status: "NO_RESPONSE" });
  mocks.attempt.getOrCreateFollowUp.mockResolvedValue(attempt);
  mocks.attempt.markStatus.mockResolvedValue(undefined);
  mocks.attempt.markEngagedFromInbound.mockResolvedValue(undefined);
  mocks.attempt.markWaitingAfterConfirmedSend.mockResolvedValue({ count: 1 });
  mocks.policy.resolve.mockResolvedValue({});
  mocks.message.buildRecoveryTemplateDescriptor.mockReturnValue("follow-up-template");
});

describe("RecoveryOutreachFollowUpProcessorService", () => {
  it("suppresses a missing recovery before acquiring a checkout lock", async () => {
    const { processor } = createProcessor();

    await expect(processor.process("missing")).resolves.toEqual({ kind: "suppressed", reason: "missing-recovery" });

    expect(mocks.lock.withCheckoutLock).not.toHaveBeenCalled();
  });

  it("keeps due prerequisites ahead of terminal and engagement checks", async () => {
    const notDue = { ...recovery, outreachAttempts: [{ ...recovery.outreachAttempts[0], followUpDueAt: new Date("2999-01-01") }] };
    setRecovery(notDue);
    const { processor } = createProcessor();

    await expect(processor.process(recovery.id)).resolves.toEqual({ kind: "suppressed", reason: "not-due" });

    expect(mocks.prisma.conversationMessage.findFirst).not.toHaveBeenCalled();
    expect(mocks.attempt.markNoResponseIfWaiting).not.toHaveBeenCalled();
  });

  it("suppresses terminal recovery after due prerequisites", async () => {
    setRecovery({ ...recovery, status: "CANCELLED" });
    const { processor } = createProcessor();

    await expect(processor.process(recovery.id)).resolves.toEqual({ kind: "suppressed", reason: "terminal" });

    expect(mocks.prisma.conversationMessage.findFirst).not.toHaveBeenCalled();
  });

  it("suppresses only a waiting sequence-two attempt as already sent", async () => {
    setRecovery({ ...recovery, outreachAttempts: [...recovery.outreachAttempts, { sequence: 2, status: "WAITING_FOR_RESPONSE" }] });
    const { processor } = createProcessor();

    await expect(processor.process(recovery.id)).resolves.toEqual({ kind: "suppressed", reason: "already-sent" });

    expect(mocks.prisma.conversationMessage.findFirst).not.toHaveBeenCalled();
  });

  it("does not treat other sequence-two statuses as already sent", async () => {
    setRecovery({ ...recovery, outreachAttempts: [...recovery.outreachAttempts, { sequence: 2, status: "FAILED" }] });
    const { processor } = createProcessor();

    await expect(processor.process(recovery.id)).resolves.toEqual({ kind: "sent", attemptId: attempt.id });

    expect(mocks.prisma.conversationMessage.findFirst).toHaveBeenCalledOnce();
    expect(mocks.attempt.getOrCreateFollowUp).toHaveBeenCalledOnce();
  });

  it("detects inbound engagement before claiming no-response", async () => {
    setRecovery();
    mocks.prisma.conversationMessage.findFirst.mockResolvedValue({ createdAt: new Date("2026-09-16T10:30:00Z") });
    const { processor } = createProcessor();

    await expect(processor.process(recovery.id)).resolves.toEqual({ kind: "suppressed", reason: "engaged" });

    expect(mocks.attempt.markEngagedFromInbound).toHaveBeenCalledWith(recovery.id, expect.any(Date));
    expect(mocks.attempt.markNoResponseIfWaiting).not.toHaveBeenCalled();
  });

  it("converges a lost no-response CAS by rereading engagement state", async () => {
    setRecovery();
    mocks.attempt.markNoResponseIfWaiting.mockResolvedValue({ count: 0 });
    mocks.attempt.getOrCreate.mockResolvedValue({ id: "attempt-1", status: "ENGAGED" });
    const { processor } = createProcessor();

    await expect(processor.process(recovery.id)).resolves.toEqual({ kind: "suppressed", reason: "engaged" });

    expect(mocks.attempt.getOrCreate).toHaveBeenCalledWith({ recoveryId: recovery.id, sequence: 1, policy: {} });
    expect(mocks.attempt.getOrCreateFollowUp).not.toHaveBeenCalled();
  });

  it("cancels sequence two when shop execution is denied", async () => {
    setRecovery();
    mocks.eligibility.evaluate.mockResolvedValue({ allowed: false, reason: "SUBSCRIPTION_FROZEN" });
    const { processor } = createProcessor();

    await expect(processor.process(recovery.id)).resolves.toEqual({ kind: "suppressed", reason: "SUBSCRIPTION_FROZEN" });

    expect(mocks.attempt.markStatus).toHaveBeenCalledWith(attempt.id, "CANCELLED", { failureCode: "SUBSCRIPTION_FROZEN" });
    expect(mocks.selector.select).not.toHaveBeenCalled();
  });

  it("uses durable conversation locale and marks unavailable templates failed", async () => {
    setRecovery();
    mocks.selector.select.mockResolvedValue({ outcome: "template-unavailable" });
    const { processor } = createProcessor();

    await expect(processor.process(recovery.id)).resolves.toEqual({ kind: "suppressed", reason: "template-unavailable" });

    expect(mocks.selector.select).toHaveBeenCalledWith(expect.objectContaining({ languageTag: "fr-CA", countryCode: "CA" }));
    expect(mocks.attempt.markStatus).toHaveBeenCalledWith(attempt.id, "FAILED", { failureCode: "TEMPLATE_UNAVAILABLE" });
    expect(mocks.outbound.sendTemplate).not.toHaveBeenCalled();
  });

  it("marks initial admission blocks on the attempt without durable recovery blocking", async () => {
    setRecovery();
    const { processor } = createProcessor({ admit: vi.fn(async () => ({ kind: "blocked" as const, reason: "capacity-exhausted" })) });

    await expect(processor.process(recovery.id)).resolves.toEqual({ kind: "capacity-blocked", reason: "capacity-exhausted" });

    expect(mocks.attempt.markStatus).toHaveBeenCalledWith(attempt.id, "CAPACITY_BLOCKED", { failureCode: "capacity-exhausted" });
    expect(mocks.prisma.checkoutRecovery.updateMany).not.toHaveBeenCalled();
    expect(mocks.outbound.sendTemplate).not.toHaveBeenCalled();
  });

  it("marks revalidation blocks without releasing or durably blocking recovery", async () => {
    setRecovery();
    const { processor, billing } = createProcessor({
      revalidateBeforeProvider: vi.fn(async () => ({ kind: "blocked" as const, reason: "policy-changed" })),
    });

    await expect(processor.process(recovery.id)).resolves.toEqual({ kind: "capacity-blocked", reason: "policy-changed" });

    expect(mocks.attempt.markStatus).toHaveBeenCalledWith(attempt.id, "CAPACITY_BLOCKED", { failureCode: "policy-changed" });
    expect(billing.releaseBeforeProvider).not.toHaveBeenCalled();
    expect(mocks.prisma.checkoutRecovery.updateMany).not.toHaveBeenCalled();
  });

  it("routes provider failures through billing and marks the attempt failed", async () => {
    setRecovery();
    const error = new Error("provider unavailable");
    mocks.outbound.sendTemplate.mockRejectedValue(error);
    const { processor, billing } = createProcessor();

    await expect(processor.process(recovery.id)).rejects.toBe(error);

    expect(billing.handleProviderFailure).toHaveBeenCalledWith({ admission, error });
    expect(mocks.attempt.markStatus).toHaveBeenCalledWith(attempt.id, "FAILED", { failureCode: "PROVIDER_FAILURE" });
  });

  it("converges a duplicate only from a confirmed durable message", async () => {
    setRecovery();
    mocks.outbound.sendTemplate.mockResolvedValue({ kind: "suppressed", reason: "duplicate" });
    const { processor, billing } = createProcessor();

    await expect(processor.process(recovery.id)).resolves.toEqual({ kind: "sent", attemptId: attempt.id });

    expect(mocks.outbound.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: `recovery-outreach:${attempt.id}` }));
    expect(billing.commitSuccessfulInitiation).toHaveBeenCalledWith({ admission, recoveryId: recovery.id, occurredAt: confirmedMessage.sentAt });
    expect(mocks.attempt.markWaitingAfterConfirmedSend).toHaveBeenCalledWith(attempt.id, {
      sentAt: confirmedMessage.sentAt,
      outboundMessageId: confirmedMessage.id,
      followUpDueAt: null,
    });
  });

  it.each([
    ["pending", { ...confirmedMessage, status: "PENDING", sentAt: null }, /still pending/],
    ["missing", null, /has no durable message/],
  ])("does not converge duplicate %s durable admission", async (_label, durableMessage, expectedError) => {
    setRecovery();
    mocks.outbound.sendTemplate.mockResolvedValue({ kind: "suppressed", reason: "duplicate" });
    mocks.outbound.findExistingAdmission.mockResolvedValue(durableMessage);
    const { processor, billing } = createProcessor();

    await expect(processor.process(recovery.id)).rejects.toThrow(expectedError);

    expect(billing.handleProviderFailure).not.toHaveBeenCalled();
    expect(billing.commitSuccessfulInitiation).not.toHaveBeenCalled();
  });

  it("releases and marks non-confirmed durable duplicate messages as failed", async () => {
    setRecovery();
    mocks.outbound.sendTemplate.mockResolvedValue({ kind: "suppressed", reason: "duplicate" });
    mocks.outbound.findExistingAdmission.mockResolvedValue({ ...confirmedMessage, status: "FAILED", sentAt: null });
    const { processor, billing } = createProcessor();

    await expect(processor.process(recovery.id)).resolves.toEqual({ kind: "suppressed", reason: "duplicate" });

    expect(billing.releaseBeforeProvider).toHaveBeenCalledWith(admission);
    expect(mocks.attempt.markStatus).toHaveBeenCalledWith(attempt.id, "FAILED", { failureCode: "duplicate" });
    expect(billing.handleProviderFailure).not.toHaveBeenCalled();
  });

  it("finalizes a successful sequence-two send through the shared finalizer", async () => {
    setRecovery();
    const { processor, billing } = createProcessor();

    await expect(processor.process(recovery.id)).resolves.toEqual({ kind: "sent", attemptId: attempt.id });

    expect(mocks.attempt.markWaitingAfterConfirmedSend).toHaveBeenCalledWith(attempt.id, {
      sentAt: confirmedMessage.sentAt,
      outboundMessageId: confirmedMessage.id,
      followUpDueAt: null,
    });
    expect(billing.commitSuccessfulInitiation).toHaveBeenCalledBefore(mocks.attempt.markWaitingAfterConfirmedSend);
    expect(mocks.followUp.schedule).not.toHaveBeenCalled();
    expect(mocks.lock.withCheckoutLock).toHaveBeenCalledWith("shop-1", "checkout-1", expect.any(Function));
  });
});