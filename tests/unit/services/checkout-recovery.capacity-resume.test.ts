import { describe, expect, it, vi } from "vitest";

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
  withCheckoutLock: vi.fn(async (_shopId: string, _checkoutToken: string, callback: () => Promise<unknown>) => callback()),
}));

vi.mock("../../../src/lib/db.js", () => ({
  default: {
    shop: { findUnique: vi.fn(async () => ({ id: "shop-1", settings: null })) },
    checkoutRecovery: { findUnique: hoisted.findUnique, update: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("../../../src/services/customer.service.js", () => ({ customerService: {} }));
vi.mock("../../../src/services/conversation.service.js", () => ({ conversationService: {} }));
vi.mock("../../../src/services/conversation.message.service.js", () => ({ conversationMessageService: {} }));
vi.mock("../../../src/services/outbound-whatsapp-admission.service.js", () => ({ outboundWhatsAppAdmissionService: {} }));
vi.mock("../../../src/services/whatsapp-template-selector.service.js", () => ({ whatsappTemplateSelectorService: {} }));
vi.mock("../../../src/services/pending-recovery-candidate.service.js", () => ({
  pendingRecoveryCandidateService: { withCheckoutLock: hoisted.withCheckoutLock },
}));
vi.mock("../../../src/services/shop-execution-eligibility.service.js", () => ({ shopExecutionEligibilityService: {} }));
vi.mock("../../../src/services/abandoned-checkout-lookup.service.js", () => ({
  abandonedCheckoutLookupService: { lookup: hoisted.lookup },
}));

import { CheckoutRecoveryService } from "../../../src/services/checkout-recovery.service.js";

describe("CheckoutRecoveryService capacity resume", () => {
  it("ignores inactive shops before lookup or send", async () => {
    hoisted.findUnique.mockResolvedValueOnce({
      ...hoisted.recovery,
      shop: { ...hoisted.recovery.shop, status: "INACTIVE" },
    });
    const lookup = hoisted.lookup;
    lookup.mockClear();

    await expect(new CheckoutRecoveryService().resumeCapacityBlockedRecovery("recovery-1"))
      .resolves.toEqual({ kind: "ignored", reason: "shop-unavailable" });
    expect(lookup).not.toHaveBeenCalled();
    expect(hoisted.withCheckoutLock).not.toHaveBeenCalled();
  });

  it.each(["provider-error", "ambiguous", "bounded-limit-exceeded"] as const)(
    "keeps %s lookup failures retryable and non-terminal",
    async (kind) => {
      hoisted.findUnique.mockReset().mockResolvedValue(hoisted.recovery);
      hoisted.lookup.mockReset().mockResolvedValue(
        kind === "provider-error"
          ? { kind, message: "temporary" }
          : { kind },
      );
      const service = new CheckoutRecoveryService();

      await expect(service.resumeCapacityBlockedRecovery("recovery-1")).rejects.toThrow();
      expect(hoisted.withCheckoutLock).toHaveBeenCalledWith(
        "shop-1",
        "checkout-1",
        expect.any(Function),
      );
    },
  );
});
