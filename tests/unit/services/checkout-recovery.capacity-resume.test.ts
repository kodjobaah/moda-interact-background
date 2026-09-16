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
    shop: { domain: "shop.example", status: "ACTIVE" },
  },
  lookup: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  txUpdateMany: vi.fn(),
  historyCreate: vi.fn(),
  transaction: vi.fn(),
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
    $transaction: hoisted.transaction,
  },
}));
vi.mock("../../../src/services/customer.service.js", () => ({
  customerService: {},
}));
vi.mock("../../../src/services/conversation.service.js", () => ({
  conversationService: {},
}));
vi.mock("../../../src/services/conversation.message.service.js", () => ({
  conversationMessageService: {},
}));
vi.mock("../../../src/services/outbound-whatsapp-admission.service.js", () => ({
  outboundWhatsAppAdmissionService: {},
}));
vi.mock("../../../src/services/whatsapp-template-selector.service.js", () => ({
  whatsappTemplateSelectorService: {},
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
        admissionBlockReason: "RECOVERY_CAPACITY_EXHAUSTED",
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
        admissionBlockReason: "RECOVERY_CAPACITY_EXHAUSTED",
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
    );
  });

  it("reports capacity exhaustion when re-entry leaves the durable block in place", async () => {
    hoisted.findUnique
      .mockResolvedValueOnce(hoisted.recovery)
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
    expect(hoisted.withCheckoutLock).toHaveBeenCalledTimes(1);
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
