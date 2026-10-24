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
  const notices = { notify: vi.fn(async () => "created" as const) };
  const service = new RecoveryConsentAdmissionService(consent, notices);
  const first = {
    shopId: "shop-1", checkoutToken: "secret-checkout-token", customerId: "customer-1",
    shopifyCustomerId: "gid://shopify/Customer/1", recipient: "447700900001",
    noticeContext: { customerName: "Merchant-visible customer" },
  };
  const firstNotice = {
    shopId: first.shopId, checkoutToken: first.checkoutToken, platform: "SHOPIFY",
    blockedOperation: "CREATE_FIRST_RECOVERY", context: first.noticeContext,
  };
  return { service, first, firstNotice, consent, notices };
}

const allowed = {
  status: "ALLOWED", customerPhoneId: "phone-1", canonicalRecipient: "447700900001",
  consentRevision: 4n, noContactRevision: 2n,
} as const;

describe("Shopify recovery consent admission with shared notifier", () => {
  it("denies a revoked/unknown native opt-in before first recovery insert", async () => {
    const { service, first, firstNotice, consent, notices } = context();
    expect(await service.evaluateFirst(first)).toBe(false);
    expect(consent.evaluateRecipient).toHaveBeenCalledOnce();
    expect(consent.evaluateStoredRecipient).not.toHaveBeenCalled();
    expect(notices.notify).toHaveBeenCalledWith({ ...firstNotice, reason: "NO_VERIFIED_OPT_IN" });
  });

  it("uses stored permission on DETECTED reentry, never another Shopify provider call", async () => {
    const { service, first, consent, notices } = context();
    consent.evaluateStoredRecipient.mockResolvedValue(allowed as never);
    expect(await service.evaluateReentry({
      shopId: first.shopId, checkoutToken: first.checkoutToken,
      customerId: first.customerId, recipient: first.recipient,
    })).toBe(true);
    expect(consent.evaluateStoredRecipient).toHaveBeenCalledOnce();
    expect(consent.evaluateRecipient).not.toHaveBeenCalled();
    expect(notices.notify).not.toHaveBeenCalled();
  });

  it("does not misclassify independent local STOP or confirmed native grant", async () => {
    const { service, first, consent, notices } = context();
    consent.evaluateRecipient.mockResolvedValue({ status: "NOT_AUTHORISED", reason: "LOCAL_NO_CONTACT" });
    consent.evaluateStoredRecipient.mockResolvedValue({ status: "NOT_AUTHORISED", reason: "LOCAL_NO_CONTACT" });
    expect(await service.evaluateFirst(first)).toBe(false);
    expect(await service.evaluateReentry({ ...first })).toBe(false);
    consent.evaluateRecipient.mockResolvedValue(allowed as never);
    expect(await service.evaluateFirst(first)).toBe(true);
    expect(notices.notify).not.toHaveBeenCalled();
  });

  it("maps missing identity, native ambiguity, other mismatch and unavailability separately", async () => {
    const { service, first, firstNotice, consent, notices } = context();
    expect(await service.evaluateFirst({ ...first, shopifyCustomerId: null })).toBe(false);
    expect(consent.evaluateRecipient).not.toHaveBeenCalled();
    expect(notices.notify).toHaveBeenLastCalledWith({ ...firstNotice, reason: "RECIPIENT_UNVERIFIED" });

    consent.evaluateRecipient.mockResolvedValue({ status: "AMBIGUOUS", reason: "MULTIPLE_ACTIVE_RECIPIENTS" } as never);
    expect(await service.evaluateFirst(first)).toBe(false);
    expect(notices.notify).toHaveBeenLastCalledWith({ ...firstNotice, reason: "RECIPIENT_AMBIGUOUS" });

    consent.evaluateRecipient.mockResolvedValue({ status: "NOT_AUTHORISED", reason: "SHOPIFY_DEFAULT_PHONE_CHANGED" });
    expect(await service.evaluateFirst(first)).toBe(false);
    expect(notices.notify).toHaveBeenLastCalledWith({ ...firstNotice, reason: "RECIPIENT_UNVERIFIED" });

    consent.evaluateRecipient.mockResolvedValue({ status: "UNAVAILABLE", reason: "SHOPIFY_READ_FAILURE" } as never);
    await expect(service.evaluateFirst(first)).rejects.toThrow(SHOPIFY_RECOVERY_CONSENT_RETRY_REQUIRED);
    expect(notices.notify).toHaveBeenLastCalledWith({ ...firstNotice, reason: "VERIFICATION_UNAVAILABLE" });
  });

  it("uses SEND_INITIAL_RECOVERY for every reentry and missing-recipient path", async () => {
    const { service, first, consent, notices } = context();
    const reentry = { shopId: first.shopId, checkoutToken: first.checkoutToken,
      customerId: first.customerId, recipient: first.recipient };
    expect(await service.evaluateReentry(reentry)).toBe(false);
    expect(notices.notify).toHaveBeenLastCalledWith({
      shopId: first.shopId, checkoutToken: first.checkoutToken, platform: "SHOPIFY",
      blockedOperation: "SEND_INITIAL_RECOVERY", reason: "NO_VERIFIED_OPT_IN",
    });
    consent.evaluateStoredRecipient.mockResolvedValue({ status: "AMBIGUOUS", reason: "MULTIPLE_ACTIVE_RECIPIENTS" } as never);
    expect(await service.evaluateReentry(reentry)).toBe(false);
    expect(notices.notify).toHaveBeenLastCalledWith(expect.objectContaining({
      blockedOperation: "SEND_INITIAL_RECOVERY", reason: "RECIPIENT_AMBIGUOUS",
    }));
    expect(await service.evaluateReentry({ ...reentry, recipient: null })).toBe(false);
    await service.notifyMissingRecipient({ shopId: first.shopId, checkoutToken: first.checkoutToken });
    expect(notices.notify).toHaveBeenLastCalledWith(expect.objectContaining({
      blockedOperation: "SEND_INITIAL_RECOVERY", reason: "RECIPIENT_UNVERIFIED",
    }));
  });

  it("preserves provider-unavailable retry only after a successfully persisted notice", async () => {
    const { service, first, consent, notices } = context();
    consent.evaluateRecipient.mockResolvedValue({ status: "UNAVAILABLE", reason: "SHOPIFY_READ_FAILURE" } as never);
    const databaseFailure = new Error("db temporarily unavailable");
    notices.notify.mockRejectedValueOnce(databaseFailure);
    await expect(service.evaluateFirst(first)).rejects.toBe(databaseFailure);
    expect(notices.notify).toHaveBeenCalledOnce();
    await expect(service.evaluateFirst(first)).rejects.toThrow(SHOPIFY_RECOVERY_CONSENT_RETRY_REQUIRED);
    expect(notices.notify).toHaveBeenCalledTimes(2);
  });
});
