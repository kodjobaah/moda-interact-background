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

function fence(rows: unknown[], evidence: { matched: boolean }[] = [{ matched: true }]) {
  const tx = {
    $queryRawUnsafe: vi.fn()
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce(evidence),
  };
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
    expect(f.tx.$queryRawUnsafe).toHaveBeenCalledTimes(2);
    expect(f.tx.$queryRawUnsafe).toHaveBeenNthCalledWith(2,
      expect.stringContaining('FROM "commerce"."WhatsAppConsentEvidence"'),
      "shop-a", "phone-a", "447400123456", 5n, 3n,
      shopifyPhone.whatsappConsentProviderObservedAt, "recovery-a",
    );
  });
  it("denies a granted phone projection without matching immutable consent evidence", async () => {
    await expect(fence([shopifyPhone], [{ matched: false }]).check())
      .resolves.toBe("stored-consent-evidence-missing");
    await expect(fence([shopifyPhone], []).check())
      .resolves.toBe("stored-consent-evidence-missing");
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
  const evaluateWooRecipient = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  beforeEach(() => {
    vi.resetAllMocks();
    findUnique.mockResolvedValue({ shopId: "shop-a", customerId: "customer-a", shop: { platform: "SHOPIFY" } });
    evaluateStoredRecipient.mockResolvedValue({ status: "ALLOWED", ...snapshot });
  });
  const make = () => new RecoveryStoredConsentService(
    { checkoutRecovery: { findUnique } } as never,
    { evaluateStoredRecipient } as never,
    logger,
    { evaluateStoredRecipient: evaluateWooRecipient },
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
    const originalError = new Error("original Prisma connection failure");
    findUnique.mockRejectedValueOnce(originalError);
    await expect(make().preflight({ shopId: "shop-a", recoveryId: "recovery-a", recipient: "+447400123456" }))
      .resolves.toEqual({ kind: "denied", reason: "stored-consent-unavailable" });
    expect(logger.error).toHaveBeenCalledWith("shopify.consent.outbound.blocked", expect.objectContaining({
      operation: "proactive_final_send",
      stage: "consent_preflight",
      error: originalError,
    }));
  });
  const wooInput = { shopId: "shop-a", recoveryId: "recovery-a", recipient: "447400123456" };
  const woo = { ...snapshot, shopId: "shop-a", customerId: "woo-a", installationId: "install-a",
    credentialVersion: 2, consentDecisionSequence: 3n };
  function useWoo() {
    findUnique.mockResolvedValue({ shopId: "shop-a", customerId: "woo-a", shop: { platform: "WOOCOMMERCE" } });
    evaluateWooRecipient.mockResolvedValue({ status: "ALLOWED", ...snapshot, snapshot: woo });
  }
  it("requires and carries the exact Woo consent/installation snapshot for proactive messages", async () => {
    useWoo();
    await expect(make().preflight(wooInput)).resolves.toEqual({ kind: "allowed", snapshot: { ...snapshot, woo } });
    expect(evaluateWooRecipient).toHaveBeenCalledWith({ shopId: "shop-a", customerId: "woo-a", recipient: "+447400123456" });
    expect(evaluateStoredRecipient).not.toHaveBeenCalled();
    await expect(checkFinalStoredRecoveryConsent(fence([]).tx as never, context, wooInput.recipient,
      { ...snapshot, woo })).resolves.toBe("stored-consent-snapshot-missing");
  });
  it.each([
    ["NOT_AUTHORISED", "stored-consent-denied"], ["AMBIGUOUS", "stored-consent-denied"],
    ["UNAVAILABLE", "stored-consent-unavailable"],
  ])("denies Woo preflight %s without consulting Shopify", async (status, reason) => {
    useWoo();
    evaluateWooRecipient.mockResolvedValueOnce({ status, reason: "FIXTURE_DENIAL" });
    await expect(make().preflight(wooInput)).resolves.toEqual({ kind: "denied", reason });
    expect(evaluateStoredRecipient).not.toHaveBeenCalled();
  });
  it("denies mismatched Woo snapshot ownership and missing recovery customer", async () => {
    useWoo();
    evaluateWooRecipient.mockResolvedValueOnce({ status: "ALLOWED", ...snapshot, snapshot: { ...woo, customerId: "other" } });
    await expect(make().preflight(wooInput)).resolves.toEqual({ kind: "denied", reason: "recipient-changed" });
    findUnique.mockResolvedValueOnce({ shopId: "shop-a", customerId: null, shop: { platform: "WOOCOMMERCE" } });
    await expect(make().preflight(wooInput)).resolves.toEqual({ kind: "denied", reason: "stored-consent-unavailable" });
  });
  it("preserves Woo multipart replies without issuing a marketing consent snapshot", async () => {
    useWoo();
    await expect(make().preflight({ ...wooInput, purpose: "multipart-reply" }))
      .resolves.toEqual({ kind: "allowed", snapshot: null });
    expect(evaluateWooRecipient).not.toHaveBeenCalled();
    expect(evaluateStoredRecipient).not.toHaveBeenCalled();
  });
});
