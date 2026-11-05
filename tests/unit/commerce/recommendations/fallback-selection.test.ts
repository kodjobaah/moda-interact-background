import { describe, expect, it } from "vitest";
import { canonicalJson } from "@modainteract/moda-interact-shared/commerce";
import { selectFallbackRecommendation } from "../../../../src/commerce/recommendations/fallback-selection.js";
import { TurnRecommendationObservations } from "../../../../src/commerce/recommendations/observations.js";

describe("selectFallbackRecommendation", () => {
  it("never chooses a proposal without an observed product identity", () => {
    const observations = new TurnRecommendationObservations({ shopId: "s1", provider: "SHOPIFY",
      turn: { contractVersion: "commerce.v1", shopId: "s1", checkoutRecoveryId: "r1", conversationId: "c1", inboundVersion: 1 },
      grantId: "g1", releaseId: "rel1" });
    expect(selectFallbackRecommendation({ observations, selection: [{ scope: "PRODUCT_ONLY", basketLineId: null,
      productId: "p1", variantId: "v1", quantity: 1, promotionKind: "NONE", offerIds: [] }] })).toBeNull();
  });
  it("selects only an exact current-turn get result with a verified URL", () => {
    const observations = new TurnRecommendationObservations({ shopId: "s1", provider: "SHOPIFY",
      turn: { contractVersion: "commerce.v1", shopId: "s1", checkoutRecoveryId: "r1", conversationId: "c1", inboundVersion: 1 },
      grantId: "g1", releaseId: "rel1" });
    observations.record({ toolName: "commerce_get_product", descriptorIdentity: "product",
      arguments: { productId: "p1", variantId: "v1" }, output: { product: {
        productId: "p1", variantId: "v1", title: "Blue shirt", url: "https://shop.example/products/blue-shirt",
        available: true, unitPrice: "24.00", currency: "GBP", productType: null, vendor: null,
        categories: [], categoryIds: [], collectionIds: [], saleEvidence: null, observedAt: "2026-11-05T00:00:00Z",
      } } });
    expect(selectFallbackRecommendation({ observations, selection: [{ scope: "PRODUCT_ONLY", basketLineId: null,
      productId: "p1", variantId: "v1", quantity: 1, promotionKind: "NONE", offerIds: [] }] }))
      .toMatchObject({ productId: "p1", variantId: "v1" });
  });

  it("prefers exact basket identity and does not treat another variant as owned", () => {
    const observations = new TurnRecommendationObservations({ shopId: "s1", provider: "SHOPIFY",
      turn: { contractVersion: "commerce.v1", shopId: "s1", checkoutRecoveryId: "r1", conversationId: "c1", inboundVersion: 1 },
      grantId: "g1", releaseId: "rel1" });
    const product = (productId: string, variantId: string) => ({ productId, variantId, title: productId,
      url: `https://shop.example/products/${productId}`, available: true, unitPrice: "24.00", currency: "GBP",
      productType: null, vendor: null, categories: [], categoryIds: [], collectionIds: [], saleEvidence: null,
      observedAt: "2026-11-05T00:00:00Z" });
    for (const value of [product("basket", "owned-variant"), product("browse", "browse-variant")]) {
      observations.record({ toolName: "commerce_get_product", descriptorIdentity: "product",
        arguments: { productId: value.productId, variantId: value.variantId }, output: { product: value } });
    }
    const proposal = (productId: string, variantId: string) => ({ scope: "PRODUCT_ONLY" as const,
      basketLineId: null, productId, variantId, quantity: 1, promotionKind: "NONE" as const, offerIds: [] });
    expect(selectFallbackRecommendation({ observations,
      selection: [proposal("browse", "browse-variant"), proposal("basket", "other-variant"), proposal("basket", "owned-variant")],
      basketProductIdentities: new Set([canonicalJson({ productId: "basket", variantId: "owned-variant" })]),
    })).toMatchObject({ productId: "basket", variantId: "owned-variant" });
  });
});
