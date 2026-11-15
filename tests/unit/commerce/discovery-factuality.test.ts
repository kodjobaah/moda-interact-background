import { describe, expect, it } from "vitest";
import { isCatalogueDiscoveryTool, shouldReferAfterUngroundedDiscovery } from "../../../src/commerce/discovery-factuality.js";
const empty = { products: [], productFacts: [], optionFacts: [] };
describe("current-discovery factuality safeguard", () => {
  it.each(["commerce_resolve_product_categories", "commerce_search_products", "commerce_get_product"])("recognizes only the actual discovery operation %s", name => {
    expect(isCatalogueDiscoveryTool(name)).toBe(true);
  });
  it.each(["commerce_get_shipping_information", "commerce_get_discount_options", "model_claimed_search", "", "COMMERCE_GET_PRODUCT"])("does not infer discovery from %s", name => {
    expect(isCatalogueDiscoveryTool(name)).toBe(false);
  });
  it("requires a current attested attempt and leaves no-attempt nonproduct answers and existing referrals unchanged", () => {
    expect(shouldReferAfterUngroundedDiscovery({ attempted: false, answerKind: "ANSWER", presentation: empty, shippingVerified: false })).toBe(false);
    expect(shouldReferAfterUngroundedDiscovery({ attempted: true, answerKind: "REFER_TO_STORE", presentation: empty, shippingVerified: false })).toBe(false);
    expect(shouldReferAfterUngroundedDiscovery({ attempted: true, answerKind: "ANSWER", presentation: empty, shippingVerified: false })).toBe(true);
  });
  it.each(["products", "productFacts", "optionFacts"] as const)("retains the independently verified %s presentation", field => {
    const presentation = { ...empty, [field]: [{}] } as never;
    expect(shouldReferAfterUngroundedDiscovery({ attempted: true, answerKind: "ANSWER", presentation, shippingVerified: false })).toBe(false);
  });
  it("retains an independently verified shipping limitation even without a stock count or policy URL", () => {
    expect(shouldReferAfterUngroundedDiscovery({ attempted: true, answerKind: "ANSWER", presentation: empty, shippingVerified: true })).toBe(false);
  });
});
