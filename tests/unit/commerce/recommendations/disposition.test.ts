import { describe, expect, it } from "vitest";
import { readRecommendationSelection } from "../../../../src/commerce/recommendations/disposition.js";

describe("readRecommendationSelection", () => {
  it("extracts only the four host-owned fields", () => {
    expect(readRecommendationSelection({ responseDisposition: "OUT_OF_SCOPE_REDIRECT", unowned: "ignored" })).toEqual({
      responseDisposition: "OUT_OF_SCOPE_REDIRECT",
    });
  });
  it("rejects incomplete pairs and shipping variants without products", () => {
    expect(readRecommendationSelection({ productRecommendationVersion: "1" })).toBeNull();
    expect(readRecommendationSelection({ responseDisposition: "STANDARD", shippingInformationSelection: {
      productId: null, variantId: "variant-1",
    } })).toEqual({ responseDisposition: "STANDARD" });
  });
  it("preserves an independently valid disposition when recommendation data is invalid", () => {
    expect(readRecommendationSelection({ responseDisposition: "OUT_OF_SCOPE_REDIRECT",
      productRecommendationVersion: "1", productRecommendations: "invalid" })).toEqual({
      responseDisposition: "OUT_OF_SCOPE_REDIRECT",
    });
  });
});
