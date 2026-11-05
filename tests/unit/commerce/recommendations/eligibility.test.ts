import { describe, expect, it } from "vitest";
import { evaluatePurchaseDiscount } from "../../../../src/commerce/recommendations/eligibility.js";

describe("evaluatePurchaseDiscount", () => {
  it("preserves the NONE policy exclusion", () => {
    expect(evaluatePurchaseDiscount({ purchase: { provider: "SHOPIFY", mode: "NONE", authorisedDiscountIds: [],
      currency: "GBP", lines: [], currentMerchandiseSubtotal: null }, offerFromOptions: null, details: null,
      evaluatedAt: new Date("2026-11-05T00:00:00.000Z") })).toMatchObject({ verdict: "NOT_APPLICABLE", reasonCodes: ["POLICY_NONE"] });
  });

  it("does not certify an order-only offer when an excluded product identity is unknown", () => {
    const offer = { offerId: "offer-1", title: "Source title", method: "AUTOMATIC" as const, code: null,
      startsAt: null, endsAt: null, support: "SUPPORTED" as const, reasonCodes: [] };
    const details = { offer, providerDiscountId: "provider-1", facts: {
      provider: "SHOPIFY" as const, completeness: "COMPLETE" as const, observedAt: "2026-11-05T00:00:00Z",
      providerStatus: "ACTIVE", unavailableAt: null, discountKind: "PERCENTAGE" as const, discountValue: "10",
      discountCurrency: null, targeting: { kind: "ALL" as const, includedProductIds: [], includedVariantIds: [],
        includedCategoryIds: [], includedCollectionIds: [], excludedProductIds: ["excluded-product"],
        excludedVariantIds: [], excludedCategoryIds: [], excludedCollectionIds: [] },
      minimumSubtotal: null, maximumSubtotal: null, subtotalRequirementCurrency: null, minimumQuantity: null,
      usageLimit: 1, usageCount: 0, perCustomerLimit: 0, customerScope: "ALL" as const,
      excludesSaleItems: false, individualUse: null, combination: { discountClasses: ["ORDER"] as const,
        shopifyPlus: false, combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
        discountTags: null, allowedSameLineProductTags: null }, unrepresentedConditions: [],
    } };
    expect(evaluatePurchaseDiscount({
      purchase: { provider: "SHOPIFY", mode: "AI_BEST_APPLICABLE", authorisedDiscountIds: [], currency: "GBP",
        lines: [{ lineKey: "line-0001", productId: null, variantId: null, categoryIds: null, collectionIds: null,
          isSaleItem: null, quantity: 1 }], currentMerchandiseSubtotal: null },
      offerFromOptions: offer, details, evaluatedAt: new Date("2026-11-05T00:00:00Z"),
    })).toMatchObject({ verdict: "UNVERIFIABLE", reasonCodes: ["TARGET_LINE_IDENTITY_UNKNOWN"] });
  });
});
