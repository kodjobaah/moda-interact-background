import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    shop: { findUniqueOrThrow: vi.fn() },
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
  consent: { evaluateFirst: vi.fn(), evaluateReentry: vi.fn(), notifyMissingRecipient: vi.fn() },
  suppression: {
    evaluate: vi.fn(),
    deferDetectedRecovery: vi.fn(),
    clearDetectedSuppression: vi.fn(),
  },
}));

vi.mock("../../../../src/lib/db.js", () => ({ default: mocks.prisma }));
vi.mock("../../../../src/services/checkout-recovery/recovery-shopify-customer.service.js", () => ({
  recoveryShopifyCustomerService: { resolve: mocks.customer.resolveCustomer },
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
vi.mock("../../../../src/services/checkout-recovery/recovery-recipient-suppression-admission.service.js", () => ({
  recoveryRecipientSuppressionAdmissionService: mocks.suppression,
}));
vi.mock("../../../../src/services/checkout-recovery/recovery-consent-admission.service.js", () => ({
  recoveryConsentAdmissionService: mocks.consent,
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
const attempt = { id: "attempt-1", sequence: 1, recipient: "15551234567", followUpDueAt: null };
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
  return {
    service: new RecoveryInitiationService(billing, finalizer, ports),
    billing,
    finalizer,
    ports,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.customer.resolveCustomer.mockResolvedValue(null);
  mocks.prisma.shop.findUniqueOrThrow.mockResolvedValue({ id: "shop-1" });
  mocks.prisma.checkoutRecovery.findFirst.mockResolvedValue(recovery);
  mocks.consent.evaluateFirst.mockResolvedValue(true);
  mocks.consent.evaluateReentry.mockResolvedValue(true);
  mocks.consent.notifyMissingRecipient.mockResolvedValue(undefined);
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
    verifiedCategory: "MARKETING",
  });
  mocks.policy.resolve.mockResolvedValue({ followUpEnabled: false, followUpDelayMinutes: null });
  mocks.attempt.getOrCreate.mockResolvedValue(attempt);
  mocks.attempt.markStatus.mockResolvedValue(undefined);
  mocks.attempt.markWaitingAfterConfirmedSend.mockResolvedValue({ count: 1 });
  mocks.suppression.evaluate.mockResolvedValue({ kind: "allowed" });
  mocks.suppression.deferDetectedRecovery.mockResolvedValue(true);
  mocks.suppression.clearDetectedSuppression.mockResolvedValue(undefined);
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
  it("rejects a new checkout before recovery, attempt, billing and Meta when native opt-in is missing", async () => {
    mocks.prisma.checkoutRecovery.findFirst.mockResolvedValue(null);
    mocks.customer.resolveCustomer.mockResolvedValue({ id: "customer-1" });
    mocks.consent.evaluateFirst.mockResolvedValue(false);
    const { service, billing, ports } = createInitiation();

    await expect(service.handleCheckoutCreated(event)).resolves.toBeNull();

    expect(mocks.consent.evaluateFirst).toHaveBeenCalledWith(expect.objectContaining({
      shopId: "shop-1", checkoutToken: "checkout-1", recipient: "15551234567",
      customerId: "customer-1",
    }));
    expect(ports.upsertRecovery).not.toHaveBeenCalled();
    expect(mocks.attempt.getOrCreate).not.toHaveBeenCalled();
    expect(billing.admit).not.toHaveBeenCalled();
    expect(mocks.outbound.sendTemplate).not.toHaveBeenCalled();
  });

  it("verifies Shopify once for a new checkout then reads stored consent for first dispatch", async () => {
    mocks.prisma.checkoutRecovery.findFirst.mockResolvedValue(null);
    mocks.customer.resolveCustomer.mockResolvedValue({ id: "customer-1" });
    const { service, ports } = createInitiation();
    await service.handleCheckoutCreated({
      ...event,
      customer: { ...event.customer, shopifyCustomerId: "gid://shopify/Customer/1" },
    });
    expect(mocks.consent.evaluateFirst).toHaveBeenCalledOnce();
    expect(mocks.consent.evaluateReentry).toHaveBeenCalledTimes(2);
    expect(ports.upsertRecovery).toHaveBeenCalledOnce();
  });

  it("prevents legacy DETECTED first-send retries after STOP even if Shopify previously granted", async () => {
    mocks.consent.evaluateReentry.mockResolvedValue(false);
    const { service, billing, ports } = createInitiation();
    await service.handleCheckoutCreated(event);
    expect(mocks.consent.evaluateFirst).not.toHaveBeenCalled();
    expect(mocks.consent.evaluateReentry).toHaveBeenCalledOnce();
    expect(ports.upsertRecovery).not.toHaveBeenCalled();
    expect(mocks.attempt.getOrCreate).not.toHaveBeenCalled();
    expect(billing.admit).not.toHaveBeenCalled();
    expect(mocks.outbound.sendTemplate).not.toHaveBeenCalled();
  });

  it("blocks an existing DETECTED first-send if local no-contact arrives after the first stored check", async () => {
    // The first gate observes a grant; a concurrent STOP / merchant opt-out
    // reaches CustomerPhone before the post-upsert first-send check.
    mocks.consent.evaluateReentry.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { service, billing, ports } = createInitiation();

    await service.handleCheckoutCreated(event);

    expect(mocks.consent.evaluateFirst).not.toHaveBeenCalled();
    expect(mocks.consent.evaluateReentry).toHaveBeenCalledTimes(2);
    expect(ports.upsertRecovery).toHaveBeenCalledOnce();
    expect(mocks.attempt.getOrCreate).not.toHaveBeenCalled();
    expect(billing.admit).not.toHaveBeenCalled();
    expect(mocks.outbound.sendTemplate).not.toHaveBeenCalled();
    expect(mocks.followUp.schedule).not.toHaveBeenCalled();
  });

  it("never reuses the checkout's old phone grant for a changed current recipient", async () => {
    mocks.prisma.checkoutRecovery.findFirst.mockResolvedValue(null);
    mocks.customer.resolveCustomer.mockResolvedValue({ id: "customer-1" });
    mocks.consent.evaluateFirst.mockResolvedValueOnce(false);
    const { service, ports, billing } = createInitiation();

    await expect(service.handleCheckoutCreated({
      ...event,
      customer: { ...event.customer, shopifyCustomerId: "gid://shopify/Customer/123" },
    }, 1, "+44 7700 900002")).resolves.toBeNull();

    expect(mocks.consent.evaluateFirst).toHaveBeenCalledWith(expect.objectContaining({
      customerId: "customer-1",
      shopifyCustomerId: "gid://shopify/Customer/123",
      recipient: "447700900002",
    }));
    expect(ports.upsertRecovery).not.toHaveBeenCalled();
    expect(mocks.attempt.getOrCreate).not.toHaveBeenCalled();
    expect(billing.admit).not.toHaveBeenCalled();
    expect(mocks.outbound.sendTemplate).not.toHaveBeenCalled();
  });

  it("releases a reserved initial charge when consent is revoked before provider admission", async () => {
    // Pre-insert, post-upsert and pre-provider checks are three separate gates.
    // The revocation occurs only after the credit has been reserved.
    mocks.consent.evaluateReentry
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const { service, billing } = createInitiation();
    await service.handleCheckoutCreated(event);
    expect(billing.releaseBeforeProvider).toHaveBeenCalledWith(admission);
    expect(mocks.outbound.sendTemplate).not.toHaveBeenCalled();
    expect(mocks.attempt.markStatus).toHaveBeenCalledWith("attempt-1", "FAILED", {
      failureCode: "CONSENT_BLOCKED",
    });
  });

  it("does not create a first recovery during active recipient reachability suppression", async () => {
    mocks.prisma.checkoutRecovery.findFirst.mockResolvedValue(null);
    mocks.customer.resolveCustomer.mockResolvedValue({ id: "customer-1" });
    mocks.suppression.evaluate.mockResolvedValue({ kind: "suppressed", until: new Date("2026-10-24T00:00:00Z") });
    const { service, ports, billing } = createInitiation();
    await expect(service.handleCheckoutCreated(event)).resolves.toBeNull();
    expect(ports.upsertRecovery).not.toHaveBeenCalled();
    expect(billing.admit).not.toHaveBeenCalled();
    expect(mocks.suppression.deferDetectedRecovery).not.toHaveBeenCalled();
  });

  it("retries a technical Shopify verification failure without creating a recovery", async () => {
    mocks.prisma.checkoutRecovery.findFirst.mockResolvedValue(null);
    mocks.customer.resolveCustomer.mockResolvedValue({ id: "customer-1" });
    mocks.consent.evaluateFirst.mockRejectedValue(new Error("SHOPIFY_RECOVERY_CONSENT_RETRY_REQUIRED"));
    const { service, ports, billing } = createInitiation();
    await expect(service.handleCheckoutCreated(event)).rejects.toThrow("SHOPIFY_RECOVERY_CONSENT_RETRY_REQUIRED");
    expect(ports.upsertRecovery).not.toHaveBeenCalled();
    expect(billing.admit).not.toHaveBeenCalled();
  });

  it.each([undefined, "UTILITY"])("fails closed on unverified or utility template category (%s)", async (category) => {
    mocks.selector.select.mockResolvedValue({
      outcome: "selected", providerTemplateName: "checkout_recovery",
      canonicalLanguageTag: "en-GB", providerLanguageCode: "en_GB",
      ...(category ? { verifiedCategory: category } : {}),
    });
    const { service, billing } = createInitiation();
    await service.handleCheckoutCreated(event);
    expect(mocks.attempt.getOrCreate).not.toHaveBeenCalled();
    expect(billing.admit).not.toHaveBeenCalled();
    expect(mocks.outbound.sendTemplate).not.toHaveBeenCalled();
  });

  it("does not use the test recipient override in production", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousTestRecipient = process.env.TEST_WHATSAPP_RECIPIENT;
    process.env.NODE_ENV = "production";
    process.env.TEST_WHATSAPP_RECIPIENT = "15550000000";
    const { service } = createInitiation();

    try {
      expect(() => service.resolveRecipient({
        ...event,
        customer: { ...event.customer, phone: null },
      })).toThrow("TEST_WHATSAPP_RECIPIENT is only available in development or test");
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousTestRecipient === undefined) delete process.env.TEST_WHATSAPP_RECIPIENT;
      else process.env.TEST_WHATSAPP_RECIPIENT = previousTestRecipient;
    }
  });

  it("skips attempt, billable, and provider admission when the resume gate rejects", async () => {
    const { service, billing } = createInitiation();
    const admissionGate = vi.fn(async () => false);

    await service.handleCheckoutCreated(event, 1, undefined, undefined, admissionGate);

    expect(admissionGate).toHaveBeenCalledOnce();
    expect(mocks.attempt.getOrCreate).not.toHaveBeenCalled();
    expect(billing.admit).not.toHaveBeenCalled();
    expect(mocks.outbound.sendTemplate).not.toHaveBeenCalled();
  });

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

  it("defers an actively suppressed recipient before attempt, billing, or provider admission", async () => {
    const until = new Date("2026-10-12T00:00:00Z");
    mocks.suppression.evaluate.mockResolvedValue({ kind: "suppressed", until });
    const { service, billing } = createInitiation();

    await service.handleCheckoutCreated(event);

    expect(mocks.suppression.evaluate).toHaveBeenCalledWith("shop-1", "15551234567");
    expect(mocks.suppression.deferDetectedRecovery).toHaveBeenCalledWith(recovery.id, "shop-1", until, undefined);
    expect(mocks.attempt.getOrCreate).not.toHaveBeenCalled();
    expect(billing.admit).not.toHaveBeenCalled();
    expect(mocks.outbound.sendTemplate).not.toHaveBeenCalled();
  });

  it("keeps active suppression non-billable when expiry enqueue fails", async () => {
    const enqueueError = new Error("queue unavailable");
    mocks.suppression.evaluate.mockResolvedValue({
      kind: "suppressed",
      until: new Date("2026-10-12T00:00:00Z"),
    });
    mocks.suppression.deferDetectedRecovery.mockRejectedValue(enqueueError);
    const { service, billing } = createInitiation();

    await expect(service.handleCheckoutCreated(event)).rejects.toBe(enqueueError);

    expect(mocks.suppression.deferDetectedRecovery).toHaveBeenCalledOnce();
    expect(mocks.attempt.getOrCreate).not.toHaveBeenCalled();
    expect(billing.admit).not.toHaveBeenCalled();
    expect(mocks.outbound.sendTemplate).not.toHaveBeenCalled();
  });

  it("checks a changed current phone against its independent suppression key", async () => {
    const { service, billing } = createInitiation();
    mocks.suppression.evaluate.mockResolvedValue({
      kind: "suppressed",
      until: new Date("2026-10-12T00:00:00Z"),
    });

    await service.handleCheckoutCreated(event, 1, "447700900123");

    expect(mocks.suppression.evaluate).toHaveBeenCalledWith("shop-1", "447700900123");
    expect(mocks.suppression.deferDetectedRecovery).toHaveBeenCalledWith(
      recovery.id,
      "shop-1",
      expect.any(Date),
      undefined,
    );
    expect(mocks.attempt.getOrCreate).not.toHaveBeenCalled();
    expect(billing.admit).not.toHaveBeenCalled();
    expect(mocks.outbound.sendTemplate).not.toHaveBeenCalled();
  });

  it("passes the targeted wake-up lineage into the next suppression deferral", async () => {
    const until = new Date("2026-10-12T00:00:00Z");
    const wakeupTrigger = "recipient-suppression-recovery-1-1791763200000";
    mocks.suppression.evaluate.mockResolvedValue({ kind: "suppressed", until });
    const { service, billing } = createInitiation();

    await service.handleCheckoutCreated(event, 1, "15551234567", wakeupTrigger);

    expect(mocks.suppression.deferDetectedRecovery).toHaveBeenCalledWith(
      recovery.id,
      "shop-1",
      until,
      wakeupTrigger,
    );
    expect(mocks.attempt.getOrCreate).not.toHaveBeenCalled();
    expect(billing.admit).not.toHaveBeenCalled();
    expect(mocks.outbound.sendTemplate).not.toHaveBeenCalled();
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
    expect(mocks.attempt.getOrCreate).toHaveBeenCalledWith(expect.objectContaining({
      recipient: "15551234567",
    }));
    expect(mocks.outbound.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      to: attempt.recipient,
    }));
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

  it("persists and sends the exact canonical BACKGROUND-007 recipient", async () => {
    const { service } = createInitiation();

    await service.handleCheckoutCreated(event, 1, "+1 (555) 123-4567");

    expect(mocks.attempt.getOrCreate).toHaveBeenCalledWith(expect.objectContaining({
      recipient: "15551234567",
    }));
    expect(mocks.outbound.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      to: "15551234567",
    }));
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
