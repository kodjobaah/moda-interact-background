import { describe, expect, it, vi } from "vitest";
import type { CommerceToolResult } from "@modainteract/moda-interact-shared/commerce";
import {
  CommerceModelInvocationFailure,
  type CommerceModelInvoker,
  type ModelRequest,
} from "@modainteract/moda-interact-shared/commerce/runner";
import { createInitialOutreachOfferGraph } from "../../../src/agents/initial-outreach-offer.graph.js";
import { InitialOutreachAgentContextSchema } from "../../../src/agents/initial-outreach-offer.types.js";
import type { OutreachMcpToolDescriptor } from "../../../src/services/recovery-offers/recovery-outreach-mcp-selector.service.js";

const offer = {
  offerId: "offer-1",
  title: "Welcome saving",
  method: "CODE" as const,
  code: "SAVE10",
  startsAt: null,
  endsAt: null,
  support: "SUPPORTED" as const,
  reasonCodes: [],
};

const details = {
  offer,
  providerDiscountId: "provider-discount-1",
  facts: {
    provider: "SHOPIFY" as const,
    completeness: "COMPLETE" as const,
    observedAt: "2026-10-31T12:00:00.000Z",
    providerStatus: "ACTIVE",
    unavailableAt: null,
    discountKind: "PERCENTAGE" as const,
    discountValue: "10",
    discountCurrency: "GBP",
    targeting: { kind: "PRODUCTS" as const, includedProductIds: ["product-1"], includedVariantIds: [],
      includedCategoryIds: [], includedCollectionIds: [], excludedProductIds: [], excludedVariantIds: [],
      excludedCategoryIds: [], excludedCollectionIds: [] },
    minimumSubtotal: null,
    maximumSubtotal: null,
    subtotalRequirementCurrency: null,
    minimumQuantity: null,
    usageLimit: 10,
    usageCount: 0,
    perCustomerLimit: 0,
    customerScope: "ALL" as const,
    excludesSaleItems: false,
    individualUse: null,
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
    basket: { currency: "GBP", subtotalMinor: null, totalMinor: null,
      fingerprint: "a".repeat(64), generation: 4,
      items: [{ lineKey: "line-0001", productId: "product-1", variantId: "variant-1",
        categoryIds: ["category-1"], collectionIds: null, isSaleItem: false,
        title: "Boots", category: "Shoes", quantity: 1, lineTotalMinor: null }] },
    priceReconciliation: {
      shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1",
      generation: 4, basketFingerprint: "a".repeat(64), evaluatedAt: "2026-10-31T12:00:00.000Z",
      lines: [{ lineKey: "line-0001", productId: "product-1", variantId: "variant-1", quantity: 1,
        checkoutUnitPrice: null, checkoutCurrency: null, catalogueUnitPrice: null, catalogueCurrency: null,
        catalogueObservedAt: null, catalogueComparison: "INCOMPARABLE", checkoutPriceChange: "UNVERIFIABLE", reasonCodes: [] }],
      reasonCodes: ["PRODUCT_PRICE_UNOBSERVED"], currentMerchandiseSubtotal: null, completeness: "PARTIAL",
    },
    platformInstructions: "Use source data only.", merchantInstructions: null,
    platformInstructionRevisionId: "platform-revision-1", merchantInstructionRevisionId: null,
  });
}

const tools: OutreachMcpToolDescriptor[] = [
  { name: "commerce_get_discount_options", description: "List discounts", inputSchema: { type: "object" } },
  { name: "commerce_get_discount_details", description: "Read discount", inputSchema: { type: "object" } },
  { name: "commerce_search_products", description: "Search products", inputSchema: { type: "object" } },
  { name: "commerce_get_product", description: "Read product", inputSchema: { type: "object" } },
];

function success(data: unknown): CommerceToolResult {
  return {
    contractVersion: "commerce.v1",
    status: "OK",
    data,
    renderedText: "Source result.",
  };
}

type ModelCall = { name: string; arguments: Record<string, unknown> };
const alternativeProduct = {
  productId: "product-2", variantId: "variant-2", title: "Matching scarf",
  url: "https://shop.example/products/scarf", available: true, unitPrice: null, currency: null,
  productType: "Accessories", vendor: "Shop", categories: ["Accessories"], categoryIds: ["category-2"],
  collectionIds: [], imageUrl: null, saleEvidence: null, observedAt: "2026-10-31T12:00:00.000Z",
};

function fixture(choices: Array<ModelCall | ModelCall[]>, options: {
  alternative?: boolean;
  detailOverride?: unknown;
  offerOverride?: Record<string, unknown>;
  evaluatedAt?: Date;
  invokeError?: Error;
} = {}) {
  const selector = {
    connect: vi.fn(async () => undefined),
    tools: vi.fn(async () => tools),
    call: vi.fn(async (name: string) => {
      if (name === "commerce_get_discount_options") return success({
        mode: "AI_BEST_APPLICABLE", offers: [{ ...offer, ...options.offerOverride }], cursor: null, truncated: false,
      });
      if (name === "commerce_get_discount_details") return success({ details: options.detailOverride ?? (options.alternative
        ? { ...details, facts: { ...details.facts, targeting: { ...details.facts.targeting, includedProductIds: ["product-2"] } } }
        : details) });
      if (name === "commerce_search_products") return success({ products: [alternativeProduct], cursor: null, truncated: false });
      if (name === "commerce_get_product") return success({ product: alternativeProduct });
      throw new Error("unexpected tool");
    }),
    close: vi.fn(async () => undefined),
  };
  const requests: ModelRequest[] = [];
  let step = 0;
  const modelInvoker: CommerceModelInvoker = {
    async invoke(request) {
      requests.push(request);
      if (options.invokeError) throw options.invokeError;
      const chosen = choices[step++];
      return { calls: chosen ? Array.isArray(chosen) ? chosen : [chosen] : [], outputTokens: 10 };
    },
  };
  const graph = createInitialOutreachOfferGraph({
    context: context(),
    selector: selector as never,
    modelInvoker,
    signal: new AbortController().signal,
    startedAt: (options.evaluatedAt ?? new Date("2026-10-31T12:00:00.000Z")).getTime(),
    now: () => options.evaluatedAt ?? new Date("2026-10-31T12:00:00.000Z"),
  });
  return { graph, selector, requests };
}

describe("InitialOutreachOffer LangGraph", () => {
  it("preserves a typed model invocation failure as optional AI unavailability", async () => {
    const failure = new CommerceModelInvocationFailure({
      stage: "model.invoke", reasonCode: "MODEL_INVOCATION_FAILED",
    });
    const { graph } = fixture([], { invokeError: failure });

    const state = await graph.invoke();

    expect(state.finalDecision).toMatchObject({
      kind: "FAILURE", code: "UNAVAILABLE", reasonCode: "AI_UNAVAILABLE", retryable: true,
    });
  });

  it("performs dynamic options and details calls before accepting an identifier-only checkout choice", async () => {
    const { graph, selector, requests } = fixture([
      { name: "commerce_get_discount_options", arguments: { limit: 10, cursor: null } },
      { name: "commerce_get_discount_details", arguments: { offerId: "offer-1" } },
      { name: "submitInitialOutreachOffer", arguments: { kind: "CHECKOUT_DISCOUNT", offerIds: ["offer-1"] } },
    ]);

    const state = await graph.invoke();
    expect(state.finalDecision).toMatchObject({
      kind: "CHECKOUT_DISCOUNT",
      offerSet: { offers: [{ offerId: "offer-1", providerDiscountId: "provider-discount-1", code: "SAVE10" }] },
      members: [{ eligibility: { verdict: "SUPPORTED", eligibleLineKeys: ["line-0001"] } }],
      generation: 4,
      fingerprint: "a".repeat(64),
    });
    expect(selector.call.mock.calls.map(([name]) => name)).toEqual([
      "commerce_get_discount_options",
      "commerce_get_discount_details",
    ]);
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[2]?.messages)).not.toContain("SAVE10");
  });

  it("rejects model-authored URL/product provenance and retains a source-supported singleton fallback", async () => {
    const { graph } = fixture([
      { name: "commerce_get_discount_options", arguments: { limit: 10, cursor: null } },
      { name: "commerce_get_discount_details", arguments: { offerId: "offer-1" } },
      { name: "submitInitialOutreachOffer", arguments: {
        kind: "ALTERNATIVE_PRODUCT_PROMOTION", offerId: "offer-1", productId: "invented", variantId: null,
        url: "https://attacker.example/claim",
      } },
    ]);

    const state = await graph.invoke();
    expect(state.finalDecision).toMatchObject({ kind: "CHECKOUT_DISCOUNT", offerSet: { offers: [{ offerId: "offer-1" }] } });
  });

  it("rejects model-authored coupon codes and provider IDs, retaining only source-bound values", async () => {
    const { graph } = fixture([
      { name: "commerce_get_discount_options", arguments: { limit: 10, cursor: null } },
      { name: "commerce_get_discount_details", arguments: { offerId: "offer-1" } },
      { name: "submitInitialOutreachOffer", arguments: {
        kind: "CHECKOUT_DISCOUNT", offerIds: ["offer-1"], code: "INVENTED", providerDiscountId: "invented-provider-id",
      } },
    ]);
    const state = await graph.invoke();
    expect(state.finalDecision).toMatchObject({
      kind: "CHECKOUT_DISCOUNT",
      offerSet: { offers: [{ offerId: "offer-1", providerDiscountId: "provider-discount-1", code: "SAVE10" }] },
    });
  });

  it("rejects discount details that do not match the observed option identity", async () => {
    const foreignDetails = { ...details, offer: { ...offer, offerId: "different-shop-offer" } };
    const { graph, selector } = fixture([
      { name: "commerce_get_discount_options", arguments: { limit: 10, cursor: null } },
      { name: "commerce_get_discount_details", arguments: { offerId: "offer-1" } },
    ], { detailOverride: foreignDetails });
    const state = await graph.invoke();
    expect(selector.call.mock.calls.map(([name]) => name)).toEqual([
      "commerce_get_discount_options", "commerce_get_discount_details",
    ]);
    expect(state.finalDecision).toMatchObject({
      kind: "FAILURE", reasonCode: "DISCOUNT_DETAILS_SOURCE_IDENTITY_MISMATCH",
    });
  });

  it("blocks final decisions before the mandatory initial discount-options call", async () => {
    const { graph, selector } = fixture([
      { name: "submitInitialOutreachOffer", arguments: { kind: "NO_VERIFIED_OFFER" } },
    ]);

    const state = await graph.invoke();
    expect(state.finalDecision).toMatchObject({ kind: "FAILURE", reasonCode: "FIRST_TOOL_CALL_MUST_LIST_DISCOUNTS" });
    expect(selector.call).not.toHaveBeenCalled();
  });

  it("performs a final exact product read after the model selects an alternative from search", async () => {
    const { graph, selector } = fixture([
      { name: "commerce_get_discount_options", arguments: { limit: 10, cursor: null } },
      { name: "commerce_get_discount_details", arguments: { offerId: "offer-1" } },
      { name: "commerce_search_products", arguments: { query: "matching accessory" } },
      { name: "submitInitialOutreachOffer", arguments: {
        kind: "ALTERNATIVE_PRODUCT_PROMOTION", offerId: "offer-1", productId: "product-2", variantId: "variant-2",
      } },
    ], { alternative: true });
    const state = await graph.invoke();
    expect(selector.call.mock.calls.map(([name]) => name)).toEqual([
      "commerce_get_discount_options", "commerce_get_discount_details",
      "commerce_search_products", "commerce_get_product",
    ]);
    expect(state.finalDecision).toMatchObject({
      kind: "ALTERNATIVE_PRODUCT_PROMOTION", productId: "product-2", variantId: "variant-2",
      product: { shopId: "shop-1", product: { url: "https://shop.example/products/scarf" } },
    });
  });

  it.each([
    ["expired", { endsAt: "2026-10-31T11:59:59.999Z" }, "ACTIVE", null],
    ["not-yet-started", { startsAt: "2026-10-31T12:00:00.001Z" }, "ACTIVE", null],
    ["disabled", {}, "DISABLED", null],
    ["unavailable", {}, "ACTIVE", "2026-10-31T11:00:00.000Z"],
  ] as const)("does not promote an alternative product for a %s offer", async (_label, dateOverrides, providerStatus, unavailableAt) => {
    const offerOverride = { ...offer, ...dateOverrides };
    const detailOverride = {
      ...details,
      offer: offerOverride,
      facts: {
        ...details.facts,
        providerStatus,
        unavailableAt,
        targeting: { ...details.facts.targeting, includedProductIds: ["product-2"] },
      },
    };
    const { graph } = fixture([
      { name: "commerce_get_discount_options", arguments: { limit: 10, cursor: null } },
      { name: "commerce_get_discount_details", arguments: { offerId: "offer-1" } },
      { name: "commerce_search_products", arguments: { query: "matching accessory" } },
      { name: "submitInitialOutreachOffer", arguments: {
        kind: "ALTERNATIVE_PRODUCT_PROMOTION", offerId: "offer-1", productId: "product-2", variantId: "variant-2",
      } },
    ], { alternative: true, offerOverride: offerOverride as unknown as Record<string, unknown>, detailOverride });

    const state = await graph.invoke();
    expect(state.finalDecision).toMatchObject({
      kind: "NO_VERIFIED_OFFER", reason: "NO_APPLICABLE_OFFER",
    });
  });

  it("blocks Stage 2 product search after a preceding details call supports checkout", async () => {
    const { graph, selector } = fixture([
      { name: "commerce_get_discount_options", arguments: { limit: 10, cursor: null } },
      [
        { name: "commerce_get_discount_details", arguments: { offerId: "offer-1" } },
        { name: "commerce_search_products", arguments: { query: "another product" } },
      ],
    ]);
    const state = await graph.invoke();
    expect(selector.call.mock.calls.map(([name]) => name)).toEqual([
      "commerce_get_discount_options", "commerce_get_discount_details",
    ]);
    expect(state.failure).toMatchObject({ reasonCode: "PRODUCT_SEARCH_AFTER_SUPPORTED_CHECKOUT" });
    expect(state.finalDecision).toMatchObject({ kind: "CHECKOUT_DISCOUNT", offerSet: { offers: [{ offerId: "offer-1" }] } });
  });
});