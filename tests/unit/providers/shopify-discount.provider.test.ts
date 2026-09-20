import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("ShopifyDiscountProvider", () => {
  it("uses only fields supported by Shopify 2026-07 app-owned discount types", async () => {
    mocks.getShopifyAccessToken.mockResolvedValue("token-1");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        discountNodes: {
          nodes: [
            {
              id: "gid://shopify/DiscountAutomaticNode/1",
              discount: {
                __typename: "DiscountAutomaticApp",
                title: "App automatic discount",
                status: "ACTIVE",
                startsAt: "2026-09-20T00:00:00.000Z",
                endsAt: null,
              },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ShopifyDiscountProvider();
    const discounts = await provider.listDiscounts("example.myshopify.com");

    const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as { query: string };
    const automaticAppFragment = requestBody.query.match(/\.\.\. on DiscountAutomaticApp \{([^}]*)\}/)?.[1] ?? "";
    const codeAppFragment = requestBody.query.match(/\.\.\. on DiscountCodeApp \{([^}]*)\}/)?.[1] ?? "";

    expect(automaticAppFragment).not.toContain("summary");
    expect(codeAppFragment).not.toContain("summary");
    expect(discounts).toEqual([
      expect.objectContaining({
        providerType: "DiscountAutomaticApp",
        title: "App automatic discount",
        summary: null,
        fixedSelectable: false,
      }),
    ]);
  });
});
