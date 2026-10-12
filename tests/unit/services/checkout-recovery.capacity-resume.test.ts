import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  recovery: {
    id: "recovery-1",
    shopId: "shop-1",
    checkoutToken: "checkout-1",
    cartToken: null,
    checkoutUrl: "https://checkout",
    detectedAt: new Date("2026-09-01T00:00:00.000Z"),
    status: "DETECTED",
    admissionBlockReason: "RECOVERY_CAPACITY_EXHAUSTED",
    customerId: "customer-1",
    shop: { domain: "shop.example", status: "ACTIVE" },
  },
  lookup: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  txUpdateMany: vi.fn(),
  historyCreate: vi.fn(),
  transaction: vi.fn(),
  attemptGetOrCreate: vi.fn(),
  suppressionEvaluate: vi.fn(),
  policyResolve: vi.fn(),
  selectorSelect: vi.fn(),
  outboundGetProviderAccountId: vi.fn(),
  outboundSendTemplate: vi.fn(),
  resumeSchedule: vi.fn(),
  snapshotBuild: vi.fn(),
  serializeLineItems: vi.fn(),
  withCheckoutLock: vi.fn(
    async (
      _shopId: string,
      _checkoutToken: string,
      callback: () => Promise<unknown>,
    ) => callback(),
  ),
  evaluate: vi.fn(async () => ({ allowed: true as const, shopId: "shop-1" })),
}));

vi.mock("../../../src/lib/db.js", () => ({
  default: {
    shop: {
      findUnique: vi.fn(async () => ({
        id: "shop-1",
        settings: null,
      })),
    },
    checkoutRecovery: {
      findUnique: hoisted.findUnique,
      update: hoisted.update,
      updateMany: hoisted.updateMany,
    },
    whatsAppRecipientReachability: {
      findUnique: vi.fn(async () => null),
    },
    $transaction: hoisted.transaction,
  },
}));
vi.mock("../../../src/services/customer.service.js", () => ({
  customerService: { resolveCustomer: vi.fn(async () => ({ id: "customer-1" })) },
}));
vi.mock("../../../src/services/customer.phone.service.js", () => ({
  customerPhoneService: {
    getCurrentPhone: vi.fn(async () => ({ phone: "+15551234567" })),
    getCurrentPhoneForShop: vi.fn(async () => ({ phone: "+15551234567" })),
  },
}));
vi.mock("../../../src/services/checkout-recovery/recovery-recipient-resolver.service.js", () => ({
  recoveryRecipientResolverService: {
    resolve: vi.fn(async () => "15551234567"),
    resolveForCustomerInShop: vi.fn(async () => "15551234567"),
  },
}));
vi.mock("../../../src/services/conversation.service.js", () => ({
  conversationService: {},
}));
vi.mock("../../../src/services/conversation.message.service.js", () => ({
  conversationMessageService: {},
}));
vi.mock("../../../src/services/outbound-whatsapp-admission.service.js", () => ({
  outboundWhatsAppAdmissionService: {
    getProviderAccountId: hoisted.outboundGetProviderAccountId,
    sendTemplate: hoisted.outboundSendTemplate,
  },
}));
vi.mock("../../../src/services/whatsapp-template-selector.service.js", () => ({
  whatsappTemplateSelectorService: { select: hoisted.selectorSelect },
}));
vi.mock("../../../src/services/recovery-outreach-attempt.service.js", () => ({
  recoveryOutreachAttemptService: { getOrCreate: hoisted.attemptGetOrCreate },
}));
vi.mock("../../../src/services/recovery-policy.service.js", () => ({
  recoveryPolicyService: { resolve: hoisted.policyResolve },
}));
vi.mock("../../../src/services/checkout-recovery/recovery-recipient-suppression-admission.service.js", () => ({
  recoveryRecipientSuppressionAdmissionService: {
    evaluate: hoisted.suppressionEvaluate,
    deferDetectedRecovery: vi.fn(),
    clearDetectedSuppression: vi.fn(),
  },
}));
vi.mock("../../../src/services/checkout-recovery/recovery-snapshot-builder.service.js", () => ({
  recoverySnapshotBuilderService: {
    build: hoisted.snapshotBuild,
    serializeLineItems: hoisted.serializeLineItems,
  },
}));
vi.mock("../../../src/services/recovery-capacity-resume.service.js", () => ({
  recoveryCapacityResumeService: { schedule: hoisted.resumeSchedule },
}));
vi.mock("../../../src/services/pending-recovery-candidate.service.js", () => ({
  pendingRecoveryCandidateService: {
    withCheckoutLock: hoisted.withCheckoutLock,
  },
}));
vi.mock("../../../src/services/shop-execution-eligibility.service.js", () => ({
  shopExecutionEligibilityService: { evaluate: hoisted.evaluate },
}));
vi.mock("../../../src/services/abandoned-checkout-lookup.service.js", () => ({
  abandonedCheckoutLookupService: { lookup: hoisted.lookup },
}));

import { CheckoutRecoveryService } from "../../../src/services/checkout-recovery.service.js";

const currentBlockedRecovery = {
  id: "recovery-1",
  status: "DETECTED",
  admissionBlockReason: "RECOVERY_CAPACITY_EXHAUSTED",
  checkoutToken: "checkout-1",
  cartToken: null,
  checkoutUrl: "https://checkout",
  detectedAt: new Date("2026-09-01T00:00:00.000Z"),
};

const freshCheckout = {
  createdAt: "2026-09-01T00:00:00.000Z",
  completedAt: null,
  currencyCode: "GBP",
  totalPrice: "42.00",
  abandonedCheckoutUrl: "https://checkout/current",
  customer: null,
  lineItems: [],
  internationalContext: null,
};

function foundCheckout(
  overrides: Partial<typeof freshCheckout> = {},
) {
  return {
    kind: "found" as const,
    checkout: { ...freshCheckout, ...overrides },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.findUnique.mockReset().mockResolvedValue(hoisted.recovery);
  hoisted.attemptGetOrCreate.mockReset().mockResolvedValue({ id: "attempt-1" });
  hoisted.suppressionEvaluate.mockReset().mockResolvedValue({ kind: "allowed" });
  hoisted.policyResolve.mockReset().mockResolvedValue({ recoveryDelayMinutes: 30 });
  hoisted.selectorSelect.mockReset().mockResolvedValue({
    outcome: "selected",
    providerTemplateName: "recovery",
    canonicalLanguageTag: "en",
    providerLanguageCode: "en",
  });
  hoisted.outboundGetProviderAccountId.mockReset().mockReturnValue("provider-1");
  hoisted.outboundSendTemplate.mockReset();
  hoisted.resumeSchedule.mockReset().mockResolvedValue("resume-job");
  hoisted.snapshotBuild.mockReset().mockResolvedValue({
    shop: "shop.example",
    checkoutToken: "checkout-1",
    customer: { phone: "+15551234567" },
    detectedAt: "2026-09-01T00:00:00.000Z",
    lastExternalActivityAt: "2026-09-01T00:00:00.000Z",
    checkoutUrl: "https://checkout/current",
    totalPrice: "42.00",
    currency: "GBP",
    lineItems: [],
    completedAt: null,
  });
  hoisted.serializeLineItems.mockReturnValue([]);
  hoisted.evaluate.mockResolvedValue({ allowed: true, shopId: "shop-1" });
  hoisted.txUpdateMany.mockResolvedValue({ count: 1 });
  hoisted.historyCreate.mockResolvedValue({ id: "history-1" });
  hoisted.transaction.mockImplementation(
    async (
      callback: (transaction: {
        checkoutRecovery: { updateMany: typeof hoisted.txUpdateMany };
        checkoutRecoveryStatusHistory: { create: typeof hoisted.historyCreate };
      }) => Promise<unknown>,
    ) =>
      callback({
        checkoutRecovery: { updateMany: hoisted.txUpdateMany },
        checkoutRecoveryStatusHistory: { create: hoisted.historyCreate },
      }),
  );
});

describe("CheckoutRecoveryService capacity resume", () => {
  it("forwards the production admission gate and defers newer activity before outreach attempt creation", async () => {
    const initialActivity = new Date(Date.now() - 60 * 60_000);
    const newerActivity = new Date();
    hoisted.recovery.lastExternalActivityAt = initialActivity;
    hoisted.recovery.generation = 1;
    hoisted.findUnique.mockImplementation(async () => hoisted.recovery);
    hoisted.lookup.mockResolvedValueOnce(foundCheckout());
    hoisted.updateMany.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(hoisted.recovery, data);
      return { count: 1 };
    });
    hoisted.withCheckoutLock.mockImplementation(async (_shopId, _checkoutToken, callback) => callback());
    hoisted.transaction.mockImplementation(async (callback) => callback({
      checkoutRecovery: { updateMany: hoisted.txUpdateMany },
      checkoutRecoveryStatusHistory: { create: hoisted.historyCreate },
    } as never));
    hoisted.txUpdateMany.mockResolvedValue({ count: 1 });
    const billing = {
      admit: vi.fn(async () => ({ kind: "blocked" as const, reason: "test-blocked" })),
      revalidateBeforeProvider: vi.fn(),
      releaseBeforeProvider: vi.fn(),
      handleProviderFailure: vi.fn(),
      commitSuccessfulInitiation: vi.fn(),
    } as never;
    const service = new CheckoutRecoveryService(billing);
    vi.spyOn(service, "upsertRecovery").mockResolvedValue(hoisted.recovery as never);
    hoisted.suppressionEvaluate.mockImplementationOnce(async () => {
      await service.recordExternalActivity("recovery-1", newerActivity);
      return { kind: "allowed" };
    });

    await expect(
      service.resumeCapacityBlockedRecovery(
        "recovery-1",
        `recipient-suppression-recovery-1-checkout-update-${initialActivity.getTime()}`,
      ),
    ).resolves.toEqual({
      kind: "deferred-activity",
      dueAt: new Date(newerActivity.getTime() + 30 * 60_000),
    });

    expect(hoisted.attemptGetOrCreate).not.toHaveBeenCalled();
    expect(billing.admit).not.toHaveBeenCalled();
    expect(hoisted.outboundSendTemplate).not.toHaveBeenCalled();
    expect(hoisted.resumeSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ recoveryId: "recovery-1" }),
      new Date(newerActivity.getTime() + 30 * 60_000),
    );
  });

  it("stops capacity resume before provider lookup when subscription is frozen", async () => {
    hoisted.findUnique.mockResolvedValueOnce(hoisted.recovery);
    hoisted.evaluate.mockResolvedValueOnce({
      allowed: false,
      shopId: "shop-1",
      reason: "SUBSCRIPTION_FROZEN",
    });

    await expect(
      new CheckoutRecoveryService().resumeCapacityBlockedRecovery("recovery-1"),
    ).resolves.toEqual({ kind: "ignored", reason: "SUBSCRIPTION_FROZEN" });

    expect(hoisted.withCheckoutLock).not.toHaveBeenCalled();
    expect(hoisted.lookup).not.toHaveBeenCalled();
  });

  it("rechecks capacity resume after checkout-lock acquisition", async () => {
    hoisted.findUnique
      .mockResolvedValueOnce(hoisted.recovery)
      .mockResolvedValueOnce(currentBlockedRecovery);
    hoisted.evaluate
      .mockResolvedValueOnce({ allowed: true, shopId: "shop-1" })
      .mockResolvedValueOnce({
        allowed: false,
        shopId: "shop-1",
        reason: "SUBSCRIPTION_FROZEN",
      });

    await expect(
      new CheckoutRecoveryService().resumeCapacityBlockedRecovery("recovery-1"),
    ).resolves.toEqual({ kind: "ignored", reason: "SUBSCRIPTION_FROZEN" });

    expect(hoisted.lookup).not.toHaveBeenCalled();
  });

  it.each([
    ["missing recovery", null],
    ["non-DETECTED recovery", { ...hoisted.recovery, status: "MESSAGE_SENT" }],
    [
      "different block reason",
      { ...hoisted.recovery, admissionBlockReason: "SOMETHING_ELSE" },
    ],
  ])(
    "ignores %s before acquiring the checkout lock",
    async (_label, initial) => {
      hoisted.findUnique.mockResolvedValueOnce(initial);

      const service = new CheckoutRecoveryService();
      await expect(
        service.resumeCapacityBlockedRecovery("recovery-1"),
      ).resolves.toEqual({
        kind: "ignored",
        reason: "not-capacity-blocked",
      });

      expect(hoisted.withCheckoutLock).not.toHaveBeenCalled();
      expect(hoisted.lookup).not.toHaveBeenCalled();
      expect(hoisted.transaction).not.toHaveBeenCalled();
    },
  );

  it("ignores inactive shops before lookup or send", async () => {
    hoisted.findUnique.mockResolvedValueOnce({
      ...hoisted.recovery,
      shop: { ...hoisted.recovery.shop, status: "INACTIVE" },
    });

    await expect(
      new CheckoutRecoveryService().resumeCapacityBlockedRecovery("recovery-1"),
    ).resolves.toEqual({ kind: "ignored", reason: "shop-unavailable" });

    expect(hoisted.lookup).not.toHaveBeenCalled();
    expect(hoisted.withCheckoutLock).not.toHaveBeenCalled();
  });

  it("locks by durable shopId and checkoutToken", async () => {
    hoisted.findUnique
      .mockResolvedValueOnce(hoisted.recovery)
      .mockResolvedValueOnce({
        ...currentBlockedRecovery,
        status: "MESSAGE_SENT",
      });

    await expect(
      new CheckoutRecoveryService().resumeCapacityBlockedRecovery("recovery-1"),
    ).resolves.toEqual({ kind: "ignored", reason: "already-transitioned" });

    expect(hoisted.withCheckoutLock).toHaveBeenCalledTimes(1);
    expect(hoisted.withCheckoutLock).toHaveBeenCalledWith(
      "shop-1",
      "checkout-1",
      expect.any(Function),
    );
  });

  it("re-reads durable state after the lock and ignores an already-transitioned recovery", async () => {
    hoisted.findUnique
      .mockResolvedValueOnce(hoisted.recovery)
      .mockResolvedValueOnce({
        ...currentBlockedRecovery,
        status: "MESSAGE_SENT",
        admissionBlockReason: null,
      });

    const service = new CheckoutRecoveryService();
    const reentry = vi
      .spyOn(service, "handleCheckoutCreated")
      .mockResolvedValue({ id: "recovery-1" } as never);

    await expect(
      service.resumeCapacityBlockedRecovery("recovery-1"),
    ).resolves.toEqual({
      kind: "ignored",
      reason: "already-transitioned",
    });

    expect(hoisted.lookup).not.toHaveBeenCalled();
    expect(hoisted.transaction).not.toHaveBeenCalled();
    expect(reentry).not.toHaveBeenCalled();
  });

  it.each(["provider-error", "ambiguous", "bounded-limit-exceeded"] as const)(
    "keeps %s lookup failures retryable and non-terminal",
    async (kind) => {
      hoisted.findUnique
        .mockResolvedValueOnce(hoisted.recovery)
        .mockResolvedValueOnce(currentBlockedRecovery);
      hoisted.lookup.mockResolvedValueOnce(
        kind === "provider-error"
          ? { kind, message: "temporary" }
          : { kind },
      );

      const service = new CheckoutRecoveryService();
      const reentry = vi
        .spyOn(service, "handleCheckoutCreated")
        .mockResolvedValue({ id: "recovery-1" } as never);

      await expect(
        service.resumeCapacityBlockedRecovery("recovery-1"),
      ).rejects.toThrow();

      expect(hoisted.transaction).not.toHaveBeenCalled();
      expect(reentry).not.toHaveBeenCalled();
      expect(hoisted.update).not.toHaveBeenCalled();
      expect(hoisted.updateMany).not.toHaveBeenCalled();
    },
  );

  it("terminalizes a durable not-found recovery exactly once and clears the block fields", async () => {
    hoisted.findUnique
      .mockResolvedValueOnce(hoisted.recovery)
      .mockResolvedValueOnce(currentBlockedRecovery);
    hoisted.lookup.mockResolvedValueOnce({ kind: "not-found" });

    await expect(
      new CheckoutRecoveryService().resumeCapacityBlockedRecovery("recovery-1"),
    ).resolves.toEqual({ kind: "terminal", reason: "not-found" });

    expect(hoisted.transaction).toHaveBeenCalledTimes(1);
    expect(hoisted.txUpdateMany).toHaveBeenCalledTimes(1);
    expect(hoisted.txUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "recovery-1",
        status: "DETECTED",
        admissionBlockReason: {
          in: ["RECOVERY_CAPACITY_EXHAUSTED", "WHATSAPP_RECIPIENT_SUPPRESSED"],
        },
      },
      data: {
        status: "CANCELLED",
        expiredAt: expect.any(Date),
        admissionBlockedAt: null,
        admissionBlockReason: null,
      },
    });
    expect(hoisted.historyCreate).toHaveBeenCalledTimes(1);
    expect(hoisted.historyCreate).toHaveBeenCalledWith({
      data: {
        checkoutRecoveryId: "recovery-1",
        fromStatus: "DETECTED",
        toStatus: "CANCELLED",
        reason: "Checkout lookup not-found",
        source: "recovery-capacity-resume",
      },
    });
  });

  it("terminalizes a completed checkout and clears the durable capacity block", async () => {
    hoisted.findUnique
      .mockResolvedValueOnce(hoisted.recovery)
      .mockResolvedValueOnce(currentBlockedRecovery);
    hoisted.lookup.mockResolvedValueOnce(
      foundCheckout({ completedAt: "2026-09-02T00:00:00.000Z" }),
    );

    await expect(
      new CheckoutRecoveryService().resumeCapacityBlockedRecovery("recovery-1"),
    ).resolves.toEqual({ kind: "terminal", reason: "found" });

    expect(hoisted.txUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "recovery-1",
        status: "DETECTED",
        admissionBlockReason: {
          in: ["RECOVERY_CAPACITY_EXHAUSTED", "WHATSAPP_RECIPIENT_SUPPRESSED"],
        },
      },
      data: {
        status: "CANCELLED",
        expiredAt: expect.any(Date),
        admissionBlockedAt: null,
        admissionBlockReason: null,
      },
    });
    expect(hoisted.historyCreate).toHaveBeenCalledWith({
      data: {
        checkoutRecoveryId: "recovery-1",
        fromStatus: "DETECTED",
        toStatus: "CANCELLED",
        reason: "Checkout completed",
        source: "recovery-capacity-resume",
      },
    });
  });

  it("re-enters a fresh abandoned checkout once and returns the resulting durable status", async () => {
    hoisted.findUnique
      .mockResolvedValueOnce(hoisted.recovery)
      .mockResolvedValueOnce(currentBlockedRecovery)
      .mockResolvedValueOnce(currentBlockedRecovery)
      .mockResolvedValueOnce({
        status: "MESSAGE_SENT",
        admissionBlockReason: null,
      });
    hoisted.lookup.mockResolvedValueOnce(foundCheckout());

    const service = new CheckoutRecoveryService();
    const reentry = vi
      .spyOn(service, "handleCheckoutCreated")
      .mockResolvedValue({ id: "recovery-1" } as never);

    await expect(
      service.resumeCapacityBlockedRecovery("recovery-1"),
    ).resolves.toEqual({ kind: "initiated", status: "MESSAGE_SENT" });

    expect(reentry).toHaveBeenCalledTimes(1);
    expect(reentry).toHaveBeenCalledWith(
      expect.objectContaining({
        shop: "shop.example",
        checkoutToken: "checkout-1",
        checkoutUrl: "https://checkout/current",
        completedAt: null,
      }),
      1,
      "15551234567",
      undefined,
      expect.any(Function),
    );
  });

  it("reports capacity exhaustion when re-entry leaves the durable block in place", async () => {
    hoisted.findUnique
      .mockResolvedValueOnce(hoisted.recovery)
      .mockResolvedValueOnce(currentBlockedRecovery)
      .mockResolvedValueOnce(currentBlockedRecovery)
      .mockResolvedValueOnce({
        status: "DETECTED",
        admissionBlockReason: "RECOVERY_CAPACITY_EXHAUSTED",
      });
    hoisted.lookup.mockResolvedValueOnce(foundCheckout());

    const service = new CheckoutRecoveryService();
    vi.spyOn(service, "handleCheckoutCreated").mockResolvedValue({
      id: "recovery-1",
    } as never);

    await expect(
      service.resumeCapacityBlockedRecovery("recovery-1"),
    ).resolves.toEqual({ kind: "capacity-exhausted" });
  });

  it("makes a replay after successful re-entry a no-op without duplicate initiation", async () => {
    hoisted.findUnique
      .mockResolvedValueOnce(hoisted.recovery)
      .mockResolvedValueOnce(currentBlockedRecovery)
      .mockResolvedValueOnce(currentBlockedRecovery)
      .mockResolvedValueOnce({
        status: "MESSAGE_SENT",
        admissionBlockReason: null,
      })
      .mockResolvedValueOnce({
        ...hoisted.recovery,
        status: "MESSAGE_SENT",
        admissionBlockReason: null,
      });
    hoisted.lookup.mockResolvedValueOnce(foundCheckout());

    const service = new CheckoutRecoveryService();
    const reentry = vi
      .spyOn(service, "handleCheckoutCreated")
      .mockResolvedValue({ id: "recovery-1" } as never);

    await expect(
      service.resumeCapacityBlockedRecovery("recovery-1"),
    ).resolves.toEqual({ kind: "initiated", status: "MESSAGE_SENT" });
    await expect(
      service.resumeCapacityBlockedRecovery("recovery-1"),
    ).resolves.toEqual({
      kind: "ignored",
      reason: "not-capacity-blocked",
    });

    expect(reentry).toHaveBeenCalledTimes(1);
    expect(hoisted.lookup).toHaveBeenCalledTimes(1);
    expect(hoisted.withCheckoutLock).toHaveBeenCalledTimes(2);
  });

  it("preserves the first block timestamp by only marking an unblocked DETECTED recovery", async () => {
    const blockedAt = new Date("2026-09-03T12:00:00.000Z");
    hoisted.updateMany.mockResolvedValueOnce({ count: 1 });

    await new CheckoutRecoveryService().markRecoveryCapacityBlocked(
      "recovery-1",
      blockedAt,
    );

    expect(hoisted.updateMany).toHaveBeenCalledTimes(1);
    expect(hoisted.updateMany).toHaveBeenCalledWith({
      where: {
        id: "recovery-1",
        status: "DETECTED",
        admissionBlockReason: null,
      },
      data: {
        admissionBlockedAt: blockedAt,
        admissionBlockReason: "RECOVERY_CAPACITY_EXHAUSTED",
      },
    });
  });

  it("clears capacity-block fields when a recovery becomes MESSAGE_SENT", async () => {
    hoisted.updateMany.mockResolvedValueOnce({ count: 1 });

    await new CheckoutRecoveryService().markRecoveryMessageSent("recovery-1");

    expect(hoisted.updateMany).toHaveBeenCalledTimes(1);
    expect(hoisted.updateMany).toHaveBeenCalledWith({
      where: { id: "recovery-1", status: "DETECTED" },
      data: {
        status: "MESSAGE_SENT",
        messageSentAt: expect.any(Date),
        admissionBlockedAt: null,
        admissionBlockReason: null,
      },
    });
  });

  it("cannot reopen an expired recovery after an in-flight send", async () => {
    hoisted.updateMany.mockResolvedValueOnce({ count: 0 });

    await new CheckoutRecoveryService().markRecoveryMessageSent("recovery-1");

    expect(hoisted.updateMany).toHaveBeenCalledWith({
      where: { id: "recovery-1", status: "DETECTED" },
      data: {
        status: "MESSAGE_SENT",
        messageSentAt: expect.any(Date),
        admissionBlockedAt: null,
        admissionBlockReason: null,
      },
    });
  });

});
