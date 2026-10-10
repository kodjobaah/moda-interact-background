import { describe, expect, it } from "vitest";

import { validateMerchantPricingTranslatedText } from "../../../../src/services/merchant-pricing-translation/result-validation.js";

describe("Merchant Pricing translated-text validation", () => {
  it("accepts trimmed values inside the Merchant Pricing field bounds", () => {
    expect(validateMerchantPricingTranslatedText(
      { sourceEntityKind: "PLAN", sourceField: "DESCRIPTION" },
      "  plan description  ",
    )).toBe("plan description");
    expect(validateMerchantPricingTranslatedText(
      { sourceEntityKind: "HIGHLIGHT", sourceField: "TITLE" },
      "x".repeat(120),
    )).toHaveLength(120);
    expect(validateMerchantPricingTranslatedText(
      { sourceEntityKind: "HIGHLIGHT", sourceField: "DESCRIPTION" },
      "x".repeat(500),
    )).toHaveLength(500);
  });

  it("rejects empty, structurally invalid, and oversized values", () => {
    expect(validateMerchantPricingTranslatedText(
      { sourceEntityKind: "PLAN", sourceField: "DESCRIPTION" },
      "   ",
    )).toBeNull();
    expect(validateMerchantPricingTranslatedText(
      { sourceEntityKind: "PLAN", sourceField: "TITLE" },
      "Title",
    )).toBeNull();
    expect(validateMerchantPricingTranslatedText(
      { sourceEntityKind: "HIGHLIGHT", sourceField: "TITLE" },
      "x".repeat(121),
    )).toBeNull();
    expect(validateMerchantPricingTranslatedText(
      { sourceEntityKind: "HIGHLIGHT", sourceField: "DESCRIPTION" },
      "x".repeat(501),
    )).toBeNull();
  });
});
