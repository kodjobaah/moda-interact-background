import { describe, expect, it } from "vitest";
import type { CommerceDiscountConditionFacts, CommerceDiscountDetails, CommerceOffer } from "@modainteract/moda-interact-shared/commerce";
import { evaluateCheckoutDiscount } from "../../../src/agents/initial-outreach-offer.eligibility.js";
import { selectCompatibleCheckoutOffers } from "../../../src/agents/initial-outreach-offer.combinations.js";
import { InitialOutreachAgentContextSchema, type ObservedCheckoutOffer } from "../../../src/agents/initial-outreach-offer.types.js";

const evaluatedAt = new Date("2026-10-31T12:00:00.000Z");

function context(platform: "SHOPIFY" | "WOOCOMMERCE" = "SHOPIFY", twoLines = false) {
  const line = { productId: "product-1", variantId: "variant-1", categoryIds: ["category-1"],
    collectionIds: ["collection-1"], isSaleItem: false, title: "Product", category: null,
    quantity: 1, lineTotalMinor: 1_000 };
  return InitialOutreachAgentContextSchema.parse({
    shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1",
    environment: "TEST", platform, mode: "AI_BEST_APPLICABLE", authorisedDiscountIds: [],
    basket: { currency: "GBP", subtotalMinor: null, totalMinor: null, fingerprint: "a".repeat(64), generation: 1,
      items: [{ ...line, lineKey: "line-0001" }, ...(twoLines ? [{ ...line, lineKey: "line-0002", productId: "product-2", variantId: "variant-2" }] : [])] },
    priceReconciliation: null, platformInstructions: "platform", merchantInstructions: null,
    platformInstructionRevisionId: "p1", merchantInstructionRevisionId: null,
  });
}

function sourceOffer(id: string): CommerceOffer {
  return { offerId: id, title: id, method: "CODE", code: `CODE-${id}`, startsAt: null, endsAt: null,
    support: "SUPPORTED", reasonCodes: [] };
}

function sourceFacts(platform: "SHOPIFY" | "WOOCOMMERCE", overrides: Partial<CommerceDiscountConditionFacts> = {}): CommerceDiscountConditionFacts {
  return {
    provider: platform, completeness: "COMPLETE", observedAt: "2026-10-31T11:00:00.000Z", providerStatus: "ACTIVE",
    unavailableAt: null, discountKind: "PERCENTAGE", discountValue: "10", discountCurrency: "GBP",
    targeting: { kind: "PRODUCTS", includedProductIds: ["product-1"], includedVariantIds: [], includedCategoryIds: [],
      includedCollectionIds: [], excludedProductIds: [], excludedVariantIds: [], excludedCategoryIds: [], excludedCollectionIds: [] },
    minimumSubtotal: null, maximumSubtotal: null, subtotalRequirementCurrency: null, minimumQuantity: null,
    usageLimit: 10, usageCount: 0, perCustomerLimit: 0, customerScope: "ALL", excludesSaleItems: false,
    individualUse: platform === "WOOCOMMERCE" ? false : null,
    combination: { discountClasses: ["PRODUCT"], shopifyPlus: true,
      combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
      discountTags: ["a"], allowedSameLineProductTags: ["b"] },
    unrepresentedConditions: [], ...overrides,
  };
}

function candidate(id: string, platform: "SHOPIFY" | "WOOCOMMERCE" = "SHOPIFY",
  factsOverrides: Partial<CommerceDiscountConditionFacts> = {}, twoLines = false): ObservedCheckoutOffer {
  const offer = sourceOffer(id);
  const details: CommerceDiscountDetails = { offer, facts: sourceFacts(platform, factsOverrides), providerDiscountId: `provider-${id}` };
  const decision = evaluateCheckoutDiscount({ context: context(platform, twoLines), offerFromOptions: offer, details,
    priceReconciliation: null, evaluatedAt });
  return { offer, details, eligibility: decision };
}

describe("selectCompatibleCheckoutOffers", () => {
  it("supports reciprocal Shopify PRODUCT discounts on disjoint lines without Plus or tags", () => {
    const a = candidate("a", "SHOPIFY", { combination: { ...sourceFacts("SHOPIFY").combination,
      shopifyPlus: null, discountTags: null, allowedSameLineProductTags: null } }, true);
    const bOffer = sourceOffer("b");
    const b = { ...candidate("b", "SHOPIFY", { targeting: { ...sourceFacts("SHOPIFY").targeting,
      includedProductIds: ["product-2"] }, combination: { ...sourceFacts("SHOPIFY").combination,
      shopifyPlus: null, discountTags: null, allowedSameLineProductTags: null } }, true), offer: bOffer,
      details: { ...candidate("b", "SHOPIFY", { targeting: { ...sourceFacts("SHOPIFY").targeting,
        includedProductIds: ["product-2"] }, combination: { ...sourceFacts("SHOPIFY").combination,
        shopifyPlus: null, discountTags: null, allowedSameLineProductTags: null } }, true).details, offer: bOffer } };
    expect(selectCompatibleCheckoutOffers({ candidates: [a, b], proposedOfferIds: ["a", "b"] })).toMatchObject({ verdict: "SUPPORTED", offerIds: ["a", "b"] });
  });

  it("requires Plus, reciprocal class booleans, and both same-line tag intersections", () => {
    const base = sourceFacts("SHOPIFY").combination;
    const a = candidate("a", "SHOPIFY", { combination: { ...base, shopifyPlus: true, discountTags: ["tag-a"], allowedSameLineProductTags: ["tag-b"] } });
    const b = candidate("b", "SHOPIFY", { combination: { ...base, shopifyPlus: true, discountTags: ["tag-b"], allowedSameLineProductTags: ["tag-a"] } });
    expect(selectCompatibleCheckoutOffers({ candidates: [a, b], proposedOfferIds: ["a", "b"] }).offerIds).toEqual(["a", "b"]);
    const noPlus = candidate("c", "SHOPIFY", { combination: { ...base, shopifyPlus: false, discountTags: ["tag-a"], allowedSameLineProductTags: ["tag-b"] } });
    expect(selectCompatibleCheckoutOffers({ candidates: [a, noPlus], proposedOfferIds: ["a", "c"] }).offerIds).toEqual(["a"]);
    const oneWay = candidate("d", "SHOPIFY", { combination: { ...base, shopifyPlus: true, discountTags: ["tag-x"], allowedSameLineProductTags: ["tag-a"] } });
    expect(selectCompatibleCheckoutOffers({ candidates: [a, oneWay], proposedOfferIds: ["a", "d"] }).offerIds).toEqual(["a"]);
    const unknown = candidate("e", "SHOPIFY", { combination: { ...base, shopifyPlus: null } });
    expect(selectCompatibleCheckoutOffers({ candidates: [a, unknown], proposedOfferIds: ["a", "e"] }).offerIds).toEqual(["a"]);
  });

  it("validates every declared cross-class permission in both directions", () => {
    const aFacts = sourceFacts("SHOPIFY");
    const order = candidate("order", "SHOPIFY", { combination: { ...aFacts.combination, discountClasses: ["ORDER"] } });
    const product = candidate("product", "SHOPIFY", { combination: { ...aFacts.combination, discountClasses: ["PRODUCT"] } });
    expect(selectCompatibleCheckoutOffers({ candidates: [order, product], proposedOfferIds: ["order", "product"] }).offerIds).toEqual(["order", "product"]);
    const falsePermission = candidate("false", "SHOPIFY", { combination: { ...aFacts.combination,
      combinesWith: { ...aFacts.combination.combinesWith!, orderDiscounts: false } } });
    expect(selectCompatibleCheckoutOffers({ candidates: [falsePermission, product], proposedOfferIds: ["false", "product"] }).offerIds).toEqual(["false"]);
  });

  it("checks reciprocal PRODUCT and SHIPPING permissions and distinguishes false from unknown", () => {
    const base = sourceFacts("SHOPIFY").combination;
    const product = candidate("product", "SHOPIFY", { combination: { ...base, discountClasses: ["PRODUCT"] } });
    const shipping = candidate("shipping", "SHOPIFY", { combination: { ...base, discountClasses: ["SHIPPING"] } });
    expect(selectCompatibleCheckoutOffers({ candidates: [product, shipping], proposedOfferIds: ["product", "shipping"] }))
      .toMatchObject({ verdict: "SUPPORTED", offerIds: ["product", "shipping"] });

    const falsePermission = candidate("false-shipping", "SHOPIFY", { combination: { ...base,
      discountClasses: ["SHIPPING"], combinesWith: { ...base.combinesWith!, productDiscounts: false } } });
    expect(selectCompatibleCheckoutOffers({ candidates: [product, falsePermission], proposedOfferIds: ["product", "false-shipping"] }).offerIds)
      .toEqual(["product"]);
    const unknownPermission = candidate("unknown-shipping", "SHOPIFY", { combination: { ...base,
      discountClasses: ["SHIPPING"], combinesWith: { ...base.combinesWith!, productDiscounts: null } } });
    expect(selectCompatibleCheckoutOffers({ candidates: [product, unknownPermission], proposedOfferIds: ["product", "unknown-shipping"] }).offerIds)
      .toEqual(["product"]);
  });

  it("falls back to a singleton when same-line PRODUCT overlap is unknown", () => {
    const a = candidate("a");
    const b = candidate("b");
    const unknownOverlap = {
      ...b,
      eligibility: { ...b.eligibility, eligibleLineKeys: [] },
    };
    expect(selectCompatibleCheckoutOffers({ candidates: [a, unknownOverlap], proposedOfferIds: ["a", "b"] }))
      .toMatchObject({ verdict: "SUPPORTED", offerIds: ["a"], reasonCodes: ["SINGLETON_REQUIRES_NATIVE_CHECKOUT_VALIDATION"] });
  });

  it("supports Woo core pairs only when both individualUse values are false", () => {
    const a = candidate("a", "WOOCOMMERCE");
    const b = candidate("b", "WOOCOMMERCE");
    expect(selectCompatibleCheckoutOffers({ candidates: [a, b], proposedOfferIds: ["a", "b"] })).toMatchObject({
      verdict: "SUPPORTED", offerIds: ["a", "b"], reasonCodes: ["WOO_NATIVE_CHECKOUT_VALIDATION_REQUIRED"],
    });
    const trueUse = candidate("c", "WOOCOMMERCE", { individualUse: true });
    expect(selectCompatibleCheckoutOffers({ candidates: [a, trueUse], proposedOfferIds: ["a", "c"] }).offerIds).toEqual(["a"]);
    const unknownUse = candidate("d", "WOOCOMMERCE", { individualUse: null });
    expect(selectCompatibleCheckoutOffers({ candidates: [a, unknownUse], proposedOfferIds: ["a", "d"] }).offerIds).toEqual(["a"]);
  });

  it("keeps the largest pairwise-supported subset and checks every triple pair", () => {
    const common = sourceFacts("SHOPIFY").combination;
    const a = candidate("a", "SHOPIFY", { combination: { ...common, discountClasses: ["ORDER"] } });
    const b = candidate("b", "SHOPIFY", { combination: { ...common, discountClasses: ["ORDER"],
      combinesWith: { ...common.combinesWith!, orderDiscounts: false } } });
    const c = candidate("c", "SHOPIFY", { combination: { ...common, discountClasses: ["ORDER"] } });
    expect(selectCompatibleCheckoutOffers({ candidates: [a, b, c], proposedOfferIds: ["a", "b", "c"] })).toMatchObject({ verdict: "SUPPORTED", offerIds: ["a", "c"] });
  });

  it("deduplicates conflicting source identities and never accepts unknown candidates", () => {
    const a = candidate("a");
    const duplicateProvider = { ...candidate("b"), details: { ...candidate("b").details, providerDiscountId: "provider-a" } };
    expect(selectCompatibleCheckoutOffers({ candidates: [a, duplicateProvider], proposedOfferIds: ["a", "b"] }).offerIds).toEqual(["a"]);
    expect(selectCompatibleCheckoutOffers({ candidates: [a], proposedOfferIds: ["invented"] })).toMatchObject({ verdict: "UNVERIFIABLE", offerIds: [] });
  });
});