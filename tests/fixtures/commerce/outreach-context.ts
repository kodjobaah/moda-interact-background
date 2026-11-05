import { InitialOutreachAgentContextSchema } from "../../../src/agents/initial-outreach-offer.types.js";
export function outreachContext() {
  return InitialOutreachAgentContextSchema.parse({
    shopId: "shop-fixture", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1",
    environment: "TEST", platform: "SHOPIFY", mode: "AI_BEST_APPLICABLE", authorisedDiscountIds: [],
    basket: { currency: "GBP", subtotalMinor: null, totalMinor: null,
      fingerprint: "a".repeat(64), generation: 4,
      items: [{ lineKey: "line-0001", productId: "product-1", variantId: "variant-1",
        categoryIds: ["category-1"], collectionIds: null, isSaleItem: false,
        title: "Boots", category: "Shoes", quantity: 1, lineTotalMinor: null }] },
    priceReconciliation: {
      shopId: "shop-fixture", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1",
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
