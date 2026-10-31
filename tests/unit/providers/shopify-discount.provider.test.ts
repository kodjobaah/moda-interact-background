import { afterEach, describe, expect, it, vi } from "vitest";
import { CommerceDiscountConditionFactsSchema } from "@modainteract/moda-interact-shared/commerce";

const mocks = vi.hoisted(() => ({
  getShopifyAccessToken: vi.fn(),
}));

vi.mock("../../../src/services/shopify-session.service.js", () => ({
  getShopifyAccessToken: mocks.getShopifyAccessToken,
}));

import {
  getShopifyDiscountFailureLogFields,
  ShopifyDiscountProvider,
  ShopifyDiscountProviderError,
} from "../../../src/providers/shopify-discount.provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function response(
  nodes: unknown[],
  pageInfo = { hasNextPage: false, endCursor: null },
  shopifyPlus: boolean | null = true,
) {
  return new Response(JSON.stringify({ data: {
    shop: { plan: { shopifyPlus } },
    discountNodes: { nodes, pageInfo },
  } }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

function productTarget(products: string[], variants: string[] = [], more = false) {
  return {
    __typename: "DiscountProducts",
    products: { nodes: products.map((id) => ({ id })), pageInfo: { hasNextPage: more } },
    productVariants: { nodes: variants.map((id) => ({ id })), pageInfo: { hasNextPage: false } },
  };
}

const combinationPolicy = {
  orderDiscounts: false,
  productDiscounts: true,
  shippingDiscounts: true,
  productDiscountsWithTagsOnSameCartLine: ["LOYALTY"],
};
const discountClasses = ["PRODUCT"];
const discountTags = ["CAMPAIGN"];

function basicDiscount(overrides: Record<string, unknown> = {}) {
  return {
    __typename: "DiscountAutomaticBasic",
    title: "Observed Basic discount",
    summary: "10 percent",
    status: "ACTIVE",
    startsAt: "2026-09-20T00:00:00.000Z",
    endsAt: null,
    recurringCycleLimit: 0,
    discountClasses,
    tags: discountTags,
    combinesWith: combinationPolicy,
    customerGets: {
      items: { __typename: "AllDiscountItems" },
      value: { __typename: "DiscountPercentage", percentage: 10 },
    },
    minimumRequirement: null,
    context: { __typename: "DiscountBuyerSelectionAll" },
    ...overrides,
  };
}

describe("ShopifyDiscountProvider", () => {
  it("keeps observed-empty own and allowed tags distinct from unknown arrays", async () => {
    mocks.getShopifyAccessToken.mockResolvedValue("token-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([{
      id: "gid://shopify/DiscountAutomaticNode/empty-tags",
      discount: basicDiscount({
        tags: [],
        discountClasses: ["ORDER", "PRODUCT", "SHIPPING"],
        combinesWith: { ...combinationPolicy, productDiscountsWithTagsOnSameCartLine: [] },
      }),
    }])));

    const [discount] = await new ShopifyDiscountProvider().listDiscounts("example.myshopify.com");
    const facts = discount?.providerSnapshot.conditionFacts as {
      completeness: string;
      combination: { discountTags: string[] | null; allowedSameLineProductTags: string[] | null; discountClasses: string[] | null };
      unrepresentedConditions: string[];
    };

    expect(discount?.providerSnapshot.tags).toEqual([]);
    expect(discount?.providerSnapshot.discountClasses).toEqual(["ORDER", "PRODUCT", "SHIPPING"]);
    expect(discount?.providerSnapshot.combinesWith).toMatchObject({ productDiscountsWithTagsOnSameCartLine: [] });
    expect(facts).toMatchObject({
      completeness: "PARTIAL",
      combination: { discountTags: [], allowedSameLineProductTags: [], discountClasses: ["ORDER", "PRODUCT", "SHIPPING"] },
      unrepresentedConditions: ["COMBINATION_POLICY_NOT_REPRESENTED_IN_SHARED_FACTS"],
    });
  });

  it.each([
    { label: "missing own tags", fields: { tags: undefined }, reason: "DISCOUNT_TAGS_UNAVAILABLE", key: "tags" },
    { label: "malformed own tags", fields: { tags: ["CAMPAIGN", 7] }, reason: "DISCOUNT_TAGS_INVALID", key: "tags" },
    { label: "oversized own tags", fields: { tags: Array(65).fill("CAMPAIGN") }, reason: "DISCOUNT_TAGS_TRUNCATED", key: "tags" },
    { label: "malformed classes", fields: { discountClasses: ["PRODUCT", "UNKNOWN"] }, reason: "DISCOUNT_CLASSES_INVALID", key: "discountClasses" },
    { label: "oversized classes", fields: { discountClasses: ["ORDER", "PRODUCT", "SHIPPING", "ORDER"] }, reason: "DISCOUNT_CLASSES_TRUNCATED", key: "discountClasses" },
    { label: "unknown allowed same-line tags", fields: { combinesWith: { ...combinationPolicy, productDiscountsWithTagsOnSameCartLine: null } }, reason: "SAME_LINE_TAG_POLICY_UNAVAILABLE", key: "allowedSameLineProductTags" },
  ])("keeps $label non-authoritative", async ({ fields, reason, key }) => {
    mocks.getShopifyAccessToken.mockResolvedValue("token-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([{
      id: "gid://shopify/DiscountAutomaticNode/unknown-tags",
      discount: basicDiscount(fields),
    }])));

    const [discount] = await new ShopifyDiscountProvider().listDiscounts("example.myshopify.com");
    const facts = discount?.providerSnapshot.conditionFacts as {
      completeness: string;
      combination: Record<string, unknown>;
      unrepresentedConditions: string[];
    };

    expect(facts.completeness).toBe("PARTIAL");
    expect(facts.unrepresentedConditions).toContain(reason);
    if (key === "tags" || key === "discountClasses") expect(discount?.providerSnapshot[key]).toBeNull();
    else expect(facts.combination[key]).toBeNull();
  });

  it.each([
    { label: "subtotal without currency", value: { __typename: "DiscountMinimumSubtotal", greaterThanOrEqualToSubtotal: { amount: "75.00" } }, reason: "MINIMUM_SUBTOTAL_UNAVAILABLE" },
    { label: "unsupported minimum type", value: { __typename: "DiscountMinimumDate", minimumDate: "2026-10-01" }, reason: "MINIMUM_REQUIREMENT_UNKNOWN" },
    { label: "missing minimum type", value: undefined, reason: "MINIMUM_REQUIREMENT_UNAVAILABLE" },
  ])("keeps $label source-incomplete", async ({ value, reason }) => {
    mocks.getShopifyAccessToken.mockResolvedValue("token-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([{
      id: "gid://shopify/DiscountAutomaticNode/minimum-unknown",
      discount: basicDiscount({ minimumRequirement: value }),
    }])));

    const [discount] = await new ShopifyDiscountProvider().listDiscounts("example.myshopify.com");
    const facts = discount?.providerSnapshot.conditionFacts as {
      completeness: string;
      minimumSubtotal: string | null;
      minimumQuantity: number | null;
      unrepresentedConditions: string[];
    };

    expect(facts).toMatchObject({ completeness: "PARTIAL", minimumSubtotal: null, minimumQuantity: null });
    expect(facts.unrepresentedConditions).toContain(reason);
  });

  it("does not claim complete facts when the selected customer audience is not represented", async () => {
    mocks.getShopifyAccessToken.mockResolvedValue("token-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([{
      id: "gid://shopify/DiscountAutomaticNode/restricted-audience",
      discount: basicDiscount({ context: { __typename: "DiscountCustomerSegments" } }),
    }])));

    const [discount] = await new ShopifyDiscountProvider().listDiscounts("example.myshopify.com");
    const facts = discount?.providerSnapshot.conditionFacts as { completeness: string; unrepresentedConditions: string[] };

    expect(facts.completeness).toBe("PARTIAL");
    expect(facts.unrepresentedConditions).toContain("CUSTOMER_RESTRICTION_NOT_REPRESENTED");
  });

  it("preserves observed-empty source arrays and keeps only the pending projection reason", async () => {
    mocks.getShopifyAccessToken.mockResolvedValue("token-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([{
      id: "gid://shopify/DiscountAutomaticNode/empty-tags",
      discount: basicDiscount({
        tags: [],
        discountClasses: ["ORDER", "PRODUCT", "SHIPPING"],
        combinesWith: { ...combinationPolicy, productDiscountsWithTagsOnSameCartLine: [] },
      }),
    }])));

    const [discount] = await new ShopifyDiscountProvider().listDiscounts("example.myshopify.com");
    const facts = discount?.providerSnapshot.conditionFacts as {
      completeness: string;
      combination: { discountTags: string[] | null; allowedSameLineProductTags: string[] | null; discountClasses: string[] | null };
      unrepresentedConditions: string[];
    };

    expect(discount?.providerSnapshot.tags).toEqual([]);
    expect(discount?.providerSnapshot.discountClasses).toEqual(["ORDER", "PRODUCT", "SHIPPING"]);
    expect(discount?.providerSnapshot.combinesWith).toMatchObject({ productDiscountsWithTagsOnSameCartLine: [] });
    expect(facts).toMatchObject({
      completeness: "PARTIAL",
      combination: { discountTags: [], allowedSameLineProductTags: [], discountClasses: ["ORDER", "PRODUCT", "SHIPPING"] },
      unrepresentedConditions: ["COMBINATION_POLICY_NOT_REPRESENTED_IN_SHARED_FACTS"],
    });
  });

  it("preserves redacted GraphQL error messages and codes as bounded diagnostics", async () => {
    mocks.getShopifyAccessToken.mockResolvedValue("token-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      errors: [{
        message: "Discount lookup failed for jane@example.com, +1 415 555 1212; Discount code SAVE20; Bearer private-bearer-value shpat_secret-token-123456 https://example.test/signed?signature=private-signature",
        extensions: { code: "ACCESS_DENIED" },
      }],
      data: { privatePayload: "must never be logged" },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", "x-request-id": "request-123" },
    })));

    let caught: unknown;
    try {
      await new ShopifyDiscountProvider().listDiscounts("example.myshopify.com");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ShopifyDiscountProviderError);
    const fields = getShopifyDiscountFailureLogFields(caught);
    expect(fields).toMatchObject({
      origin: "provider_response",
      provider: "shopify",
      operation: "DiscountNodes",
      path: "/admin/api/2026-07/graphql.json",
      httpStatus: 200,
      providerRequestId: "request-123",
      redactionApplied: true,
      truncated: false,
      providerErrors: [{ code: "ACCESS_DENIED" }],
    });
    const providerErrors = fields.providerErrors as Array<{ message?: string }>;
    expect(providerErrors[0]?.message).toContain("Discount lookup failed for [REDACTED], [REDACTED]");
    expect(providerErrors[0]?.message).toContain("Discount code [REDACTED]");
    expect(providerErrors[0]?.message).toContain("Bearer [REDACTED]");
    expect(JSON.stringify(fields)).not.toContain("jane@example.com");
    expect(JSON.stringify(fields)).not.toContain("private-bearer-value");
    expect(JSON.stringify(fields)).not.toContain("shpat_secret-token-123456");
    expect(JSON.stringify(fields)).not.toContain("SAVE20");
    expect(JSON.stringify(fields)).not.toContain("private-signature");
    expect(JSON.stringify(fields)).not.toContain("example.test");
    expect(JSON.stringify(fields)).not.toContain("must never be logged");
  });

  it("normalizes code Basic fixed amounts, product and variant targets, subtotal minimum, and restricted customer scope", async () => {
    mocks.getShopifyAccessToken.mockResolvedValue("token-1");
    const fetchMock = vi.fn().mockResolvedValue(response([{
      id: "gid://shopify/DiscountCodeNode/1",
      discount: {
        __typename: "DiscountCodeBasic", title: "Selected products", summary: "20 off",
        status: "ACTIVE", startsAt: "2026-09-20T00:00:00.000Z", endsAt: null,
        codesCount: { count: 1, precision: "EXACT" },
        codes: { nodes: [{ code: "SAVE20" }], pageInfo: { hasNextPage: false } },
        asyncUsageCount: 7, usageLimit: 50, appliesOncePerCustomer: true,
        recurringCycleLimit: 0,
        discountClasses, tags: discountTags,
        combinesWith: combinationPolicy,
        customerGets: {
          items: productTarget(["gid://shopify/Product/1"], ["gid://shopify/ProductVariant/2"]),
          value: { __typename: "DiscountAmount", amount: { amount: "20.00", currencyCode: "GBP" }, appliesOnEachItem: false },
        },
        minimumRequirement: { __typename: "DiscountMinimumSubtotal", greaterThanOrEqualToSubtotal: { amount: "75.00", currencyCode: "GBP" } },
        context: { __typename: "DiscountBuyerSelectionAll" },
      },
    }]));
    vi.stubGlobal("fetch", fetchMock);

    const [discount] = await new ShopifyDiscountProvider().listDiscounts("example.myshopify.com");

    expect(discount).toMatchObject({ providerType: "DiscountCodeBasic", fixedSelectable: true, singleRedeemCode: "SAVE20" });
    expect(discount?.providerSnapshot.conditionFacts).toMatchObject({
      provider: "SHOPIFY", completeness: "PARTIAL", providerStatus: "ACTIVE",
      discountKind: "FIXED_AMOUNT", discountValue: "20.00", discountCurrency: "GBP",
      targeting: {
        kind: "MIXED", includedProductIds: ["gid://shopify/Product/1"],
        includedVariantIds: ["gid://shopify/ProductVariant/2"], includedCollectionIds: [],
        excludedProductIds: [], excludedVariantIds: [], excludedCollectionIds: [],
      },
      minimumSubtotal: "75.00", minimumQuantity: null,
      usageLimit: 50, usageCount: 7, perCustomerLimit: 1, customerScope: "ALL",
      combination: {
        discountClasses: ["PRODUCT"], shopifyPlus: true,
        combinesWith: { orderDiscounts: false, productDiscounts: true, shippingDiscounts: true },
        discountTags: ["CAMPAIGN"], allowedSameLineProductTags: ["LOYALTY"],
      },
      unrepresentedConditions: ["COMBINATION_POLICY_NOT_REPRESENTED_IN_SHARED_FACTS"],
    });
    expect(discount?.providerSnapshot.combinesWith).toEqual(combinationPolicy);
    expect(discount?.providerSnapshot.discountClasses).toEqual(discountClasses);
    expect(discount?.providerSnapshot.tags).toEqual(discountTags);
    expect(discount?.providerSnapshot.minimumRequirement).toEqual({
      __typename: "DiscountMinimumSubtotal",
      greaterThanOrEqualToSubtotal: { amount: "75.00", currencyCode: "GBP" },
    });
    expect(CommerceDiscountConditionFactsSchema.safeParse(discount?.providerSnapshot.conditionFacts).success).toBe(true);
    const request = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as { query: string; variables: { first: number; includeShopPlan: boolean } };
    expect(request.variables.first).toBeLessThanOrEqual(10);
    expect(request.variables.includeShopPlan).toBe(true);
    expect(request.query).toContain("products(first: 20)");
    expect(request.query).toContain("productVariants(first: 20)");
    expect(request.query).toContain("collections(first: 20)");
    expect(request.query).toContain("orderDiscounts productDiscounts shippingDiscounts");
    expect(request.query).toContain("productDiscountsWithTagsOnSameCartLine");
    expect(request.query).toContain("shop @include(if: $includeShopPlan) { plan { shopifyPlus } }");
    expect(request.query.match(/discountClasses tags/g)).toHaveLength(2);
    expect(request.query.match(/\.\.\. on DiscountMinimumSubtotal/g)).toHaveLength(2);
    expect(request.query.match(/\.\.\. on DiscountMinimumQuantity/g)).toHaveLength(2);
    expect(request.query.match(/recurringCycleLimit/g)).toHaveLength(2);
    expect(request.query.match(/combinesWith \{/g)).toHaveLength(2);
  });

  it("normalizes automatic Basic percentage discounts, collection targets, quantity minimum, and all-customer scope", async () => {
    mocks.getShopifyAccessToken.mockResolvedValue("token-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([{
      id: "gid://shopify/DiscountAutomaticNode/2",
      discount: {
        __typename: "DiscountAutomaticBasic", title: "Collection percentage", summary: "15 percent",
        status: "ACTIVE", startsAt: "2026-09-20T00:00:00.000Z", endsAt: null, asyncUsageCount: 11,
        recurringCycleLimit: 0,
        discountClasses, tags: discountTags,
        combinesWith: combinationPolicy,
        customerGets: {
          items: { __typename: "DiscountCollections", collections: { nodes: [{ id: "gid://shopify/Collection/4" }], pageInfo: { hasNextPage: false } } },
          value: { __typename: "DiscountPercentage", percentage: 15 },
        },
        minimumRequirement: { __typename: "DiscountMinimumQuantity", greaterThanOrEqualToQuantity: "3" },
        context: { __typename: "DiscountBuyerSelectionAll" },
      },
    }])));

    const [discount] = await new ShopifyDiscountProvider().listDiscounts("example.myshopify.com");

    expect(discount?.providerSnapshot.conditionFacts).toMatchObject({
      completeness: "PARTIAL", discountKind: "PERCENTAGE", discountValue: "15", discountCurrency: null,
      targeting: { kind: "COLLECTIONS", includedCollectionIds: ["gid://shopify/Collection/4"] },
      minimumSubtotal: null, minimumQuantity: 3, usageCount: 11, customerScope: "ALL",
      combination: { discountClasses: ["PRODUCT"], shopifyPlus: true },
      unrepresentedConditions: ["COMBINATION_POLICY_NOT_REPRESENTED_IN_SHARED_FACTS"],
    });
  });

  it("normalizes automatic Basic product targets without inferring targeting from summary text", async () => {
    mocks.getShopifyAccessToken.mockResolvedValue("token-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([{
      id: "gid://shopify/DiscountAutomaticNode/6",
      discount: {
        __typename: "DiscountAutomaticBasic", title: "Product special", summary: "All products are on sale",
        status: "ACTIVE", startsAt: "2026-09-20T00:00:00.000Z", endsAt: null,
        recurringCycleLimit: 0,
        discountClasses, tags: discountTags,
        combinesWith: combinationPolicy,
        customerGets: {
          items: productTarget(["gid://shopify/Product/42"]),
          value: { __typename: "DiscountPercentage", percentage: 5 },
        },
        minimumRequirement: null,
        context: { __typename: "DiscountBuyerSelectionAll" },
      },
    }])));

    const [discount] = await new ShopifyDiscountProvider().listDiscounts("example.myshopify.com");

    expect(discount?.providerSnapshot.conditionFacts).toMatchObject({
      completeness: "PARTIAL", discountKind: "PERCENTAGE",
      targeting: { kind: "PRODUCTS", includedProductIds: ["gid://shopify/Product/42"] },
      combination: { discountClasses: ["PRODUCT"], shopifyPlus: true },
      unrepresentedConditions: ["COMBINATION_POLICY_NOT_REPRESENTED_IN_SHARED_FACTS"],
    });
  });

  it("keeps combination facts partial when Shopify plan context is unavailable", async () => {
    mocks.getShopifyAccessToken.mockResolvedValue("token-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([{
      id: "gid://shopify/DiscountAutomaticNode/7",
      discount: {
        __typename: "DiscountAutomaticBasic", title: "Plan context unavailable", summary: "5 percent",
        status: "ACTIVE", startsAt: "2026-09-20T00:00:00.000Z", endsAt: null,
        recurringCycleLimit: 0,
        discountClasses, tags: discountTags, combinesWith: combinationPolicy,
        customerGets: {
          items: { __typename: "AllDiscountItems" },
          value: { __typename: "DiscountPercentage", percentage: 5 },
        },
        minimumRequirement: null,
        context: { __typename: "DiscountBuyerSelectionAll" },
      },
    }], { hasNextPage: false, endCursor: null }, null)));

    const [discount] = await new ShopifyDiscountProvider().listDiscounts("example.myshopify.com");
    const facts = discount?.providerSnapshot.conditionFacts as {
      completeness: string;
      combination: { shopifyPlus: boolean | null; combinesWith: object | null };
      unrepresentedConditions: string[];
    };

    expect(facts.completeness).toBe("PARTIAL");
    expect(facts.combination).toMatchObject({ shopifyPlus: null, combinesWith: {
      orderDiscounts: false, productDiscounts: true, shippingDiscounts: true,
    } });
    expect(facts.unrepresentedConditions).toContain("SHOPIFY_PLAN_UNAVAILABLE");
    expect(CommerceDiscountConditionFactsSchema.safeParse(facts).success).toBe(true);
  });

  it.each(["DiscountAutomaticBasic", "DiscountCodeBasic"])(
    "retains %s recurring cycle limits and keeps unsupported subscription restrictions partial",
    async (providerType) => {
      mocks.getShopifyAccessToken.mockResolvedValue("token-1");
      const codeFields = providerType === "DiscountCodeBasic" ? {
        codesCount: { count: 1, precision: "EXACT" },
        codes: { nodes: [{ code: "SAVE" }], pageInfo: { hasNextPage: false } },
        usageLimit: 10,
        appliesOncePerCustomer: false,
      } : {};
      const discount = {
        __typename: providerType,
        title: "Subscription discount",
        summary: "10 percent",
        status: "ACTIVE",
        startsAt: "2026-09-20T00:00:00.000Z",
        endsAt: null,
        asyncUsageCount: 0,
        recurringCycleLimit: 3,
        discountClasses,
        tags: discountTags,
        combinesWith: combinationPolicy,
        customerGets: {
          items: { __typename: "AllDiscountItems" },
          value: { __typename: "DiscountPercentage", percentage: 10 },
        },
        minimumRequirement: null,
        context: { __typename: "DiscountBuyerSelectionAll" },
        ...codeFields,
      };
      const fetchMock = vi.fn().mockResolvedValue(response([{
        id: "gid://shopify/DiscountNode/recurring",
        discount,
      }]));
      vi.stubGlobal("fetch", fetchMock);

      const [result] = await new ShopifyDiscountProvider().listDiscounts("example.myshopify.com");
      const snapshot = result?.providerSnapshot;
      const facts = snapshot?.conditionFacts as { completeness: string; unrepresentedConditions: string[] };
      const request = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as { query: string };

      expect(snapshot?.recurringCycleLimit).toBe(3);
      expect(facts.completeness).toBe("PARTIAL");
      expect(facts.unrepresentedConditions).toContain("RECURRING_CYCLE_LIMIT_NOT_REPRESENTED_IN_SHARED_FACTS");
      expect(CommerceDiscountConditionFactsSchema.safeParse(facts).success).toBe(true);
      expect(request.query.match(/recurringCycleLimit/g)).toHaveLength(2);
    },
  );

  it("does not treat a null code recurring cycle limit as complete subscription evidence", async () => {
    mocks.getShopifyAccessToken.mockResolvedValue("token-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([{
      id: "gid://shopify/DiscountCodeNode/recurring-unknown",
      discount: {
        __typename: "DiscountCodeBasic",
        title: "Unknown subscription limit",
        summary: "10 percent",
        status: "ACTIVE",
        startsAt: "2026-09-20T00:00:00.000Z",
        endsAt: null,
        codesCount: { count: 1, precision: "EXACT" },
        codes: { nodes: [{ code: "SAVE" }], pageInfo: { hasNextPage: false } },
        asyncUsageCount: 0,
        usageLimit: 10,
        appliesOncePerCustomer: false,
        recurringCycleLimit: null,
        discountClasses,
        tags: discountTags,
        combinesWith: combinationPolicy,
        customerGets: {
          items: { __typename: "AllDiscountItems" },
          value: { __typename: "DiscountPercentage", percentage: 10 },
        },
        minimumRequirement: null,
        context: { __typename: "DiscountBuyerSelectionAll" },
      },
    }])));

    const [result] = await new ShopifyDiscountProvider().listDiscounts("example.myshopify.com");
    const facts = result?.providerSnapshot.conditionFacts as { completeness: string; unrepresentedConditions: string[] };

    expect(result?.providerSnapshot.recurringCycleLimit).toBeNull();
    expect(facts.completeness).toBe("PARTIAL");
    expect(facts.unrepresentedConditions).toContain("RECURRING_CYCLE_LIMIT_UNAVAILABLE");
    expect(CommerceDiscountConditionFactsSchema.safeParse(facts).success).toBe(true);
  });

  it("marks nested target truncation partial instead of treating the returned subset as the whole target", async () => {
    mocks.getShopifyAccessToken.mockResolvedValue("token-1");
    const ids = Array.from({ length: 20 }, (_, index) => `gid://shopify/Product/${index + 1}`);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([{
      id: "gid://shopify/DiscountAutomaticNode/3",
      discount: {
        __typename: "DiscountAutomaticBasic", title: "Large target", summary: "10 percent", status: "ACTIVE",
        startsAt: "2026-09-20T00:00:00.000Z", endsAt: null,
        combinesWith: combinationPolicy,
        customerGets: { items: productTarget(ids, [], true), value: { __typename: "DiscountPercentage", percentage: 10 } },
        minimumRequirement: null, context: { __typename: "DiscountBuyerSelectionAll" },
      },
    }])));

    const [discount] = await new ShopifyDiscountProvider().listDiscounts("example.myshopify.com");
    const facts = discount?.providerSnapshot.conditionFacts as { completeness: string; targeting: { includedProductIds: string[] }; unrepresentedConditions: string[] };

    expect(facts.completeness).toBe("PARTIAL");
    expect(facts.targeting.includedProductIds).toHaveLength(20);
    expect(facts.unrepresentedConditions).toContain("TARGET_ENUMERATION_TRUNCATED");
  });

  it.each([
    ["DiscountAutomaticApp", "UNKNOWN", "UNSUPPORTED_DISCOUNT_TYPE"],
    ["DiscountCodeBxgy", "BUY_X_GET_Y", "BUY_X_GET_Y_NOT_REPRESENTED"],
  ])("keeps %s discounts incomplete and explicit", async (providerType, kind, reason) => {
    mocks.getShopifyAccessToken.mockResolvedValue("token-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([{
      id: "gid://shopify/DiscountNode/4",
      discount: { __typename: providerType, title: "Unsupported", status: "ACTIVE", startsAt: null, endsAt: null,
        ...(providerType === "DiscountCodeBxgy" ? { codesCount: { count: 2, precision: "EXACT" }, codes: { nodes: [], pageInfo: { hasNextPage: true } } } : {}) },
    }])));

    const [discount] = await new ShopifyDiscountProvider().listDiscounts("example.myshopify.com");

    expect(discount?.providerSnapshot.conditionFacts).toMatchObject({
      completeness: "PARTIAL", discountKind: kind, customerScope: "UNKNOWN",
      targeting: { kind: "UNKNOWN", includedProductIds: [], includedCollectionIds: [] },
      unrepresentedConditions: [reason],
    });
  });

  it("observes the shop plan once and reuses it across discount pages", async () => {
    mocks.getShopifyAccessToken.mockResolvedValue("token-1");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([], { hasNextPage: true, endCursor: "cursor-1" }, true))
      .mockResolvedValueOnce(response([{
        id: "gid://shopify/DiscountAutomaticNode/plan-once",
        discount: basicDiscount(),
      }], { hasNextPage: false, endCursor: null }, false));
    vi.stubGlobal("fetch", fetchMock);

    const [discount] = await new ShopifyDiscountProvider().listDiscounts("example.myshopify.com");
    const requests = fetchMock.mock.calls.map((call) => JSON.parse(call[1]?.body as string) as { variables: { includeShopPlan: boolean } });
    const facts = discount?.providerSnapshot.conditionFacts as { combination: { shopifyPlus: boolean | null } };

    expect(requests.map((request) => request.variables.includeShopPlan)).toEqual([true, false]);
    expect(facts.combination.shopifyPlus).toBe(true);
  });

  it.each([
    { status: 403, message: "Shopify denied discount access", code: "ACCESS_DENIED" },
    { status: 503, message: "Shopify discount service unavailable", code: "SERVICE_UNAVAILABLE" },
  ])("retains Shopify HTTP $status error provenance", async ({ status, message, code }) => {
    mocks.getShopifyAccessToken.mockResolvedValue("token-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      errors: [{ message, extensions: { code } }],
    }), { status, headers: { "Content-Type": "application/json", "x-request-id": `request-${status}` } })));

    let caught: unknown;
    try {
      await new ShopifyDiscountProvider().listDiscounts("example.myshopify.com");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ShopifyDiscountProviderError);
    expect(getShopifyDiscountFailureLogFields(caught)).toMatchObject({
      origin: "provider_response",
      provider: "shopify",
      operation: "DiscountNodes",
      path: "/admin/api/2026-07/graphql.json",
      httpStatus: status,
      providerRequestId: `request-${status}`,
      providerErrors: [{ message, code }],
    });
  });

  it("preserves SDK transport exception name, message, and cause when no provider response exists", async () => {
    mocks.getShopifyAccessToken.mockResolvedValue("token-1");
    const cause = new Error("socket closed");
    const transportError = new TypeError("fetch failed", { cause });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(transportError));

    let caught: unknown;
    try {
      await new ShopifyDiscountProvider().listDiscounts("example.myshopify.com");
    } catch (error) {
      caught = error;
    }

    expect(getShopifyDiscountFailureLogFields(caught)).toMatchObject({
      origin: "sdk_exception",
      errorName: "TypeError",
      errorMessage: "fetch failed",
      errorCause: [{ name: "Error", message: "socket closed" }],
      redactionApplied: false,
      truncated: false,
    });
  });

  it("preserves discount-node pagination and rejects a non-advancing cursor", async () => {
    mocks.getShopifyAccessToken.mockResolvedValue("token-1");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([], { hasNextPage: true, endCursor: "same" }))
      .mockResolvedValueOnce(response([], { hasNextPage: true, endCursor: "same" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new ShopifyDiscountProvider().listDiscounts("example.myshopify.com"))
      .rejects.toThrow("pagination returned no advancing cursor");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses only Shopify-supported summary fields for app-owned discounts", async () => {
    mocks.getShopifyAccessToken.mockResolvedValue("token-1");
    const fetchMock = vi.fn().mockResolvedValue(response([{
      id: "gid://shopify/DiscountAutomaticNode/5",
      discount: {
        __typename: "DiscountAutomaticApp", title: "App automatic discount", status: "ACTIVE",
        startsAt: "2026-09-20T00:00:00.000Z", endsAt: null,
      },
    }]));
    vi.stubGlobal("fetch", fetchMock);

    const discounts = await new ShopifyDiscountProvider().listDiscounts("example.myshopify.com");
    const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as { query: string };
    const automaticAppFragment = requestBody.query.match(/\.\.\. on DiscountAutomaticApp \{([^}]*)\}/)?.[1] ?? "";
    const codeAppFragment = requestBody.query.match(/\.\.\. on DiscountCodeApp \{([^}]*)\}/)?.[1] ?? "";

    expect(automaticAppFragment).not.toContain("summary");
    expect(codeAppFragment).not.toContain("summary");
    expect(discounts).toEqual([
      expect.objectContaining({
        providerType: "DiscountAutomaticApp", title: "App automatic discount", summary: null, fixedSelectable: false,
      }),
    ]);
  });
});
