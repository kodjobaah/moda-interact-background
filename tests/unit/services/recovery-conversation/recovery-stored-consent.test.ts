import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/lib/db.js", () => ({ default: {} }));
import {
  RecoveryStoredConsentService, checkFinalStoredRecoveryConsent,
} from "../../../../src/services/recovery-conversation/recovery-stored-consent.service.js";

const shopifyPhone = {
  id: "phone-a", whatsappCanonicalPhone: "447400123456",
  whatsappConsentPurpose: "WHATSAPP_CHECKOUT_RECOVERY",
  whatsappConsentDecision: "GRANTED", whatsappConsentSource: "SHOPIFY_NATIVE",
  whatsappConsentVerifiedAt: new Date("2026-10-23T10:00:10Z"),
  whatsappConsentProviderObservedAt: new Date("2026-10-23T10:00:00Z"),
  whatsappPhoneVerifiedAt: new Date("2026-10-23T10:00:00Z"),
  whatsappConsentRevision: 5n, whatsappConsentDecisionSequence: 3n,
  whatsappNoContact: false, whatsappNoContactReason: null, whatsappNoContactRevision: 2n,
};
const snapshot = {
  customerPhoneId: "phone-a", canonicalRecipient: "447400123456",
  consentRevision: 5n, noContactRevision: 2n,
};
const context = {
  id: "conversation-a", shopId: "shop-a", recoveryId: "recovery-a",
  checkoutToken: "opaque", recoveryStatus: "MESSAGE_SENT", mode: "AI" as const,
  revision: 7, lastInboundAt: null,
};

function fence(rows: unknown[]) {
  const tx = { $queryRawUnsafe: vi.fn(async () => rows) };
  return { tx, check: () => checkFinalStoredRecoveryConsent(
    tx as never, context, "+447400123456", snapshot,
  ) };
}

describe("final stored CustomerPhone recovery consent fence", () => {
  it("accepts only the exact authorised recipient and matching revisions", async () => {
    const f = fence([shopifyPhone]);
    await expect(f.check()).resolves.toBeNull();
    expect(f.tx.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("FOR SHARE OF p"), "recovery-a", "shop-a", "447400123456",
    );
  });
  it.each([
    [{ ...shopifyPhone, whatsappConsentDecision: "REVOKED", whatsappConsentRevision: 6n }, "stored-consent-revision-changed"],
    [{ ...shopifyPhone, whatsappNoContact: true, whatsappNoContactRevision: 3n }, "stored-consent-revision-changed"],
    [{ ...shopifyPhone, whatsappNoContact: true }, "local-no-contact"],
    [{ ...shopifyPhone, whatsappNoContactReason: "MERCHANT_OPT_OUT" }, "local-no-contact"],
    [{ ...shopifyPhone, whatsappConsentDecision: "UNKNOWN" }, "stored-consent-denied"],
    [{ ...shopifyPhone, whatsappConsentSource: "WOO_CHECKOUT_CHECKBOX" }, "stored-consent-denied"],
    [{ ...shopifyPhone, id: "other-phone" }, "recipient-changed"],
  ])("rejects changed permission state %#", async (row, reason) => {
    await expect(fence([row]).check()).resolves.toBe(reason);
  });
  it("denies missing, duplicate or changed recipient records without provider I/O", async () => {
    await expect(fence([]).check()).resolves.toBe("stored-consent-ambiguous");
    await expect(fence([shopifyPhone, { ...shopifyPhone, id: "phone-b" }]).check())
      .resolves.toBe("stored-consent-ambiguous");
    await expect(checkFinalStoredRecoveryConsent(fence([]).tx as never,
      context, "+447400999999", snapshot)).resolves.toBe("recipient-changed");
    await expect(checkFinalStoredRecoveryConsent(fence([]).tx as never,
      context, "+447400123456", undefined)).resolves.toBe("stored-consent-snapshot-missing");
  });
});

describe("recovery proactive stored-only preflight", () => {
  const findUnique = vi.fn();
  const evaluateStoredRecipient = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    findUnique.mockResolvedValue({ shopId: "shop-a", customerId: "customer-a", shop: { platform: "SHOPIFY" } });
    evaluateStoredRecipient.mockResolvedValue({ status: "ALLOWED", ...snapshot });
  });
  const make = () => new RecoveryStoredConsentService(
    { checkoutRecovery: { findUnique } } as never,
    { evaluateStoredRecipient } as never,
  );
  it("uses stored Shopify permission and returns the revision snapshot", async () => {
    await expect(make().preflight({ shopId: "shop-a", recoveryId: "recovery-a", recipient: "+447400123456" }))
      .resolves.toEqual({ kind: "allowed", snapshot });
    expect(evaluateStoredRecipient).toHaveBeenCalledOnce();
  });
  it("denies revoked state and provider/DB unavailability without Shopify GraphQL", async () => {
    evaluateStoredRecipient.mockResolvedValueOnce({ status: "NOT_AUTHORISED", reason: "LOCAL_NO_CONTACT" });
    await expect(make().preflight({ shopId: "shop-a", recoveryId: "recovery-a", recipient: "+447400123456" }))
      .resolves.toEqual({ kind: "denied", reason: "stored-consent-denied" });
    findUnique.mockRejectedValueOnce(new Error("db offline"));
    await expect(make().preflight({ shopId: "shop-a", recoveryId: "recovery-a", recipient: "+447400123456" }))
      .resolves.toEqual({ kind: "denied", reason: "stored-consent-unavailable" });
  });
  it("does not invent Shopify-native grants for WooCommerce", async () => {
    findUnique.mockResolvedValueOnce({ shopId: "shop-a", customerId: "woo-a", shop: { platform: "WOOCOMMERCE" } });
    await expect(make().preflight({ shopId: "shop-a", recoveryId: "recovery-a", recipient: "+447400123456" }))
      .resolves.toEqual({ kind: "allowed", snapshot: null });
    expect(evaluateStoredRecipient).not.toHaveBeenCalled();
  });
});
