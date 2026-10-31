import { describe, expect, it, vi } from "vitest";
import { InitialOutreachAgentContextSchema, InitialOutreachAgentResultSchema } from "../../../../src/agents/initial-outreach-offer.types.js";
import { CurrentOutreachOfferRevalidationService } from "../../../../src/services/recovery-offers/current-outreach-offer-revalidation.service.js";
import type { DiscountSourceFenceResult } from "../../../../src/services/recovery-offers/current-discount-source-fence.js";

const offer = {
  offerId: "offer-1", title: "Welcome saving", method: "CODE" as const, code: "SAVE10",
  startsAt: null, endsAt: null, support: "SUPPORTED" as const, reasonCodes: [],
};
const details = {
  offer,
  providerDiscountId: "provider-discount-1",
  facts: {
    provider: "SHOPIFY" as const, completeness: "COMPLETE" as const,
    observedAt: "2026-10-31T12:00:00.000Z", providerStatus: "ACTIVE", unavailableAt: null,
    discountKind: "PERCENTAGE" as const, discountValue: "10", discountCurrency: "GBP",
    targeting: { kind: "PRODUCTS" as const, includedProductIds: ["product-1"], includedVariantIds: [],
      includedCategoryIds: [], includedCollectionIds: [], excludedProductIds: [], excludedVariantIds: [],
      excludedCategoryIds: [], excludedCollectionIds: [] },
    minimumSubtotal: null, maximumSubtotal: null, subtotalRequirementCurrency: null, minimumQuantity: null,
    usageLimit: 10, usageCount: 0, perCustomerLimit: 0, customerScope: "ALL" as const,
    excludesSaleItems: false, individualUse: null,
    combination: { discountClasses: ["PRODUCT" as const], shopifyPlus: null,
      combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
      discountTags: [], allowedSameLineProductTags: [] },
    unrepresentedConditions: [],
  },
};

function context() {
  return InitialOutreachAgentContextSchema.parse({
    shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1",
    environment: "TEST", platform: "SHOPIFY", mode: "AI_BEST_APPLICABLE", authorisedDiscountIds: [],
    basket: { currency: "GBP", subtotalMinor: null, totalMinor: null, fingerprint: "a".repeat(64),
      generation: 4, items: [{ lineKey: "line-0001", productId: "product-1", variantId: "variant-1",
        categoryIds: ["category-1"], collectionIds: null, isSaleItem: false, title: "Boots",
        category: "Shoes", quantity: 1, lineTotalMinor: null }] },
    priceReconciliation: null, platformInstructions: "Use source data only.", merchantInstructions: null,
    platformInstructionRevisionId: "platform-revision-1", merchantInstructionRevisionId: null,
  });
}

const proposed = InitialOutreachAgentResultSchema.parse({
  kind: "CHECKOUT_DISCOUNT", offerSet: { schemaVersion: "moda.outreach.checkout-offers.v1",
    offers: [{ offerId: "offer-1", providerDiscountId: "provider-discount-1", method: "CODE", code: "SAVE10" }] },
  members: [{ offerId: "offer-1", providerDiscountId: "provider-discount-1", method: "CODE",
    code: "SAVE10", description: "Welcome saving", eligibility: { offerId: "offer-1", verdict: "SUPPORTED",
      eligibleLineKeys: ["line-0001"], reasonCodes: [] } }],
  group: { verdict: "SUPPORTED", offerIds: ["offer-1"], reasonCodes: [] },
  shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1",
  generation: 4, fingerprint: "a".repeat(64), priceReconciliation: null, discoveryIncomplete: false,
});

const fence: DiscountSourceFenceResult = { kind: "AVAILABLE", fence: {
  shopId: "shop-1", platform: "SHOPIFY", syncGeneration: 7,
  selectedOfferIds: ["offer-1"], snapshotDigest: "b".repeat(64),
} };
const mcpSuccess = (data: unknown) => ({ contractVersion: "commerce.v1", status: "OK", data,
  renderedText: "Validated source result." });

function makeService(overrides: {
  currentContext?: ReturnType<typeof context>;
  firstFence?: DiscountSourceFenceResult;
  secondFence?: DiscountSourceFenceResult;
  toolResult?: unknown;
  toolResults?: Record<string, unknown>;
  productResult?: unknown;
} = {}) {
  let latestContext = overrides.currentContext ?? context();
  const contextBuilder = { build: vi.fn(async () => latestContext) };
  const selector = {
    connect: vi.fn(async () => undefined), tools: vi.fn(async () => []),
    call: vi.fn(async (name: string, args?: { offerId?: string }) => name === "commerce_get_product"
      ? overrides.productResult ?? mcpSuccess({ product: null })
      : overrides.toolResults?.[args?.offerId ?? ""] ?? overrides.toolResult ?? mcpSuccess({ details })),
    close: vi.fn(async () => undefined),
  };
  let fenceCall = 0;
  let admissionFence = overrides.secondFence ?? overrides.firstFence ?? fence;
  const readFence = vi.fn(async () => {
    const call = fenceCall++;
    if (call === 0) return overrides.firstFence ?? fence;
    if (call === 1) return overrides.secondFence ?? overrides.firstFence ?? fence;
    return admissionFence;
  });
  const service = new CurrentOutreachOfferRevalidationService({
    contextBuilder: contextBuilder as never,
    createSelector: () => selector,
    readFence,
    clock: () => new Date("2026-10-31T12:00:00.000Z"),
  });
  return { service, contextBuilder, selector, readFence,
    setCurrentContext(value: ReturnType<typeof context>) { latestContext = value; },
    setAdmissionFence(value: DiscountSourceFenceResult) { admissionFence = value; },
  };
}

const input = (proposal = proposed) => ({ shopId: "shop-1", checkoutRecoveryId: "recovery-1",
  outreachAttemptId: "attempt-1", proposed: proposal, signal: new AbortController().signal });

describe("current outreach offer revalidation", () => {
  it("discards BG010 evidence and returns a freshly validated offer under equal F1/F2 fences", async () => {
    const { service, selector, contextBuilder, readFence } = makeService();
    const result = await service.revalidateCurrentOutreachOffer(input());
    expect(result.kind).toBe("VALIDATED");
    if (result.kind !== "VALIDATED") return;
    expect(result.result.kind).toBe("CHECKOUT_DISCOUNT");
    if (result.result.kind !== "CHECKOUT_DISCOUNT") return;
    expect(result.result.offerSet.offers).toEqual([
      { offerId: "offer-1", providerDiscountId: "provider-discount-1", method: "CODE", code: "SAVE10" },
    ]);
    expect(selector.call).toHaveBeenCalledOnce();
    expect(selector.call).toHaveBeenCalledWith("commerce_get_discount_details", { offerId: "offer-1" }, expect.any(AbortSignal));
    expect(selector.close).toHaveBeenCalledOnce();
    expect(contextBuilder.build).toHaveBeenCalledTimes(2);
    expect(readFence).toHaveBeenCalledTimes(2);
  });

  it("rejects all proposed claims when F1 and F2 source digests differ", async () => {
    const { service, selector } = makeService({ secondFence: { kind: "AVAILABLE", fence: {
      ...fence.fence, snapshotDigest: "c".repeat(64),
    } } });
    const result = await service.revalidateCurrentOutreachOffer(input());
    expect(result).toMatchObject({ kind: "FAILURE", reasonCode: "SOURCE_FENCE_F2_CHANGED" });
    expect(selector.call).toHaveBeenCalledOnce();
  });

  it("trims a three-member proposal to the freshly supported proposed subset", async () => {
    const makeMember = (offerId: string, providerDiscountId: string, code: string) => ({
      offerId, providerDiscountId, method: "CODE" as const, code,
      title: `Title ${offerId}`, startsAt: null, endsAt: null, support: "SUPPORTED" as const,
      reasonCodes: [],
    });
    const makeDetails = (item: ReturnType<typeof makeMember>, includedProductId = "product-1") => ({
      ...details,
      offer: { offerId: item.offerId, title: item.title, method: item.method, code: item.code,
        startsAt: item.startsAt, endsAt: item.endsAt, support: item.support, reasonCodes: item.reasonCodes },
      providerDiscountId: item.providerDiscountId,
      facts: { ...details.facts,
        targeting: { ...details.facts.targeting, includedProductIds: [includedProductId] },
        combination: { ...details.facts.combination, shopifyPlus: true,
          discountTags: ["compatible"], allowedSameLineProductTags: ["compatible"] },
      },
    });
    const offerSet = [
      { offerId: "offer-1", providerDiscountId: "provider-1", method: "CODE", code: "CODE1" },
      { offerId: "offer-2", providerDiscountId: "provider-2", method: "CODE", code: "CODE2" },
      { offerId: "offer-3", providerDiscountId: "provider-3", method: "CODE", code: "CODE3" },
    ];
    const proposal = InitialOutreachAgentResultSchema.parse({
      ...proposed,
      offerSet: { schemaVersion: "moda.outreach.checkout-offers.v1", offers: offerSet },
      members: offerSet.map((entry) => ({ ...entry, description: `Title ${entry.offerId}`,
        eligibility: { offerId: entry.offerId, verdict: "SUPPORTED", eligibleLineKeys: ["line-0001"], reasonCodes: [] } })),
      group: { verdict: "SUPPORTED", offerIds: offerSet.map((entry) => entry.offerId), reasonCodes: [] },
    });
    const toolResults = {
      "offer-1": mcpSuccess({ details: makeDetails(makeMember("offer-1", "provider-1", "CODE1")) }),
      "offer-2": mcpSuccess({ details: makeDetails(makeMember("offer-2", "provider-2", "CODE2")) }),
      "offer-3": mcpSuccess({ details: makeDetails(makeMember("offer-3", "provider-3", "CODE3"), "other-product") }),
    };
    const threeOfferFence: DiscountSourceFenceResult = { kind: "AVAILABLE", fence: {
      ...fence.fence, selectedOfferIds: offerSet.map((entry) => entry.offerId),
    } };
    const { service, selector } = makeService({ toolResults, firstFence: threeOfferFence });

    const result = await service.revalidateCurrentOutreachOffer(input(proposal));

    expect(result.kind).toBe("VALIDATED");
    if (result.kind !== "VALIDATED" || result.result.kind !== "CHECKOUT_DISCOUNT") return;
    expect(result.result.offerSet.offers.map((entry) => entry.offerId)).toEqual(["offer-1", "offer-2"]);
    expect(selector.call).toHaveBeenCalledTimes(3);
  });

  it("returns typed no-offer when fresh exact-product identity does not match the proposal", async () => {
    const alternative = InitialOutreachAgentResultSchema.parse({
      kind: "ALTERNATIVE_PRODUCT_PROMOTION", offerId: "offer-1", providerDiscountId: "provider-discount-1",
      method: "CODE", code: "SAVE10", description: "Welcome saving", productId: "product-2",
      variantId: "variant-2", product: { sourceTool: "commerce_get_product", authenticatedShopId: "shop-1",
        shopId: "shop-1", product: { productId: "product-2", variantId: "variant-2", title: "Scarf",
          url: "https://shop.example/products/scarf", available: true, unitPrice: null, currency: null,
          productType: "Accessories", vendor: "Shop", categories: [], categoryIds: [], collectionIds: [],
          imageUrl: null, saleEvidence: null, observedAt: "2026-10-31T12:00:00.000Z" } },
      shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1",
      generation: 4, fingerprint: "a".repeat(64), discoveryIncomplete: false,
    });
    const productResult = mcpSuccess({ product: { productId: "different-product", variantId: "variant-2",
      title: "Scarf", url: "https://shop.example/products/scarf", available: true, unitPrice: null,
      currency: null, productType: "Accessories", vendor: "Shop", categories: [], categoryIds: [],
      collectionIds: [], imageUrl: null, saleEvidence: null, observedAt: "2026-10-31T12:00:00.000Z" } });
    const targetedDetails = { ...details, facts: { ...details.facts,
      targeting: { ...details.facts.targeting, includedProductIds: ["product-2"] } } };
    const { service } = makeService({ toolResult: mcpSuccess({ details: targetedDetails }), productResult });
    const result = await service.revalidateCurrentOutreachOffer(input(alternative));
    expect(result).toMatchObject({ kind: "NO_VERIFIED_OFFER", result: { kind: "NO_VERIFIED_OFFER" } });
  });

  it("returns only the freshly read exact product for a supported alternative promotion", async () => {
    const alternative = InitialOutreachAgentResultSchema.parse({
      kind: "ALTERNATIVE_PRODUCT_PROMOTION", offerId: "offer-1", providerDiscountId: "provider-discount-1",
      method: "CODE", code: "SAVE10", description: "Welcome saving", productId: "product-2",
      variantId: "variant-2", product: { sourceTool: "commerce_get_product", authenticatedShopId: "shop-1",
        shopId: "shop-1", product: { productId: "product-2", variantId: "variant-2", title: "Scarf",
          url: "https://shop.example/products/scarf", available: true, unitPrice: null, currency: null,
          productType: "Accessories", vendor: "Shop", categories: [], categoryIds: [], collectionIds: [],
          imageUrl: null, saleEvidence: null, observedAt: "2026-10-31T12:00:00.000Z" } },
      shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1",
      generation: 4, fingerprint: "a".repeat(64), discoveryIncomplete: false,
    });
    const productResult = mcpSuccess({ product: { productId: "product-2", variantId: "variant-2",
      title: "Scarf", url: "https://shop.example/products/scarf", available: true, unitPrice: null,
      currency: null, productType: "Accessories", vendor: "Shop", categories: [], categoryIds: [],
      collectionIds: [], imageUrl: null, saleEvidence: null, observedAt: "2026-10-31T12:00:00.000Z" } });
    const targetedDetails = { ...details, facts: { ...details.facts,
      targeting: { ...details.facts.targeting, includedProductIds: ["product-2"] } } };
    const { service, selector } = makeService({ toolResult: mcpSuccess({ details: targetedDetails }), productResult });
    const result = await service.revalidateCurrentOutreachOffer(input(alternative));
    expect(result.kind).toBe("VALIDATED");
    if (result.kind !== "VALIDATED") return;
    expect(result.result).toMatchObject({ kind: "ALTERNATIVE_PRODUCT_PROMOTION",
      product: { authenticatedShopId: "shop-1", product: { productId: "product-2", variantId: "variant-2",
        url: "https://shop.example/products/scarf" } } });
    expect(selector.call).toHaveBeenNthCalledWith(2, "commerce_get_product",
      { productId: "product-2", variantId: "variant-2" }, expect.any(AbortSignal));
  });

  it("denies F3 when current source context changes after F2", async () => {
    const { service, setCurrentContext } = makeService();
    const result = await service.revalidateCurrentOutreachOffer(input());
    expect(result.kind).toBe("VALIDATED");
    if (result.kind !== "VALIDATED") return;
    setCurrentContext(InitialOutreachAgentContextSchema.parse({
      ...context(), basket: { ...context().basket, generation: 5 },
    }));
    const admission = await service.validateAdmission(result.admissionToken, new AbortController().signal);
    expect(admission).toBe(false);
  });

  it("denies F3 when merchant discount authorisation changes after F2", async () => {
    const { service, setCurrentContext } = makeService();
    const result = await service.revalidateCurrentOutreachOffer(input());
    expect(result.kind).toBe("VALIDATED");
    if (result.kind !== "VALIDATED") return;
    setCurrentContext(InitialOutreachAgentContextSchema.parse({
      ...context(), mode: "FIXED", authorisedDiscountIds: [],
    }));

    await expect(service.validateAdmission(result.admissionToken, new AbortController().signal))
      .resolves.toBe(false);
  });

  it("denies F3 when the same-generation source digest changes after F2", async () => {
    const { service, setAdmissionFence } = makeService();
    const result = await service.revalidateCurrentOutreachOffer(input());
    expect(result.kind).toBe("VALIDATED");
    if (result.kind !== "VALIDATED") return;
    setAdmissionFence({ kind: "AVAILABLE", fence: {
      ...fence.fence, snapshotDigest: "c".repeat(64),
    } });

    await expect(service.validateAdmission(result.admissionToken, new AbortController().signal))
      .resolves.toBe(false);
  });
});
