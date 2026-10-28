import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutomatedRecoveryTemplateService } from
  "../../../../src/services/recovery-template-integration/automated-recovery-template.service.js";
import type { PreparedRecoveryTemplate } from
  "../../../../src/services/recovery-template-preparation/recovery-template.types.js";

const now = new Date("2026-10-26T09:00:00.000Z");
const hash = "a".repeat(64);
const basePrepared: PreparedRecoveryTemplate = {
  outcome: "prepared", shopId: "shop-1", senderWabaId: "waba-1",
  purpose: "INITIAL_NO_OFFER", canonicalLanguageTag: "en-GB", selectionSource: "merchant-fallback",
  variantId: "variant-1", registrationId: "registration-1", definitionId: "definition-1",
  providerTemplateId: "meta-1", providerTemplateName: "moda_template",
  providerLanguageCode: "en_GB", submittedContentHash: hash, bindingFingerprint: hash,
  template: { name: "moda_template", language: { code: "en_GB" }, components: [
    { type: "body", parameters: [{ type: "text", text: "Alice" }] },
  ] },
};
const policy = { recoveryOfferMode: "NONE" as const,
  fixedShopifyDiscountId: null, offerSnapshot: null };
const recovered = {
  id: "recovery-1", shopId: "shop-1", checkoutUrl: "https://shop.test/checkouts/abc",
  updatedAt: new Date("2026-10-26T08:59:00Z"), status: "DETECTED",
  customer: { firstName: "Alice" },
  shop: { id: "shop-1", domain: "shop.test", status: "ACTIVE", defaultLanguageTag: "en-GB" },
  outreachAttempts: [{ sentAt: now, outboundMessageId: "message-1" }],
};
const storedPromise = (promise: unknown) => JSON.stringify({
  contract: "moda.whatsapp.automated-template-parameters.v1", recoveryPromise: promise,
});
function fixture(recovery = recovered) {
  const offers = { resolve: vi.fn(async () => ({ kind: "NO_OFFER" as const, reason: "POLICY_NONE" as const })) };
  const preparer = { prepare: vi.fn(async () => basePrepared) };
  const database = {
    checkoutRecovery: { findUnique: vi.fn(async () => recovery) },
    conversationMessage: { findUnique: vi.fn(async () => ({
      content: storedPromise({ kind: "NO_OFFER" }), status: "SENT", providerMessageId: "wamid-1",
      senderType: "AUTOMATION", direction: "OUTBOUND",
    })) },
  };
  const logger = { warn: vi.fn(), error: vi.fn() };
  const service = new AutomatedRecoveryTemplateService(offers as never,
    preparer as never, database as never, async () => "waba-1", () => now, logger as never);
  return { offers, preparer, database, logger, service };
}

beforeEach(() => vi.clearAllMocks());

describe("ARCH-047 shared automated recovery offer/template coordinator", () => {
  it("uses the shop default on sequence one and passes immutable prepared body through unchanged", async () => {
    const f = fixture();
    const result = await f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      stage: "INITIAL", policy: policy as never, conversationLanguageTag: "fr-CA" });
    expect(result.kind).toBe("prepared");
    if (result.kind !== "prepared") throw new Error("missing preparation");
    expect(result.send).toMatchObject({ bodyParameters: ["Alice"], recoveryPromise: { kind: "NO_OFFER" },
      templateRegistration: { variantId: "variant-1", shopId: "shop-1" } });
    expect(f.offers.resolve).toHaveBeenCalledWith(expect.objectContaining({
      shopId: "shop-1", checkoutRecoveryId: "recovery-1", stage: "INITIAL" }));
    expect(f.preparer.prepare).toHaveBeenCalledWith(expect.objectContaining({
      stage: "INITIAL", offerPresentation: "NO_OFFER", conversationLanguageTag: null,
      merchantLanguageTag: "en-GB", senderWabaId: "waba-1", customerFirstName: "Alice",
      checkout: expect.objectContaining({ shopId: "shop-1", approvedHosts: ["shop.test"] }),
    }));
  });

  it.each([
    ["FIXED", "CODE_OFFER", "SAVE10"],
    ["AI_BEST_APPLICABLE", "AUTOMATIC_OFFER", null],
  ] as const)("accepts independently verified %s %s evidence", async (mode, kind, code) => {
    const f = fixture();
    const verified = { kind, shopId: "shop-1", checkoutRecoveryId: "recovery-1",
      providerDiscountId: "provider-offer-1", description: "Save £10",
      parameters: code ? { code } : {}, evidence: { evaluatedAt: now,
        expiresAt: new Date(now.getTime() + 60_000) },
    };
    f.offers.resolve.mockResolvedValueOnce(verified as never);
    f.preparer.prepare.mockResolvedValueOnce({ ...basePrepared, purpose: `INITIAL_${kind}` } as never);
    const result = await f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      stage: "INITIAL", policy: { ...policy, recoveryOfferMode: mode } as never,
      conversationLanguageTag: null });
    expect(result.kind).toBe("prepared");
    expect(f.preparer.prepare).toHaveBeenCalledWith(expect.objectContaining({
      offerPresentation: kind, verifiedOffer: expect.objectContaining({
        kind, verified: true, shopId: "shop-1", description: "Save £10" }),
    }));
    if (result.kind === "prepared") expect(result.send.recoveryPromise).toEqual({
      kind, providerDiscountId: "provider-offer-1", ...(code ? { code } : {}),
    });
  });

  it("uses conversation language and a persisted sent promise on sequence two", async () => {
    const f = fixture({ ...recovered, status: "MESSAGE_SENT" });
    f.preparer.prepare.mockResolvedValueOnce({ ...basePrepared, purpose: "FOLLOW_UP_NO_OFFER" });
    const result = await f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      stage: "FOLLOW_UP", policy: policy as never, conversationLanguageTag: "fr-CA" });
    expect(result.kind).toBe("prepared");
    expect(f.offers.resolve).toHaveBeenCalledWith(expect.objectContaining({
      stage: "FOLLOW_UP", previouslyPromisedOffer: { kind: "NO_OFFER" } }));
    expect(f.preparer.prepare).toHaveBeenCalledWith(expect.objectContaining({
      stage: "FOLLOW_UP", conversationLanguageTag: "fr-CA" }));
  });

  it("denies a follow-up when initial proof is missing or unsafe", async () => {
    const f = fixture({ ...recovered, status: "MESSAGE_SENT" });
    f.database.conversationMessage.findUnique.mockResolvedValueOnce({
      content: "{}", status: "SENT", providerMessageId: "wamid-1",
      senderType: "AUTOMATION", direction: "OUTBOUND",
    });
    expect(await f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      stage: "FOLLOW_UP", policy: policy as never, conversationLanguageTag: "fr-CA" }))
      .toEqual({ kind: "unavailable", reason: "INITIAL_PROMISE_UNAVAILABLE" });
    expect(f.offers.resolve).not.toHaveBeenCalled();
    expect(f.preparer.prepare).not.toHaveBeenCalled();
  });

  it("fails closed on downgrade from an earlier provider-verified offer", async () => {
    const f = fixture({ ...recovered, status: "MESSAGE_SENT" });
    f.database.conversationMessage.findUnique.mockResolvedValueOnce({
      content: storedPromise({ kind: "CODE_OFFER", providerDiscountId: "promo-1", code: "PROMO" }),
      status: "SENT", providerMessageId: "wamid-1", senderType: "AUTOMATION", direction: "OUTBOUND",
    });
    expect(await f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      stage: "FOLLOW_UP", policy: policy as never, conversationLanguageTag: "fr-CA" }))
      .toEqual({ kind: "unavailable", reason: "PREVIOUS_OFFER_UNVERIFIED" });
    expect(f.preparer.prepare).not.toHaveBeenCalled();
  });

  it("logs missing checkout-rule evaluator capability and prepares a No Offer variant", async () => {
    const f = fixture();
    f.offers.resolve.mockResolvedValueOnce({ kind: "NO_OFFER", reason: "PROVIDER_VERIFICATION_UNAVAILABLE" });
    expect((await f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      stage: "INITIAL", policy: { ...policy, recoveryOfferMode: "FIXED" } as never,
      conversationLanguageTag: null })).kind).toBe("prepared");
    expect(f.logger.warn).toHaveBeenCalledWith("recovery_offer.capability_gap",
      expect.objectContaining({ reason: "CHECKOUT_RULE_READER_UNAVAILABLE" }));
  });

  it("treats incomplete media as typed unavailability, without reserving or sending", async () => {
    const f = fixture();
    f.preparer.prepare.mockResolvedValueOnce({ outcome: "unavailable", reason: "MEDIA_NOT_READY", purpose: "INITIAL_NO_OFFER" } as never);
    expect(await f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      stage: "INITIAL", policy: policy as never, conversationLanguageTag: null }))
      .toEqual({ kind: "unavailable", reason: "MEDIA_NOT_READY" });
  });

  it("logs bounded exception details through the shared logger and rethrows", async () => {
    const f = fixture();
    const err = new Error("sensitive recipient or token must not appear in logs");
    f.database.checkoutRecovery.findUnique.mockRejectedValueOnce(err);
    await expect(f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      stage: "INITIAL", policy: policy as never, conversationLanguageTag: null })).rejects.toBe(err);
    expect(f.logger.error).toHaveBeenCalledWith("recovery_template.integration.failed",
      expect.objectContaining({ errorType: "Error", shopId: "shop-1" }));
    expect(f.logger.error.mock.lastCall?.[1].errorMessage).toBe(err.message);
  });
});
