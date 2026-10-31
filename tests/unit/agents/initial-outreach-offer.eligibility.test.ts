import { describe, expect, it } from "vitest";
import type {
  CommerceDiscountConditionFacts,
  CommerceDiscountDetails,
  CommerceOffer,
} from "@modainteract/moda-interact-shared/commerce";
import type { CheckoutPriceReconciliation } from "../../../src/services/recovery-pricing/checkout-price-reconciliation.types.js";
import { evaluateCheckoutDiscount } from "../../../src/agents/initial-outreach-offer.eligibility.js";
import { InitialOutreachAgentContextSchema } from "../../../src/agents/initial-outreach-offer.types.js";

const evaluatedAt = new Date("2026-10-31T12:00:00.000Z");

function context(overrides: Record<string, unknown> = {}) {
  return InitialOutreachAgentContextSchema.parse({
    shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1",
    environment: "TEST", platform: "SHOPIFY", mode: "AI_BEST_APPLICABLE", authorisedDiscountIds: [],
    basket: {
      currency: "GBP", subtotalMinor: null, totalMinor: 50_000, fingerprint: "a".repeat(64), generation: 7,
      items: [{ lineKey: "line-0001", productId: "product-1", variantId: "variant-1",
        categoryIds: ["category-1"], collectionIds: ["collection-1"], isSaleItem: false,
        title: "Item", category: "Shoes", quantity: 2, lineTotalMinor: 8_000 }],
    },
    priceReconciliation: null,
    platformInstructions: "Platform safety.", merchantInstructions: null,
    platformInstructionRevisionId: "platform-revision-1", merchantInstructionRevisionId: null,
    ...overrides,
  });
}

function offer(overrides: Partial<CommerceOffer> = {}): CommerceOffer {
  return {
    offerId: "offer-1", title: "Offer", method: "CODE", code: "SAVE10", startsAt: null, endsAt: null,
    support: "SUPPORTED", reasonCodes: [], ...overrides,
  };
}

function facts(overrides: Partial<CommerceDiscountConditionFacts> = {}): CommerceDiscountConditionFacts {
  return {
    provider: "SHOPIFY", completeness: "COMPLETE", observedAt: "2026-10-31T11:59:00.000Z",
    providerStatus: "ACTIVE", unavailableAt: null, discountKind: "PERCENTAGE", discountValue: "10",
    discountCurrency: "GBP",
    targeting: { kind: "PRODUCTS", includedProductIds: ["product-1"], includedVariantIds: [],
      includedCategoryIds: [], includedCollectionIds: [], excludedProductIds: [], excludedVariantIds: [],
      excludedCategoryIds: [], excludedCollectionIds: [] },
    minimumSubtotal: null, maximumSubtotal: null, subtotalRequirementCurrency: null, minimumQuantity: null,
    usageLimit: 10, usageCount: 0, perCustomerLimit: 0, customerScope: "ALL", excludesSaleItems: false,
    individualUse: null,
    combination: { discountClasses: ["PRODUCT"], shopifyPlus: null,
      combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
      discountTags: [], allowedSameLineProductTags: [] },
    unrepresentedConditions: [], ...overrides,
  };
}

function details(offerValue = offer(), factsValue = facts(), providerDiscountId: string | null = "provider-1"):
  CommerceDiscountDetails {
  return { offer: offerValue, facts: factsValue, providerDiscountId };
}

function report(overrides: Partial<CheckoutPriceReconciliation> = {}): CheckoutPriceReconciliation {
  return {
    shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1",
    generation: 7, basketFingerprint: "a".repeat(64), evaluatedAt: evaluatedAt.toISOString(),
    completeness: "COMPLETE", reasonCodes: [], currentMerchandiseSubtotal: { amountDecimal: "80.00", currency: "GBP" },
    lines: [{ lineKey: "line-0001", productId: "product-1", variantId: "variant-1", quantity: 2,
      checkoutUnitPrice: "40.00", checkoutCurrency: "GBP", catalogueUnitPrice: "40.00",
      catalogueCurrency: "GBP", catalogueObservedAt: evaluatedAt.toISOString(), catalogueComparison: "EQUAL",
      checkoutPriceChange: "UNVERIFIABLE", reasonCodes: [] }],
    ...overrides,
  };
}

function evaluate(options: {
  context?: ReturnType<typeof context>;
  option?: CommerceOffer | null;
  detail?: CommerceDiscountDetails | null;
  price?: CheckoutPriceReconciliation | null;
} = {}) {
  const selectedOffer = options.option === undefined ? offer() : options.option;
  const detail = options.detail === undefined ? details(selectedOffer ?? offer()) : options.detail;
  return evaluateCheckoutDiscount({
    context: options.context ?? context(),
    offerFromOptions: selectedOffer,
    details: detail,
    priceReconciliation: options.price ?? null,
    evaluatedAt,
  });
}

describe("evaluateCheckoutDiscount", () => {
  it("supports an exact product match and rejects a variant mismatch", () => {
    expect(evaluate().verdict).toBe("SUPPORTED");
    const mismatch = facts({ targeting: { ...facts().targeting, kind: "VARIANTS", includedProductIds: [], includedVariantIds: ["other-variant"] } });
    expect(evaluate({ detail: details(offer(), mismatch) })).toMatchObject({ verdict: "NOT_APPLICABLE", eligibleLineKeys: [] });
  });

  it("lets an excluded variant or product override an included target", () => {
    const source = facts({ targeting: { ...facts().targeting, includedProductIds: ["product-1"], excludedVariantIds: ["variant-1"] } });
    expect(evaluate({ detail: details(offer(), source) })).toMatchObject({ verdict: "NOT_APPLICABLE", reasonCodes: ["NO_MATCHING_CHECKOUT_LINES"] });
  });

  it("preserves distinct line keys for duplicate product entries", () => {
    const basket = context({ basket: { ...context().basket, items: [
      context().basket.items[0], { ...context().basket.items[0], lineKey: "line-0002" },
    ] } });
    const price = report({ lines: [
      report().lines[0]!, { ...report().lines[0]!, lineKey: "line-0002" },
    ] });
    const result = evaluate({ context: basket, price });
    expect(result).toMatchObject({ verdict: "SUPPORTED", eligibleLineKeys: ["line-0001", "line-0002"] });
  });

  it("requires provider category and collection IDs rather than category text", () => {
    const category = facts({ targeting: { ...facts().targeting, kind: "CATEGORIES", includedProductIds: [], includedCategoryIds: ["category-1"] } });
    expect(evaluate({ detail: details(offer(), category) }).verdict).toBe("SUPPORTED");
    const textOnly = context({ basket: { ...context().basket, items: [{ ...context().basket.items[0], categoryIds: null }] } });
    expect(evaluate({ context: textOnly, detail: details(offer(), category) }).verdict).toBe("UNVERIFIABLE");
    const unknownCollection = facts({ targeting: { ...facts().targeting, kind: "COLLECTIONS", includedProductIds: [], includedCollectionIds: ["collection-2"] } });
    const unknown = context({ basket: { ...context().basket, items: [{ ...context().basket.items[0], collectionIds: null }] } });
    expect(evaluate({ context: unknown, detail: details(offer(), unknownCollection) }).verdict).toBe("UNVERIFIABLE");
  });

  it("does not promote truncated targets, unknown exclusions, or an unknown variant", () => {
    const truncated = facts({ unrepresentedConditions: ["TARGETING_INCOMPLETE"] });
    expect(evaluate({ detail: details(offer(), truncated) }).verdict).toBe("UNVERIFIABLE");
    const exclusions = facts({ unrepresentedConditions: ["TARGET_EXCLUSIONS_UNKNOWN"] });
    expect(evaluate({ detail: details(offer(), exclusions) }).verdict).toBe("UNVERIFIABLE");
    const unknownVariant = context({ basket: { ...context().basket, items: [{ ...context().basket.items[0], variantId: null }] } });
    expect(evaluate({ context: unknownVariant, detail: details(offer(), facts({ targeting: {
      ...facts().targeting, kind: "VARIANTS", includedProductIds: [], includedVariantIds: ["variant-1"],
    } })) }).verdict).toBe("UNVERIFIABLE");
  });

  it("uses only matching complete BG016 subtotal evidence for inclusive thresholds", () => {
    const thresholdFacts = facts({ minimumSubtotal: "80.00", subtotalRequirementCurrency: "GBP" });
    expect(evaluate({ detail: details(offer(), thresholdFacts), price: report() }).verdict).toBe("SUPPORTED");
    expect(evaluate({ detail: details(offer(), thresholdFacts), price: report({ currentMerchandiseSubtotal: { amountDecimal: "79.99", currency: "GBP" } }) }).verdict).toBe("NOT_APPLICABLE");
    expect(evaluate({ detail: details(offer(), thresholdFacts), price: report({ currentMerchandiseSubtotal: { amountDecimal: "80.00", currency: "EUR" } }) }).verdict).toBe("UNVERIFIABLE");
    expect(evaluate({ detail: details(offer(), thresholdFacts), price: null }).verdict).toBe("UNVERIFIABLE");
  });

  it("rejects a threshold using wrong or unknown currency and does not substitute order total", () => {
    const minimum = facts({ minimumSubtotal: "100.00", subtotalRequirementCurrency: "GBP" });
    const lowSubtotal = report({ currentMerchandiseSubtotal: { amountDecimal: "80.00", currency: "GBP" } });
    expect(evaluate({ detail: details(offer(), minimum), price: lowSubtotal }).verdict).toBe("NOT_APPLICABLE");
    expect(evaluate({ detail: details(offer(), facts({ minimumSubtotal: "1.00", subtotalRequirementCurrency: null })), price: report() }).verdict).toBe("UNVERIFIABLE");
  });

  it("keeps minimum quantity unverified without documented scope or line amount", () => {
    expect(evaluate({ detail: details(offer(), facts({ minimumQuantity: 2 })) })).toMatchObject({
      verdict: "UNVERIFIABLE", reasonCodes: ["MINIMUM_QUANTITY_SCOPE_UNKNOWN"],
    });
    const noLineAmount = context({ basket: { ...context().basket, items: [{ ...context().basket.items[0], lineTotalMinor: null }] } });
    expect(evaluate({ context: noLineAmount, detail: details(offer(), facts({ minimumQuantity: 2 })) }).verdict).toBe("UNVERIFIABLE");
  });

  it("rejects expired, future, revoked, unsupported-code and NONE-mode offers", () => {
    const expired = offer({ endsAt: "2026-10-31T11:00:00.000Z" });
    expect(evaluate({ option: expired, detail: details(expired) }).verdict).toBe("NOT_APPLICABLE");
    const future = offer({ startsAt: "2026-11-01T00:00:00.000Z" });
    expect(evaluate({ option: future, detail: details(future) }).verdict).toBe("NOT_APPLICABLE");
    const fixed = context({ mode: "FIXED", authorisedDiscountIds: ["other-offer"] });
    expect(evaluate({ context: fixed }).verdict).toBe("NOT_APPLICABLE");
    expect(evaluate({ detail: details(offer({ support: "UNSUPPORTED" })) }).verdict).toBe("NOT_APPLICABLE");
    expect(evaluate({ context: context({ mode: "NONE" }) }).reasonCodes).toContain("POLICY_NONE");
  });

  it("classifies a known unselected FIXED offer as not applicable", () => {
    expect(evaluate({ context: context({ mode: "FIXED", authorisedDiscountIds: ["other-offer"] }) }))
      .toMatchObject({ verdict: "NOT_APPLICABLE", reasonCodes: ["OFFER_NOT_SELECTED"] });
  });

  it("abstains for customer, usage, sale and expiry uncertainty", () => {
    expect(evaluate({ detail: details(offer(), facts({ customerScope: "RESTRICTED" })) }).verdict).toBe("UNVERIFIABLE");
    expect(evaluate({ detail: details(offer(), facts({ usageLimit: 5, usageCount: null })) }).verdict).toBe("UNVERIFIABLE");
    const saleUnknown = context({ basket: { ...context().basket, items: [{ ...context().basket.items[0], isSaleItem: null }] } });
    expect(evaluate({ context: saleUnknown, detail: details(offer(), facts({ excludesSaleItems: true })) }).verdict).toBe("UNVERIFIABLE");
    expect(evaluate({ detail: details(offer(), facts({ unrepresentedConditions: ["EXPIRY_UNVERIFIED"] })) }).verdict).toBe("UNVERIFIABLE");
    expect(evaluate({ detail: details(offer(), facts({ perCustomerLimit: null })) }).verdict).toBe("UNVERIFIABLE");
  });

  it("returns no checkout line identities for source-proven order or shipping discounts", () => {
    const orderFacts = facts({ combination: { ...facts().combination, discountClasses: ["ORDER"] } });
    expect(evaluate({ detail: details(offer(), orderFacts) })).toMatchObject({
      verdict: "SUPPORTED", eligibleLineKeys: [], reasonCodes: ["SOURCE_SUPPORTED_NON_LINE_DISCOUNT"],
    });
  });

  it("allows singleton facts partial only for the explicitly classified combination gap", () => {
    const combinationOnly = facts({ completeness: "PARTIAL", unrepresentedConditions: ["COMBINATION_POLICY_NOT_REPRESENTED_IN_SHARED_FACTS"] });
    expect(evaluate({ detail: details(offer(), combinationOnly) }).verdict).toBe("SUPPORTED");
    const arbitrary = facts({ completeness: "PARTIAL", unrepresentedConditions: ["CUSTOMER_RULE_NOT_MAPPED"] });
    expect(evaluate({ detail: details(offer(), arbitrary) }).verdict).toBe("UNVERIFIABLE");
  });

  it("treats Woo zero sentinels as no limits but enforces positive maximums and exhaustion", () => {
    const wooContext = context({ platform: "WOOCOMMERCE", mode: "AI_BEST_APPLICABLE" });
    const wooOffer = offer({ offerId: "offer-1", method: "CODE", code: "SAVE10" });
    const wooBase = facts({ provider: "WOOCOMMERCE", targeting: { ...facts().targeting, kind: "ALL" },
      individualUse: false, usageLimit: 0, usageCount: null, perCustomerLimit: 0 });
    expect(evaluate({ context: wooContext, detail: details(wooOffer, { ...wooBase, minimumSubtotal: "0", maximumSubtotal: "0" }) }).verdict).toBe("SUPPORTED");
    const positiveMax = { ...wooBase, maximumSubtotal: "70.00", subtotalRequirementCurrency: "GBP" };
    expect(evaluate({ context: wooContext, detail: details(wooOffer, positiveMax), price: report() }).verdict).toBe("NOT_APPLICABLE");
    expect(evaluate({ context: wooContext, detail: details(wooOffer, { ...wooBase, usageLimit: 2, usageCount: 2 }) }).verdict).toBe("NOT_APPLICABLE");
  });

  it("does not treat a missing provider discount identity as source evidence", () => {
    expect(evaluate({ detail: details(offer(), facts(), null) }).verdict).toBe("UNVERIFIABLE");
  });
});