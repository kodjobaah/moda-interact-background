import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutomatedRecoveryTemplateService, previousPromise } from
  "../../../../src/services/recovery-template-integration/automated-recovery-template.service.js";
import { prepareAutomatedTemplateInput } from
  "../../../../src/services/conversation-moderation/automated-template-input.js";
import { fingerprintRecoveryPricingBasket } from
  "../../../../src/services/recovery-pricing/price-comparison.js";
import { RecoveryTemplatePreparer } from
  "../../../../src/services/recovery-template-preparation/recovery-template-preparer.service.js";
import { templateSendFields } from
  "../../../../src/services/recovery-template-integration/prepared-template-send.js";
import type { AssignedVariantRow, RecoveryTemplateRepository } from
  "../../../../src/services/recovery-template-preparation/recovery-template.types.js";
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
  generation: 1, currency: "GBP",
  lineItems: [{ title: "Shoes", variantTitle: "Blue", quantity: 2 }],
  updatedAt: new Date("2026-10-26T08:59:00Z"), status: "DETECTED",
  lastExternalActivityAt: new Date(now.getTime() - 60_000), expiredAt: null,
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
    backgroundRuntimeConfig: { findUnique: vi.fn(async () => ({ checkoutRecoveryLifetimeDays: 21 })) },
    conversationMessage: { findUnique: vi.fn(async () => ({
      content: storedPromise({ kind: "NO_OFFER" }), status: "SENT", providerMessageId: "wamid-1",
      senderType: "AUTOMATION", direction: "OUTBOUND",
    })) },
  };
  const context = {
    shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1",
    mode: "NONE", authorisedDiscountIds: [],
    priceReconciliation: null,
    basket: { generation: recovery.generation, fingerprint: fingerprintRecoveryPricingBasket({
      shopId: recovery.shopId, checkoutRecoveryId: recovery.id, generation: recovery.generation,
      currency: recovery.currency, lineItems: recovery.lineItems,
    }) },
  };
  const initialOffers = { resolve: vi.fn(async () => ({
    result: { kind: "NO_VERIFIED_OFFER", reason: "POLICY_NONE", discoveryIncomplete: false },
    context, currentContext: context, signal: new AbortController().signal,
  })) };
  const initialFallback = { prepare: vi.fn(async ({ trigger }: { trigger: "MERCHANT_MODE_NONE" |
    "NO_VERIFIED_PROMOTION" | "AI_UNAVAILABLE" | "MCP_UNAVAILABLE" |
    "DISCOUNT_REVALIDATION_UNAVAILABLE" | "DISCOUNT_INVALID_OR_INCOMPATIBLE" |
    "PRICE_UNVERIFIABLE" | "ALTERNATIVE_PRODUCT_UNVERIFIABLE" | "IMAGE_UNAVAILABLE" }) => {
    const lifetime = await database.backgroundRuntimeConfig.findUnique({ where: { id: "default" },
      select: { checkoutRecoveryLifetimeDays: true } });
    const prepared = await preparer.prepare({
      shopId: recovery.shopId, senderWabaId: "waba-1", stage: "INITIAL",
      promotionTarget: "CHECKOUT", offerPresentation: "NO_OFFER", conversationLanguageTag: null,
      merchantLanguageTag: recovery.shop.defaultLanguageTag,
      customerFirstName: recovery.customer.firstName,
      shopName: { shopId: recovery.shopId, value: recovery.shop.domain },
      checkout: { shopId: recovery.shopId, url: recovery.checkoutUrl,
        lastExternalActivityAt: recovery.lastExternalActivityAt,
        checkoutRecoveryLifetimeDays: lifetime?.checkoutRecoveryLifetimeDays ?? 21,
        expiresAt: recovery.expiredAt, approvedHosts: ["shop.test"] },
      checkoutItems: { shopId: recovery.shopId, lineItems: recovery.lineItems },
    });
    if (prepared.outcome !== "prepared") return { kind: "BLOCKED" as const,
      reason: "APPROVED_BINDING_UNAVAILABLE" as const };
    return { kind: "PREPARED" as const, trigger, prepared,
      send: templateSendFields(prepared, { kind: "NO_OFFER" }) };
  }) };
  const setCheckoutDecision = (mode: "FIXED" | "AI_BEST_APPLICABLE", kind: "CODE" | "AUTOMATIC",
    code: string | null) => {
    const offerId = mode === "FIXED" ? "fixed-discount-1" : "offer-1";
    context.mode = mode;
    context.authorisedDiscountIds = mode === "FIXED" ? [offerId] : [];
    const offer = { offerId, providerDiscountId: "provider-offer-1", method: kind, code };
    initialOffers.resolve.mockResolvedValueOnce({
      context, currentContext: context, signal: new AbortController().signal,
      result: {
        kind: "CHECKOUT_DISCOUNT",
        offerSet: { schemaVersion: "moda.outreach.checkout-offers.v1", offers: [offer] },
        members: [{ ...offer, description: "Save £10", eligibility: {
          verdict: "SUPPORTED", eligibleLineKeys: ["line-0001"], reasonCodes: [],
        } }],
        group: { verdict: "SUPPORTED", offerIds: [offerId], reasonCodes: [] },
        shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1",
        generation: context.basket.generation, fingerprint: context.basket.fingerprint,
        priceReconciliation: null, discoveryIncomplete: false,
      },
    } as never);
  };
  const logger = { warn: vi.fn(), error: vi.fn() };
  const implementation = new AutomatedRecoveryTemplateService(offers as never,
    preparer as never, database as never, async () => "waba-1", () => now, logger as never,
    undefined, initialOffers as never, undefined, initialFallback as never);
  const service = { prepare: (input: Parameters<typeof implementation.prepare>[0]) =>
    implementation.prepare(input.stage === "INITIAL" && !input.outreachAttemptId
      ? { ...input, outreachAttemptId: "attempt-1" } : input) };
  return { offers, preparer, database, logger, service, initialOffers, initialFallback,
    context, setCheckoutDecision };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}

function approvedCodeVariant(binding: "offer.code" | "offer.codes"): AssignedVariantRow {
  const suffix = binding === "offer.code" ? "single" : "plural";
  const providerTemplateName = `approved_${suffix}_code`;
  const components = [{ type: "BODY", text: "Use {{1}} from {{2}}" }];
  const parameterBindings = { promotionTarget: "CHECKOUT", header: [], body: [
    { position: 1, variable: binding }, { position: 2, variable: "shop.name" },
  ], buttons: [] };
  const contentHash = createHash("sha256").update(stableJson({ schemaVersion: 1,
    family: "META_RECOVERY", category: "MARKETING", components,
    parameterBindings })).digest("hex");
  const definition = { id: `definition-${suffix}`, kind: "META_RECOVERY", purpose: "INITIAL",
    offerType: "CODE_OFFER", status: "PUBLISHED", category: "MARKETING",
    providerTemplateName, publishedAt: now, retiredAt: null };
  const locale = { id: `locale-${suffix}`, languageTag: "en-GB", providerLanguageCode: "en_GB",
    status: "REVIEWED", contentHash, definition };
  const registration = { id: `registration-${suffix}`, wabaId: "waba-1", providerTemplateName,
    providerLanguageCode: "en_GB", providerTemplateId: `provider-${suffix}`, category: "MARKETING",
    providerStatus: "APPROVED", submissionState: "APPROVED", failureCode: null,
    driftDetectedAt: null, lastObservedContentHash: contentHash, lastObservedCategory: "MARKETING",
    submittedContentHash: contentHash, componentsSnapshot: components,
    parameterBindingsSnapshot: parameterBindings, locale };
  return {
    id: `variant-${suffix}`, shopId: "shop-1", providerAccountId: "waba-1",
    purpose: "INITIAL_CODE_OFFER", languageTag: "en-GB", providerLanguageCode: "en_GB",
    providerTemplateName, providerTemplateId: `provider-${suffix}`, status: "APPROVED",
    enabled: true, metaRegistrationId: registration.id, metaRegistration: registration,
  } as unknown as AssignedVariantRow;
}

function createRealPreparer(variants: readonly AssignedVariantRow[], logger: { warn: () => void; error: () => void }) {
  const repository: RecoveryTemplateRepository = {
    readCatalogue: async () => ({ shop: { id: "shop-1", status: "ACTIVE", defaultLanguageTag: "en-GB" },
      variants }),
    readShopBrand: async () => null,
    readShopCategory: async () => null,
  };
  return new RecoveryTemplatePreparer(repository, async () => "waba-1", async () => null,
    [], () => now, logger);
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
    expect(f.offers.resolve).not.toHaveBeenCalled();
    expect(f.initialOffers.resolve).not.toHaveBeenCalled();
    expect(f.initialFallback.prepare).toHaveBeenCalledWith(expect.objectContaining({
      trigger: "MERCHANT_MODE_NONE",
    }));
    expect(f.preparer.prepare).toHaveBeenCalledWith(expect.objectContaining({
      stage: "INITIAL", offerPresentation: "NO_OFFER", conversationLanguageTag: null,
      merchantLanguageTag: "en-GB", senderWabaId: "waba-1", customerFirstName: "Alice",
      checkout: expect.objectContaining({ shopId: "shop-1", approvedHosts: ["shop.test"],
        lastExternalActivityAt: recovered.lastExternalActivityAt, checkoutRecoveryLifetimeDays: 21,
        expiresAt: null }),
      checkoutItems: { shopId: "shop-1", lineItems: recovered.lineItems },
    }));
    expect(f.database.backgroundRuntimeConfig.findUnique).toHaveBeenCalledWith({ where: { id: "default" },
      select: { checkoutRecoveryLifetimeDays: true } });
  });

  it.each(["SHOPIFY", "WOOCOMMERCE"] as const)(
    "passes the exact persisted %s checkout URL to template preparation",
    async (platform) => {
      const checkoutUrl = "https://checkout.example/continue?token=A%2FB&keep=%2B";
      const f = fixture({ ...recovered, checkoutUrl,
        shop: { ...recovered.shop, platform } });

      const result = await f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
        stage: "INITIAL", policy: policy as never, conversationLanguageTag: null });

      expect(result.kind).toBe("prepared");
      expect(f.preparer.prepare).toHaveBeenCalledWith(expect.objectContaining({
        checkout: expect.objectContaining({ shopId: "shop-1", url: checkoutUrl }),
      }));
    },
  );

  it.each([
    ["FIXED", "CODE_OFFER", "SAVE10"],
    ["AI_BEST_APPLICABLE", "AUTOMATIC_OFFER", null],
  ] as const)("accepts independently verified %s %s evidence", async (mode, kind, code) => {
    const f = fixture();
    f.setCheckoutDecision(mode, kind === "CODE_OFFER" ? "CODE" : "AUTOMATIC", code);
    f.preparer.prepare.mockResolvedValueOnce({ ...basePrepared, purpose: `INITIAL_${kind}` } as never);
    const result = await f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      stage: "INITIAL", policy: { ...policy, recoveryOfferMode: mode,
        fixedShopifyDiscountId: mode === "FIXED" ? "fixed-discount-1" : null } as never,
      conversationLanguageTag: null });
    expect(result.kind).toBe("prepared");
    expect(f.preparer.prepare).toHaveBeenCalledWith(expect.objectContaining({
      offerPresentation: kind, verifiedOffer: expect.objectContaining({
        kind, verified: true, shopId: "shop-1", description: "Save £10" }),
    }));
    expect(f.offers.resolve).not.toHaveBeenCalled();
    if (result.kind === "prepared") expect(result.send.recoveryPromise).toMatchObject({
      kind: "CHECKOUT_DISCOUNT", promotionTarget: "CHECKOUT",
      offerSet: { offers: [{ providerDiscountId: "provider-offer-1",
        method: kind === "CODE_OFFER" ? "CODE" : "AUTOMATIC", code }] },
    });
  });

  it("keeps the largest verified homogeneous group and persists only that actual set", async () => {
    const f = fixture();
    f.context.mode = "AI_BEST_APPLICABLE";
    const offers = [
      { offerId: "code-offer", providerDiscountId: "provider-code", method: "CODE", code: "SAVE10" },
      { offerId: "automatic-one", providerDiscountId: "provider-auto-1", method: "AUTOMATIC", code: null },
      { offerId: "automatic-two", providerDiscountId: "provider-auto-2", method: "AUTOMATIC", code: null },
    ];
    f.initialOffers.resolve.mockResolvedValueOnce({
      context: f.context, currentContext: f.context, signal: new AbortController().signal,
      result: {
        kind: "CHECKOUT_DISCOUNT",
        offerSet: { schemaVersion: "moda.outreach.checkout-offers.v1", offers },
        members: offers.map((offer) => ({ ...offer, description: `Description ${offer.offerId}`,
          eligibility: { verdict: "SUPPORTED", eligibleLineKeys: ["line-0001"], reasonCodes: [] } })),
        group: { verdict: "SUPPORTED", offerIds: offers.map(({ offerId }) => offerId), reasonCodes: [] },
        shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1",
        generation: f.context.basket.generation, fingerprint: f.context.basket.fingerprint,
        priceReconciliation: null, discoveryIncomplete: false,
      },
    } as never);
    f.preparer.prepare.mockResolvedValueOnce({ ...basePrepared, purpose: "INITIAL_AUTOMATIC_OFFER" });

    const result = await f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      stage: "INITIAL", policy: { ...policy, recoveryOfferMode: "AI_BEST_APPLICABLE" } as never,
      conversationLanguageTag: null });

    expect(result.kind).toBe("prepared");
    expect(f.preparer.prepare).toHaveBeenCalledWith(expect.objectContaining({
      offerPresentation: "AUTOMATIC_OFFER",
      verifiedOffer: expect.objectContaining({ description: "Description automatic-one, Description automatic-two" }),
    }));
    if (result.kind === "prepared") expect(result.send.recoveryPromise).toMatchObject({
      kind: "CHECKOUT_DISCOUNT", promotionTarget: "CHECKOUT", offerSet: { offers: [
        { offerId: "automatic-one" }, { offerId: "automatic-two" },
      ] },
    });
  });

  it.each([
    { proposedCount: 3, survivingCodes: ["SAVE10", "SHIPFREE"],
      variantId: "variant-plural" },
    { proposedCount: 2, survivingCodes: ["SAVE10"],
      variantId: "variant-single" },
  ])("selects and receipts the approved revision after a fresh $proposedCount-to-$survivingCodes.length trim",
    async ({ proposedCount, survivingCodes, variantId }) => {
      const f = fixture();
      f.context.mode = "AI_BEST_APPLICABLE";
      const proposed = Array.from({ length: proposedCount }, (_, index) => ({
        offerId: `offer-${index + 1}`, providerDiscountId: `provider-${index + 1}`,
        method: "CODE" as const, code: index === 0 ? "SAVE10" : index === 1 ? "SHIPFREE" : "TAKE5",
      }));
      const surviving = proposed.filter((offer) => survivingCodes.includes(offer.code));
      f.initialOffers.resolve.mockResolvedValueOnce({
        context: f.context, currentContext: f.context, signal: new AbortController().signal,
        result: {
          kind: "CHECKOUT_DISCOUNT",
          offerSet: { schemaVersion: "moda.outreach.checkout-offers.v1", offers: surviving },
          members: surviving.map((offer) => ({ ...offer, description: `Description ${offer.offerId}`,
            eligibility: { verdict: "SUPPORTED", eligibleLineKeys: ["line-0001"], reasonCodes: [] } })),
          group: { verdict: "SUPPORTED", offerIds: surviving.map(({ offerId }) => offerId), reasonCodes: [] },
          shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1",
          generation: f.context.basket.generation, fingerprint: f.context.basket.fingerprint,
          priceReconciliation: null, discoveryIncomplete: false,
        },
      } as never);
      const realPreparer = createRealPreparer([
        approvedCodeVariant("offer.code"), approvedCodeVariant("offer.codes"),
      ], f.logger);
      const service = new AutomatedRecoveryTemplateService(f.offers as never, realPreparer,
        f.database as never, async () => "waba-1", () => now, f.logger as never,
        undefined, f.initialOffers as never);

      const result = await service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
        stage: "INITIAL", policy: { ...policy, recoveryOfferMode: "AI_BEST_APPLICABLE" } as never,
        conversationLanguageTag: null, outreachAttemptId: "attempt-1" });

      expect(result.kind).toBe("prepared");
      if (result.kind !== "prepared") throw new Error("missing prepared trimmed offer set");
      expect(result.prepared.variantId).toBe(variantId);
      expect(result.send.bodyParameters).toEqual([survivingCodes.join(", "), "shop.test"]);
      const receipt = JSON.parse(prepareAutomatedTemplateInput({
        ...result.send, to: "15551234567",
      }).effectiveText) as { bodyParameters: string[]; recoveryPromise: {
        promotionTarget: string; offerSet: { offers: unknown[] };
      } };
      expect(receipt.bodyParameters).toEqual([survivingCodes.join(", "), "shop.test"]);
      expect(receipt.recoveryPromise.promotionTarget).toBe("CHECKOUT");
      expect(receipt.recoveryPromise.offerSet.offers).toEqual(surviving);
      expect(receipt.recoveryPromise.offerSet.offers).not.toContainEqual(
        expect.objectContaining({ offerId: proposed[proposedCount - 1]!.offerId }),
      );
      expect(f.initialOffers.resolve).toHaveBeenCalledTimes(1);
      expect(f.offers.resolve).not.toHaveBeenCalled();
    });

  it("fails closed rather than binding a singular revision to a surviving plural set", async () => {
    const f = fixture();
    f.context.mode = "AI_BEST_APPLICABLE";
    const surviving = [
      { offerId: "offer-1", providerDiscountId: "provider-1", method: "CODE", code: "SAVE10" },
      { offerId: "offer-2", providerDiscountId: "provider-2", method: "CODE", code: "SHIPFREE" },
    ];
    f.initialOffers.resolve.mockResolvedValueOnce({
      context: f.context, currentContext: f.context, signal: new AbortController().signal,
      result: {
        kind: "CHECKOUT_DISCOUNT",
        offerSet: { schemaVersion: "moda.outreach.checkout-offers.v1", offers: surviving },
        members: surviving.map((offer) => ({ ...offer, description: `Description ${offer.offerId}`,
          eligibility: { verdict: "SUPPORTED", eligibleLineKeys: ["line-0001"], reasonCodes: [] } })),
        group: { verdict: "SUPPORTED", offerIds: surviving.map(({ offerId }) => offerId), reasonCodes: [] },
        shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1",
        generation: f.context.basket.generation, fingerprint: f.context.basket.fingerprint,
        priceReconciliation: null, discoveryIncomplete: false,
      },
    } as never);
    const realPreparer = createRealPreparer([approvedCodeVariant("offer.code")], f.logger);
    const service = new AutomatedRecoveryTemplateService(f.offers as never, realPreparer,
      f.database as never, async () => "waba-1", () => now, f.logger as never,
      undefined, f.initialOffers as never);

    expect(await service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      stage: "INITIAL", policy: { ...policy, recoveryOfferMode: "AI_BEST_APPLICABLE" } as never,
      conversationLanguageTag: null, outreachAttemptId: "attempt-1" }))
      .toEqual({ kind: "unavailable", reason: "NO_APPROVED_ASSIGNMENT" });
    expect(f.initialOffers.resolve).toHaveBeenCalledTimes(1);
  });

  it("requires authenticated exact-product provenance before preparing an alternative promotion", async () => {
    const f = fixture();
    f.context.mode = "AI_BEST_APPLICABLE";
    const product = {
      productId: "product-2", variantId: "variant-2", title: "Matching scarf",
      url: "https://shop.example/products/scarf", available: true, unitPrice: null, currency: null,
      productType: "Accessories", vendor: "Shop", categories: ["Accessories"], categoryIds: ["category-2"],
      collectionIds: [], imageUrl: null, saleEvidence: null, observedAt: now.toISOString(),
    };
    const result = {
      kind: "ALTERNATIVE_PRODUCT_PROMOTION", offerId: "offer-1", providerDiscountId: "provider-offer-1",
      method: "AUTOMATIC", code: null, description: "a current sale price",
      productId: "product-2", variantId: "variant-2",
      product: { sourceTool: "commerce_get_product", authenticatedShopId: "shop-1", shopId: "shop-1", product },
      shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1",
      generation: f.context.basket.generation, fingerprint: f.context.basket.fingerprint, discoveryIncomplete: false,
    };
    f.initialOffers.resolve.mockResolvedValueOnce({ context: f.context, currentContext: f.context,
      result, signal: new AbortController().signal } as never);
    const prepared = await f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      stage: "INITIAL", policy: { ...policy, recoveryOfferMode: "AI_BEST_APPLICABLE" } as never,
      conversationLanguageTag: null });
    expect(prepared.kind).toBe("prepared");
    expect(f.preparer.prepare).toHaveBeenCalledWith(expect.objectContaining({
      promotionTarget: "ALTERNATIVE_PRODUCT",
      promotionalProduct: { sourceTool: "commerce_get_product", authenticatedShopId: "shop-1",
        product: { productId: "product-2", variantId: "variant-2", title: "Matching scarf",
          url: "https://shop.example/products/scarf" } },
    }));
    if (prepared.kind === "prepared") expect(prepared.send.recoveryPromise).toMatchObject({
      kind: "ALTERNATIVE_PRODUCT_PROMOTION", promotionTarget: "ALTERNATIVE_PRODUCT",
      productId: "product-2", variantId: "variant-2",
      providerDiscountId: "provider-offer-1", productTitle: "Matching scarf",
    });
    if (prepared.kind === "prepared") expect(prepared.send.recoveryPromise).not.toHaveProperty("code");

    const crossShop = fixture();
    crossShop.context.mode = "AI_BEST_APPLICABLE";
    crossShop.initialOffers.resolve.mockResolvedValueOnce({ context: crossShop.context,
      currentContext: crossShop.context, signal: new AbortController().signal,
      result: { ...result, product: { ...result.product, authenticatedShopId: "other-shop" } },
    } as never);
    const crossShopResult = await crossShop.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      stage: "INITIAL", policy: { ...policy, recoveryOfferMode: "AI_BEST_APPLICABLE" } as never,
      conversationLanguageTag: null });
    expect(crossShopResult.kind).toBe("prepared");
    expect(crossShop.initialFallback.prepare).toHaveBeenCalledWith(expect.objectContaining({
      trigger: "ALTERNATIVE_PRODUCT_UNVERIFIABLE",
    }));
    expect(crossShop.preparer.prepare).toHaveBeenCalledWith(expect.objectContaining({
      offerPresentation: "NO_OFFER",
    }));
    expect(crossShop.preparer.prepare.mock.calls[0]?.[0]).not.toHaveProperty("promotionalProduct");
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

  it("reads a confirmed singleton checkout offer-set receipt for follow-up verification", async () => {
    const f = fixture({ ...recovered, status: "MESSAGE_SENT" });
    f.database.conversationMessage.findUnique.mockResolvedValueOnce({
      content: storedPromise({ kind: "CHECKOUT_DISCOUNT", promotionTarget: "CHECKOUT", offerSet: {
        schemaVersion: "moda.outreach.checkout-offers.v1",
        offers: [{ offerId: "offer-1", providerDiscountId: "provider-offer-1", method: "CODE", code: "SAVE10" }],
      } }), status: "SENT", providerMessageId: "wamid-1", senderType: "AUTOMATION", direction: "OUTBOUND",
    });
    f.offers.resolve.mockResolvedValueOnce({ kind: "CODE_OFFER", shopId: "shop-1",
      checkoutRecoveryId: "recovery-1", providerDiscountId: "provider-offer-1",
      description: "Save £10", parameters: { code: "SAVE10" },
      evidence: { evaluatedAt: now, expiresAt: new Date(now.getTime() + 60_000) },
    } as never);
    f.preparer.prepare.mockResolvedValueOnce({ ...basePrepared, purpose: "FOLLOW_UP_CODE_OFFER" });

    const result = await f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      stage: "FOLLOW_UP", policy: { ...policy, recoveryOfferMode: "FIXED",
        fixedShopifyDiscountId: "fixed-discount-1" } as never, conversationLanguageTag: "fr-CA" });

    expect(result.kind).toBe("prepared");
    expect(f.offers.resolve).toHaveBeenCalledWith(expect.objectContaining({
      previouslyPromisedOffer: { kind: "CODE_OFFER", providerDiscountId: "provider-offer-1",
        code: "SAVE10", promotionTarget: "CHECKOUT" },
    }));
  });

  it("retains trusted targets from confirmed receipts without guessing legacy targets", () => {
    expect(previousPromise(storedPromise({ kind: "CODE_OFFER", promotionTarget: "CHECKOUT",
      providerDiscountId: "provider-1", code: "SAVE10" }))).toEqual({
      kind: "CODE_OFFER", promotionTarget: "CHECKOUT", providerDiscountId: "provider-1", code: "SAVE10",
    });
    expect(previousPromise(storedPromise({ kind: "ALTERNATIVE_PRODUCT_PROMOTION",
      promotionTarget: "ALTERNATIVE_PRODUCT", providerDiscountId: "provider-2",
      method: "AUTOMATIC", code: null }))).toEqual({
      kind: "AUTOMATIC_OFFER", promotionTarget: "ALTERNATIVE_PRODUCT", providerDiscountId: "provider-2",
    });
    expect(previousPromise(storedPromise({ kind: "ALTERNATIVE_PRODUCT_PROMOTION",
      promotionTarget: "ALTERNATIVE_PRODUCT", providerDiscountId: "provider-3", method: "AUTOMATIC" })))
      .toEqual({ kind: "AUTOMATIC_OFFER", promotionTarget: "ALTERNATIVE_PRODUCT",
        providerDiscountId: "provider-3" });
    expect(previousPromise(storedPromise({ kind: "ALTERNATIVE_PRODUCT_PROMOTION",
      promotionTarget: "ALTERNATIVE_PRODUCT", providerDiscountId: "provider-4",
      method: "AUTOMATIC", code: "CONTRADICTORY" }))).toBeNull();
    expect(previousPromise(storedPromise({ kind: "ALTERNATIVE_PRODUCT_PROMOTION",
      promotionTarget: "ALTERNATIVE_PRODUCT", providerDiscountId: "provider-5",
      method: "AUTOMATIC", code: { malformed: true } }))).toBeNull();
    expect(previousPromise(storedPromise({ kind: "ALTERNATIVE_PRODUCT_PROMOTION",
      providerDiscountId: "legacy-provider-2", method: "AUTOMATIC", code: null }))).toEqual({
      kind: "AUTOMATIC_OFFER", providerDiscountId: "legacy-provider-2",
    });
    expect(previousPromise(storedPromise({ kind: "CODE_OFFER", providerDiscountId: "legacy-1", code: "OLD" })))
      .toEqual({ kind: "CODE_OFFER", providerDiscountId: "legacy-1", code: "OLD" });
    expect(previousPromise(storedPromise({ kind: "CHECKOUT_DISCOUNT", promotionTarget: "ALTERNATIVE_PRODUCT",
      offerSet: { schemaVersion: "moda.outreach.checkout-offers.v1", offers: [] } }))).toBeNull();
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
      .toEqual({ kind: "unavailable", reason: "PREVIOUS_OFFER_UNKNOWN" });
    expect(f.offers.resolve).not.toHaveBeenCalled();
    expect(f.preparer.prepare).not.toHaveBeenCalled();
  });

  it("accepts a validated BG010 no-offer decision without consulting the legacy resolver", async () => {
    const f = fixture();
    f.context.mode = "AI_BEST_APPLICABLE";
    expect((await f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      stage: "INITIAL", policy: { ...policy, recoveryOfferMode: "AI_BEST_APPLICABLE" } as never,
      conversationLanguageTag: null })).kind).toBe("prepared");
    expect(f.offers.resolve).not.toHaveBeenCalled();
    expect(f.preparer.prepare).toHaveBeenCalledWith(expect.objectContaining({ offerPresentation: "NO_OFFER" }));
  });

  it.each([
    [{ kind: "FAILURE", code: "UNAVAILABLE", reasonCode: "MCP_READ_FAILED", retryable: true },
      "MCP_UNAVAILABLE"],
    [{ kind: "NO_VERIFIED_OFFER", reason: "AI_UNAVAILABLE", discoveryIncomplete: true },
      "AI_UNAVAILABLE"],
  ] as const)("routes optional enrichment result %j to one neutral fallback", async (result, trigger) => {
    const f = fixture();
    f.context.mode = "AI_BEST_APPLICABLE";
    f.initialOffers.resolve.mockResolvedValueOnce({ context: f.context, currentContext: f.context,
      signal: new AbortController().signal, result } as never);

    const selected = await f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      stage: "INITIAL", policy: { ...policy, recoveryOfferMode: "AI_BEST_APPLICABLE" } as never,
      conversationLanguageTag: null });

    expect(selected.kind).toBe("prepared");
    expect(f.initialOffers.resolve).toHaveBeenCalledOnce();
    expect(f.initialFallback.prepare).toHaveBeenCalledOnce();
    expect(f.initialFallback.prepare).toHaveBeenCalledWith(expect.objectContaining({ trigger }));
    expect(f.preparer.prepare).toHaveBeenCalledWith(expect.objectContaining({ offerPresentation: "NO_OFFER" }));
  });

  it("rejects a basket fingerprint change observed after BG010 before template preparation", async () => {
    const f = fixture();
    f.initialOffers.resolve.mockResolvedValueOnce({
      context: f.context,
      currentContext: { ...f.context, basket: { ...f.context.basket, fingerprint: "b".repeat(64) } },
      result: { kind: "NO_VERIFIED_OFFER", reason: "POLICY_NONE", discoveryIncomplete: false },
      signal: new AbortController().signal,
    } as never);
    const fallback = await f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      stage: "INITIAL", policy: { ...policy, recoveryOfferMode: "AI_BEST_APPLICABLE" } as never,
      conversationLanguageTag: null });
    expect(fallback.kind).toBe("prepared");
    expect(f.initialFallback.prepare).toHaveBeenCalledWith(expect.objectContaining({
      trigger: "DISCOUNT_REVALIDATION_UNAVAILABLE",
    }));
  });

  it("rejects changed BG016 price evidence observed after BG010 before template preparation", async () => {
    const f = fixture();
    f.context.mode = "AI_BEST_APPLICABLE";
    const originalReport = {
      shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1",
      generation: 1, basketFingerprint: f.context.basket.fingerprint, evaluatedAt: now.toISOString(),
      lines: [{ lineKey: "line-0001", productId: "product-1", variantId: "variant-1", quantity: 2,
        checkoutUnitPrice: "10.00", checkoutCurrency: "GBP", catalogueUnitPrice: "10.00",
        catalogueCurrency: "GBP", catalogueObservedAt: now.toISOString(), catalogueComparison: "EQUAL",
        checkoutPriceChange: "CONFIRMED_UNCHANGED", reasonCodes: [] }],
      reasonCodes: [], currentMerchandiseSubtotal: { amountDecimal: "20.00", currency: "GBP" },
      completeness: "COMPLETE",
    };
    f.context.priceReconciliation = originalReport as never;
    const changedReport = { ...originalReport, lines: [{ ...originalReport.lines[0]!,
      catalogueUnitPrice: "12.00", catalogueComparison: "DIFFERENT" }] };
    f.initialOffers.resolve.mockResolvedValueOnce({
      context: f.context,
      currentContext: { ...f.context, priceReconciliation: changedReport },
      result: { kind: "NO_VERIFIED_OFFER", reason: "AI_INCONCLUSIVE", discoveryIncomplete: false },
      signal: new AbortController().signal,
    } as never);
    const fallback = await f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      stage: "INITIAL", policy: { ...policy, recoveryOfferMode: "AI_BEST_APPLICABLE" } as never,
      conversationLanguageTag: null });
    expect(fallback.kind).toBe("prepared");
    expect(f.initialFallback.prepare).toHaveBeenCalledWith(expect.objectContaining({
      trigger: "DISCOUNT_REVALIDATION_UNAVAILABLE",
    }));
  });

  it("treats incomplete media as typed unavailability, without reserving or sending", async () => {
    const f = fixture();
    f.context.mode = "AI_BEST_APPLICABLE";
    f.preparer.prepare.mockResolvedValueOnce({ outcome: "unavailable", reason: "MEDIA_NOT_READY", purpose: "INITIAL_NO_OFFER" } as never);
    expect(await f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      stage: "INITIAL", policy: { ...policy, recoveryOfferMode: "AI_BEST_APPLICABLE" } as never,
      conversationLanguageTag: null }))
      .toEqual({ kind: "unavailable", reason: "MEDIA_NOT_READY" });
  });

  it("uses real activity and the fresh persisted policy, never updatedAt, to prepare checkout URLs", async () => {
    for (const ageMs of [6 * 60_000, 8 * 86_400_000]) {
      const lastExternalActivityAt = new Date(now.getTime() - ageMs);
      const f = fixture({ ...recovered, lastExternalActivityAt, updatedAt: now });
      expect((await f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
        stage: "INITIAL", policy: policy as never, conversationLanguageTag: null })).kind)
        .toBe("prepared");
      expect(f.preparer.prepare).toHaveBeenCalledWith(expect.objectContaining({
        checkout: expect.objectContaining({ lastExternalActivityAt, checkoutRecoveryLifetimeDays: 21 }),
      }));
    }

    const exactCutoff = fixture({ ...recovered,
      lastExternalActivityAt: new Date(now.getTime() - 21 * 86_400_000), updatedAt: now });
    expect(await exactCutoff.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      stage: "INITIAL", policy: policy as never, conversationLanguageTag: null }))
      .toEqual({ kind: "unavailable", reason: "CHECKOUT_UNAVAILABLE" });
    expect(exactCutoff.preparer.prepare).not.toHaveBeenCalled();
  });

  it("fails closed for missing or invalid policy and propagates unexpected policy read failures", async () => {
    const missing = fixture();
    missing.database.backgroundRuntimeConfig.findUnique.mockResolvedValueOnce(null as never);
    expect(await missing.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      stage: "INITIAL", policy: policy as never, conversationLanguageTag: null }))
      .toEqual({ kind: "unavailable", reason: "CHECKOUT_UNAVAILABLE" });
    expect(missing.preparer.prepare).not.toHaveBeenCalled();

    const invalid = fixture();
    invalid.database.backgroundRuntimeConfig.findUnique.mockResolvedValueOnce({
      checkoutRecoveryLifetimeDays: -1,
    } as never);
    expect(await invalid.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      stage: "INITIAL", policy: policy as never, conversationLanguageTag: null }))
      .toEqual({ kind: "unavailable", reason: "CHECKOUT_UNAVAILABLE" });

    const failure = new Error("database unavailable");
    const unavailable = fixture();
    unavailable.database.backgroundRuntimeConfig.findUnique.mockRejectedValueOnce(failure);
    await expect(unavailable.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      stage: "INITIAL", policy: policy as never, conversationLanguageTag: null })).rejects.toBe(failure);
    expect(unavailable.logger.error).toHaveBeenCalledWith("recovery_template.integration.failed",
      expect.objectContaining({ shopId: "shop-1", recoveryId: "recovery-1", error: failure }));
  });

  it("applies a shortened persisted lifetime on the next preparation", async () => {
    const f = fixture({ ...recovered, lastExternalActivityAt: new Date(now.getTime() - 86_400_000) });
    f.context.mode = "AI_BEST_APPLICABLE";
    f.database.backgroundRuntimeConfig.findUnique
      .mockResolvedValueOnce({ checkoutRecoveryLifetimeDays: 21 })
      .mockResolvedValueOnce({ checkoutRecoveryLifetimeDays: 1 });
    const request = { shopId: "shop-1", recoveryId: "recovery-1", stage: "INITIAL" as const,
      policy: { ...policy, recoveryOfferMode: "AI_BEST_APPLICABLE" } as never,
      conversationLanguageTag: null };
    expect((await f.service.prepare(request)).kind).toBe("prepared");
    expect(await f.service.prepare(request)).toEqual({ kind: "unavailable", reason: "CHECKOUT_UNAVAILABLE" });
    expect(f.database.backgroundRuntimeConfig.findUnique).toHaveBeenCalledTimes(2);
  });

  it("logs bounded exception details through the shared logger and rethrows", async () => {
    const f = fixture();
    const err = new Error("sensitive recipient or token must not appear in logs");
    f.database.checkoutRecovery.findUnique.mockRejectedValueOnce(err);
    await expect(f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      stage: "INITIAL", policy: policy as never, conversationLanguageTag: null })).rejects.toBe(err);
    expect(f.logger.error).toHaveBeenCalledWith("recovery_template.integration.failed",
      expect.objectContaining({ errorType: "Error", shopId: "shop-1" }));
    expect(f.logger.error.mock.lastCall?.[1].error).toBe(err);
    expect(f.logger.error.mock.lastCall?.[1]).not.toHaveProperty("errorMessage");
  });
});
