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
    targeting: { kind: "PRODUCTS" as const, includedProductIds: ["gid://shopify/Product/1"], includedVariantIds: [],
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
    shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1", checkoutUrl: "https://shop.example/checkout",
    environment: "TEST", platform: "SHOPIFY", mode: "AI_BEST_APPLICABLE", authorisedDiscountIds: [],
    basket: { currency: "GBP", subtotalMinor: null, totalMinor: null,
      fingerprint: "a".repeat(64), generation: 4,
      items: [{ lineKey: "line-0001", productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/2",
        categoryIds: ["category-1"], collectionIds: null, isSaleItem: false,
        title: "Boots", category: "Shoes", quantity: 1, lineTotalMinor: null }] },
    priceReconciliation: {
      shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1",
      generation: 4, basketFingerprint: "a".repeat(64), evaluatedAt: "2026-10-31T12:00:00.000Z",
      lines: [{ lineKey: "line-0001", productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/2", quantity: 1,
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
  productId: "gid://shopify/Product/3", variantId: "gid://shopify/ProductVariant/4", title: "Matching scarf",
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
  availableTools?: OutreachMcpToolDescriptor[];
  genericData?: Record<string, unknown>;
  behaviourPrompt?: string;
} = {}) {
  const selector = {
    connect: vi.fn(async () => undefined),
    tools: vi.fn(async () => options.availableTools ?? tools),
    profile: vi.fn(() => ({ behaviourPrompt: options.behaviourPrompt ?? "Trusted profile behavior." })),
    call: vi.fn(async (name: string) => {
      if (name === "commerce_get_discount_options") return success({
        mode: "AI_BEST_APPLICABLE", offers: [{ ...offer, ...options.offerOverride }], cursor: null, truncated: false,
      });
      if (name === "commerce_get_discount_details") return success({ details: options.detailOverride ?? (options.alternative
        ? { ...details, facts: { ...details.facts, targeting: { ...details.facts.targeting, includedProductIds: ["gid://shopify/Product/3"] } } }
        : details) });
      if (name === "commerce_search_products") return success({ products: [alternativeProduct], cursor: null, truncated: false });
      if (name === "commerce_get_product") return success({ product: { ...alternativeProduct,
        productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/2", unitPrice: "12.00", currency: "GBP" }, ...(options.genericData ?? {}) });
      if (options.genericData) return success(options.genericData);
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

describe("InitialOutreachOffer shared evaluator facade", () => {
  it("retains a typed model failure as a fail-closed evaluation refusal", async () => {
    const failure = new CommerceModelInvocationFailure({ stage: "model.invoke", reasonCode: "MODEL_INVOCATION_FAILED" });
    const { graph } = fixture([], { invokeError: failure });
    expect((await graph.invoke()).finalDecision).toMatchObject({ kind: "FAILURE", retryable: false });
  });
  it("performs exact product/options/details and final revalidation before an identifier-only checkout choice", async () => {
    const { graph, selector, requests } = fixture([
      { name: "commerce_get_discount_options", arguments: { limit: 10, cursor: null } },
      { name: "commerce_get_discount_details", arguments: { offerId: "offer-1" } },
      { name: "submitInitialOutreachOffer", arguments: { kind: "CHECKOUT_DISCOUNT", offerIds: ["offer-1"] } },
    ]);
    const state = await graph.invoke();
    expect(state.finalDecision).toMatchObject({ kind: "CHECKOUT_DISCOUNT", offerSet: { offers: [{ offerId: "offer-1", providerDiscountId: "provider-discount-1", code: "SAVE10" }] }, members: [{ eligibility: { verdict: "SUPPORTED", eligibleLineKeys: ["line-0001"] } }], generation: 4, fingerprint: "a".repeat(64) });
    expect(selector.call.mock.calls.map(([name]) => name)).toEqual(["commerce_get_product", "commerce_get_discount_options", "commerce_get_discount_details", "commerce_get_product", "commerce_get_discount_details"]);
    expect(requests).toHaveLength(3);
    expect(requests[2]!.tools.find(t => t.name === "submitInitialOutreachOffer")!.inputSchema).not.toHaveProperty("code");
  });
  it("rejects model-authored URL/product provenance instead of falling back to an alternative", async () => {
    const { graph } = fixture([{ name: "commerce_get_discount_options", arguments: { limit: 10, cursor: null } }, { name: "commerce_get_discount_details", arguments: { offerId: "offer-1" } }, { name: "submitInitialOutreachOffer", arguments: { kind: "ALTERNATIVE_PRODUCT_PROMOTION", offerId: "offer-1", productId: "invented", variantId: null, url: "https://attacker.example/claim" } }]);
    expect((await graph.invoke()).finalDecision).toMatchObject({ kind: "FAILURE", reasonCode: "OUTREACH_EVALUATION_OUTSIDE_CHECKOUT" });
  });
  it("rejects model-authored coupon codes and provider IDs rather than treating them as source facts", async () => {
    const { graph } = fixture([{ name: "commerce_get_discount_options", arguments: { limit: 10, cursor: null } }, { name: "commerce_get_discount_details", arguments: { offerId: "offer-1" } }, { name: "submitInitialOutreachOffer", arguments: { kind: "CHECKOUT_DISCOUNT", offerIds: ["offer-1"], code: "INVENTED", providerDiscountId: "invented-provider-id" } }]);
    const result = (await graph.invoke()).finalDecision;
    expect(result).toMatchObject({ kind: "FAILURE", reasonCode: "OUTREACH_EVALUATION_INVALID_RESULT" }); expect(JSON.stringify(result)).not.toMatch(/INVENTED|invented-provider-id/);
  });
  it("rejects discount details that do not match the observed option identity", async () => {
    const { graph, selector } = fixture([{ name: "commerce_get_discount_options", arguments: { limit: 10, cursor: null } }, { name: "commerce_get_discount_details", arguments: { offerId: "offer-1" } }], { detailOverride: { ...details, offer: { ...offer, offerId: "different-shop-offer" } } });
    expect((await graph.invoke()).finalDecision).toMatchObject({ kind: "FAILURE", reasonCode: "OUTREACH_EVALUATION_IDENTITY_MISMATCH" });
    expect(selector.call.mock.calls.map(([name]) => name)).toEqual(["commerce_get_product", "commerce_get_discount_options", "commerce_get_discount_details"]);
  });
  it("blocks final decisions before the mandatory discount-options call, after required product verification", async () => {
    const { graph, selector } = fixture([{ name: "submitInitialOutreachOffer", arguments: { kind: "NO_VERIFIED_OFFER" } }]);
    expect((await graph.invoke()).finalDecision).toMatchObject({ kind: "FAILURE", reasonCode: "OUTREACH_EVALUATION_INVALID_RESULT" });
    expect(selector.call.mock.calls.map(([name]) => name)).toEqual(["commerce_get_product"]);
  });
  it("refuses product search and never selects a noncheckout product", async () => {
    const { graph, selector } = fixture([{ name: "commerce_get_discount_options", arguments: { limit: 10, cursor: null } }, { name: "commerce_get_discount_details", arguments: { offerId: "offer-1" } }, { name: "commerce_search_products", arguments: { query: "matching accessory" } }], { alternative: true });
    expect((await graph.invoke()).finalDecision).toMatchObject({ kind: "FAILURE", reasonCode: "OUTREACH_EVALUATION_OUTSIDE_CHECKOUT" });
    expect(selector.call.mock.calls.map(([name]) => name)).not.toContain("commerce_search_products");
  });
  it.each([
    ["expired", { endsAt: "2026-10-31T11:59:59.999Z" }, "ACTIVE", null],
    ["not-yet-started", { startsAt: "2026-10-31T12:00:00.001Z" }, "ACTIVE", null],
    ["disabled", {}, "DISABLED", null], ["unavailable", {}, "ACTIVE", "2026-10-31T11:00:00.000Z"],
  ] as const)("does not authorize a checkout or alternative promotion for a %s offer", async (_label, dateOverrides, providerStatus, unavailableAt) => {
    const changed = { ...offer, ...dateOverrides };
    const { graph } = fixture([{ name: "commerce_get_discount_options", arguments: { limit: 10, cursor: null } }, { name: "commerce_get_discount_details", arguments: { offerId: "offer-1" } }, { name: "submitInitialOutreachOffer", arguments: { kind: "CHECKOUT_DISCOUNT", offerIds: ["offer-1"] } }], { offerOverride: changed, detailOverride: { ...details, offer: changed, facts: { ...details.facts, providerStatus, unavailableAt } } });
    expect((await graph.invoke()).finalDecision).toMatchObject({ kind: "FAILURE", reasonCode: "OUTREACH_EVALUATION_INVALID_RESULT" });
  });
  it("blocks product search even after details support checkout, with no unsafe fallback", async () => {
    const { graph, selector } = fixture([{ name: "commerce_get_discount_options", arguments: { limit: 10, cursor: null } }, [{ name: "commerce_get_discount_details", arguments: { offerId: "offer-1" } }, { name: "commerce_search_products", arguments: { query: "another product" } }]]);
    expect((await graph.invoke()).finalDecision).toMatchObject({ kind: "FAILURE", reasonCode: "OUTREACH_EVALUATION_OUTSIDE_CHECKOUT" });
    expect(selector.call.mock.calls.map(([name]) => name)).toEqual(["commerce_get_product", "commerce_get_discount_options", "commerce_get_discount_details"]);
  });
});

describe("checkout-only ports reject unrelated generic outreach reads", () => {
 const fifth = { name: "commerce_read_reference", description: "Reference", inputSchema: { type: "object" } };
 it("refuses a fifth read without granting offer/product authority", async () => {
  const { graph, selector, requests } = fixture([{ name: fifth.name, arguments: {} }], { availableTools: [fifth], genericData: { offerId: "forged", savings: "100", url: "https://forged.example" } });
  const result = (await graph.invoke()).finalDecision; expect(result).toMatchObject({ kind: "FAILURE", code: "DENIED" }); expect(result).not.toHaveProperty("evaluation"); expect(selector.call).not.toHaveBeenCalled(); expect(requests).toHaveLength(0);
 });
 it("cannot manufacture a checkout offer from generic fields", async () => {
  const { graph, selector } = fixture([{ name: fifth.name, arguments: {} }], { availableTools: [fifth], genericData: { offers: [offer], details } });
  expect((await graph.invoke()).finalDecision).toMatchObject({ kind: "FAILURE", code: "DENIED" }); expect(selector.call).not.toHaveBeenCalled();
 });
 it("does not invent removed discount tools to authorize a no-offer result", async () => {
  const { graph, selector } = fixture([{ name: "submitInitialOutreachOffer", arguments: { kind: "NO_VERIFIED_OFFER" } }], { availableTools: [fifth] });
  expect((await graph.invoke()).finalDecision).toMatchObject({ kind: "FAILURE", code: "DENIED" }); expect(selector.call).not.toHaveBeenCalled();
 });
 it("keeps the fixed result budget and rejects oversized source data", async () => {
  const { graph } = fixture([], { genericData: { text: "x".repeat(33 * 1024) } });
  const result = (await graph.invoke()).finalDecision; expect(result).toMatchObject({ kind: "FAILURE", reasonCode: "OUTREACH_EVALUATION_INVALID_RESULT" }); expect(result).not.toHaveProperty("evaluation");
 });
});

it("retains pinned published behavior below host safety while using checkout-only ports", async () => {
 const { graph, requests } = fixture([{ name: "commerce_get_discount_options", arguments: { limit: 10, cursor: null } }, { name: "submitInitialOutreachOffer", arguments: { kind: "NO_VERIFIED_OFFER" } }], { behaviourPrompt: "Ask about delivery preferences." });
 expect((await graph.invoke()).finalDecision.kind).toBe("NO_VERIFIED_OFFER");
 const instructions = requests[0]!.instructions.join("\n");
 expect(instructions).toContain("Use source data only.");
 expect(instructions.indexOf("Consent, authorization")).toBeLessThan(instructions.indexOf("Ask about delivery preferences."));
 expect(requests[0]!.tools.map(t=>t.name)).not.toContain("commerce_search_products");
});
