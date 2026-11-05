import { describe, expect, it } from "vitest";
import { recommendationMessages } from "../../../../src/commerce/recommendations/messages.js";
import { renderRecommendationReply } from "../../../../src/commerce/recommendations/render.js";

describe("recommendation messages and rendering", () => {
  it("provides a complete catalogue for every Shared locale", () => {
    expect(Object.keys(recommendationMessages).sort()).toEqual([
      "cs", "da", "de", "en", "es", "fi", "fr", "it", "ja", "ko", "nb", "nl", "pl", "pt-BR", "pt-PT", "sv", "th", "tr", "zh-Hans", "zh-Hant",
    ].sort());
  });
  it("renders a complete English store-only answer", () => {
    expect(renderRecommendationReply({ locale: "en", disposition: "STANDARD", storeUrl: "https://shop.example" }))
      .toBe("Store: https://shop.example");
  });
  it("renders only source-supported percent and fixed-amount terms", () => {
    expect(renderRecommendationReply({ locale: "en", disposition: "STANDARD", storeUrl: "https://shop.example",
      products: [{ title: "Shirt", url: "https://shop.example/products/shirt", quantity: 1, scope: "PRODUCT_ONLY",
        currentPrice: "24.00", currency: "GBP", offerTerms: [
          { kind: "percent", value: "10", code: "SHIRT10", automatic: false },
          { kind: "amount", value: "5.00", currency: "GBP", automatic: true },
        ] }] })).toBe([
      "For a proposed purchase of 1:", "Shirt", "Current listed price: £24.00",
      "Offer terms: a 10% discount, subject to its verified conditions.", "Code: SHIRT10",
      "Eligibility and the final price are confirmed at checkout.",
      "Offer terms: a £5.00 discount, subject to its verified conditions.",
      "Automatic offer; checkout confirms the final application.",
      "Eligibility and the final price are confirmed at checkout.",
      "View product: https://shop.example/products/shirt",
    ].join("\n"));
  });
});
