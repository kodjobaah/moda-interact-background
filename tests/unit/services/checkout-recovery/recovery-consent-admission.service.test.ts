import { describe, expect, it, vi } from "vitest";
import type { ShopifyWhatsAppConsentEligibility } from "../../../../src/services/shopify-whatsapp-consent.service.js";
import {
  RecoveryConsentAdmissionService,
  SHOPIFY_RECOVERY_CONSENT_RETRY_REQUIRED,
} from "../../../../src/services/checkout-recovery/recovery-consent-admission.service.js";

function context() {
  const consent = {
    evaluateRecipient: vi.fn(async (): Promise<ShopifyWhatsAppConsentEligibility> => (
      { status: "NOT_AUTHORISED", reason: "NATIVE_CONSENT_NOT_GRANTED" }
    )),
    evaluateStoredRecipient: vi.fn(async (): Promise<ShopifyWhatsAppConsentEligibility> => (
      { status: "NOT_AUTHORISED", reason: "NATIVE_CONSENT_NOT_GRANTED" }
    )),
  };
  const notices = { publish: vi.fn(async () => "created" as const) };
  const service = new RecoveryConsentAdmissionService(consent, notices);
  const first = {
    shopId: "shop-1", checkoutToken: "secret-checkout-token", customerId: "customer-1",
    shopifyCustomerId: "gid://shopify/Customer/1", recipient: "447700900001",
  };
  return { service, first, consent, notices };
}

describe("Shopify recovery consent admission", () => {
  it("denies current revoked or unknown native opt-in without calling the provider again", async () => {
    const { service, first, consent, notices } = context();
    expect(await service.evaluateFirst(first)).toBe(false);
    expect(consent.evaluateRecipient).toHaveBeenCalledOnce();
    expect(consent.evaluateStoredRecipient).not.toHaveBeenCalled();
    expect(notices.publish).toHaveBeenCalledWith(expect.objectContaining({
      shopId: first.shopId, checkoutToken: first.checkoutToken,
      reason: "NO_VERIFIED_OPT_IN",
    }));
  });

  it("uses stored permission for existing DETECTED reentry, never Shopify readCurrent", async () => {
    const { service, first, consent } = context();
    consent.evaluateStoredRecipient.mockResolvedValue({ status: "ALLOWED", customerPhoneId: "phone-1",
      canonicalRecipient: "447700900001", consentRevision: 4n, noContactRevision: 2n } as never);
    expect(await service.evaluateReentry({
      shopId: first.shopId, checkoutToken: first.checkoutToken,
      customerId: first.customerId, recipient: first.recipient,
    })).toBe(true);
    expect(consent.evaluateStoredRecipient).toHaveBeenCalledOnce();
    expect(consent.evaluateRecipient).not.toHaveBeenCalled();
  });

  it("denies local customer STOP without a misleading consent notice", async () => {
    const { service, first, consent, notices } = context();
    consent.evaluateRecipient.mockResolvedValue({ status: "NOT_AUTHORISED", reason: "LOCAL_NO_CONTACT" });
    expect(await service.evaluateFirst(first)).toBe(false);
    expect(notices.publish).not.toHaveBeenCalled();
  });

  it("separates missing identity, ambiguous recipient and Shopify unavailability", async () => {
    const { service, first, consent, notices } = context();
    expect(await service.evaluateFirst({ ...first, shopifyCustomerId: null })).toBe(false);
    expect(consent.evaluateRecipient).not.toHaveBeenCalled();
    expect(notices.publish).toHaveBeenLastCalledWith(expect.objectContaining({ reason: "RECIPIENT_UNVERIFIED" }));

    consent.evaluateRecipient.mockResolvedValue({ status: "AMBIGUOUS", reason: "MULTIPLE_ACTIVE_RECIPIENTS" } as never);
    expect(await service.evaluateFirst(first)).toBe(false);
    expect(notices.publish).toHaveBeenLastCalledWith(expect.objectContaining({ reason: "RECIPIENT_UNVERIFIED" }));

    consent.evaluateRecipient.mockResolvedValue({ status: "UNAVAILABLE", reason: "SHOPIFY_READ_FAILURE" } as never);
    await expect(service.evaluateFirst(first)).rejects.toThrow(SHOPIFY_RECOVERY_CONSENT_RETRY_REQUIRED);
    expect(notices.publish).toHaveBeenLastCalledWith(expect.objectContaining({ reason: "VERIFICATION_UNAVAILABLE" }));
  });

  it("permits a verified native grant, but does not create a recovery or send here", async () => {
    const { service, first, consent, notices } = context();
    consent.evaluateRecipient.mockResolvedValue({ status: "ALLOWED", customerPhoneId: "phone-1",
      canonicalRecipient: "447700900001", consentRevision: 4n, noContactRevision: 0n } as never);
    expect(await service.evaluateFirst(first)).toBe(true);
    expect(notices.publish).not.toHaveBeenCalled();
  });
});
