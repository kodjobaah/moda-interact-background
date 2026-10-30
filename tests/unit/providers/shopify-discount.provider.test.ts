import { afterEach, describe, expect, it, vi } from "vitest";
import { CommerceDiscountConditionFactsSchema } from "@modainteract/moda-interact-shared/commerce";

const mocks = vi.hoisted(() => ({
  getShopifyAccessToken: vi.fn(),
}));

vi.mock("../../../src/services/shopify-session.service.js", () => ({
  getShopifyAccessToken: mocks.getShopifyAccessToken,
}));

import { ShopifyDiscountProvider } from "../../../src/providers/shopify-discount.provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function response(nodes: unknown[], pageInfo = { hasNextPage: false, endCursor: null }) {
  return new Response(JSON.stringify({ data: { discountNodes: { nodes, pageInfo } } }), {
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

describe("ShopifyDiscountProvider", () => {
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
        combinesWith: combinationPolicy,
        customerGets: {
          items: productTarget(["gid://shopify/Product/1"], ["gid://shopify/ProductVariant/2"]),
          value: { __typename: "DiscountAmount", amount: { amount: "20.00", currencyCode: "GBP" }, appliesOnEachItem: false },
        },
        minimumRequirement: { __typename: "DiscountMinimumSubtotal", greaterThanOrEqualToSubtotal: { amount: "75.00", currencyCode: "GBP" } },
        context: { __typename: "DiscountCustomerSegments" },
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
      usageLimit: 50, usageCount: 7, perCustomerLimit: 1, customerScope: "RESTRICTED",
      unrepresentedConditions: ["COMBINATION_POLICY_NOT_REPRESENTED_IN_SHARED_FACTS"],
    });
    expect(discount?.providerSnapshot.combinesWith).toEqual(combinationPolicy);
    expect(CommerceDiscountConditionFactsSchema.safeParse(discount?.providerSnapshot.conditionFacts).success).toBe(true);
    const request = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as { query: string; variables: { first: number } };
    expect(request.variables.first).toBeLessThanOrEqual(10);
    expect(request.query).toContain("products(first: 20)");
    expect(request.query).toContain("productVariants(first: 20)");
    expect(request.query).toContain("collections(first: 20)");
    expect(request.query).toContain("orderDiscounts productDiscounts shippingDiscounts");
    expect(request.query).toContain("productDiscountsWithTagsOnSameCartLine");
    expect(request.query.match(/combinesWith \{/g)).toHaveLength(2);
  });

  it("normalizes automatic Basic percentage discounts, collection targets, quantity minimum, and all-customer scope", async () => {
    mocks.getShopifyAccessToken.mockResolvedValue("token-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([{
      id: "gid://shopify/DiscountAutomaticNode/2",
      discount: {
        __typename: "DiscountAutomaticBasic", title: "Collection percentage", summary: "15 percent",
        status: "ACTIVE", startsAt: "2026-09-20T00:00:00.000Z", endsAt: null, asyncUsageCount: 11,
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
      unrepresentedConditions: ["COMBINATION_POLICY_NOT_REPRESENTED_IN_SHARED_FACTS"],
    });
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
