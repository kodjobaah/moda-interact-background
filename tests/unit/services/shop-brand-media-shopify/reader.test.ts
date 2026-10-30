import { describe, expect, it, vi } from "vitest";
import { ShopifyAdminBrandReader, SHOPIFY_BRAND_QUERY } from "../../../../src/services/shop-brand-media-shopify/reader.js";
import { ShopifyBrandSyncError } from "../../../../src/services/shop-brand-media-shopify/contracts.js";
import { shopifyBrandObservations } from "../../../../src/services/shop-brand-media-shopify/mapping.js";

const T0 = new Date("2026-10-26T12:00:00.000Z");
const image = (id: string, name = "logo") => ({
  id: `gid://shopify/BrandingBrandLogo/${id}`,
  mediaImageId: `gid://shopify/MediaImage/${id}`,
  originalSrc: `https://cdn.shopify.com/${name}.svg`, width: 480, height: 190,
});
const response = (shop: unknown, status = 200) => new Response(JSON.stringify({ data: { shop } }), {
  status, headers: { "Content-Type": "application/json" },
});
const reader = (fetchImpl: typeof fetch) => new ShopifyAdminBrandReader({
  fetchImpl, accessToken: async () => "private-token-for-test",
});

function expectsCode(error: unknown, code: string) {
  expect(error).toBeInstanceOf(ShopifyBrandSyncError);
  expect((error as ShopifyBrandSyncError).code).toBe(code);
}

describe("ARCH-049 Shopify BrandingBrand authenticated GraphQL", () => {
  it("uses Admin logo(assetType) aliases, not invented squareLogo field, and reads source identities", async () => {
    const mock = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
      expect(options?.headers).toMatchObject({ "X-Shopify-Access-Token": "private-token-for-test" });
      return response({ name: "Test Merchant", brand: {
        logo: image("123"), squareLogo: image("456", "square"), coverImage: image("789", "cover"),
      } });
    });
    const result = await reader(mock).read("test-merchant.myshopify.com", T0);
    expect(SHOPIFY_BRAND_QUERY).toContain("squareLogo: logo(assetType: SQUARE_LOGO)");
    expect(SHOPIFY_BRAND_QUERY).not.toMatch(/\n\s*squareLogo\s*\{/);
    expect(result).toMatchObject({ brandName: "Test Merchant", logo: { width: 480, height: 190 } });
    expect(result.logo?.reference).toMatch(/^shopify:sha256:[a-f0-9]{64}$/);
    expect(result.squareLogo?.url).toBe("https://cdn.shopify.com/square.svg");
    expect(shopifyBrandObservations("merchant_1", result)).toMatchObject([
      { role: "LOGO", sourceUrl: "https://cdn.shopify.com/logo.svg" },
      { role: "SQUARE_LOGO", sourceUrl: "https://cdn.shopify.com/square.svg" },
      { role: "COVER_IMAGE", sourceUrl: "https://cdn.shopify.com/cover.svg" },
    ]);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("records a separate derived-square fallback, not a fictitious source square-logo URL", async () => {
    const result = await reader(async () => response({ name: "M", brand: {
      logo: image("123"), squareLogo: null, coverImage: null,
    } })).read("merchant.myshopify.com", T0);
    const [logo, square, cover] = shopifyBrandObservations("shop_1", result);
    expect(square.sourceUrl).toBe(logo.sourceUrl);
    expect(square.sourceReference).toContain("fallback:");
    expect(result.squareLogo).toBeNull();
    expect(cover.sourceUrl).toBeNull();
  });

  it("maps successful null brand to MISSING, without mistaking null for provider failure", async () => {
    const result = await reader(async () => response({ name: "Shop Name", brand: null }))
      .read("merchant.myshopify.com", T0);
    expect(result.brandName).toBe("Shop Name");
    expect(shopifyBrandObservations("shop_1", result).every((role) => role.sourceUrl === null)).toBe(true);
  });

  it.each([
    [401, "ACCESS_DENIED"],
    [402, "SHOP_FROZEN"],
    [403, "SHOP_FORBIDDEN"],
    [404, "SHOP_NOT_FOUND"],
    [429, "SHOPIFY_THROTTLED"],
    [423, "SHOP_LOCKED"],
    [500, "SHOPIFY_UNAVAILABLE"],
  ])("classifies HTTP %d with safe %s code", async (status, code) => {
    await reader(async () => new Response("untrusted provider body secret", { status }))
      .read("merchant.myshopify.com", T0).then(() => { throw new Error("expected rejection"); },
        (error: unknown) => expectsCode(error, code));
  });

  it.each([
    [{ data: { shop: null } }, "SHOPIFY_INVALID_RESPONSE"],
    [{ data: { shop: { name: "M", brand: { logo: null, coverImage: null } } } },
      "SHOPIFY_INVALID_RESPONSE"],
    [{ errors: [{ extensions: { code: "THROTTLED" } }] }, "SHOPIFY_THROTTLED"],
    [{ errors: [{ extensions: { code: "ACCESS_DENIED" } }] }, "MISSING_READ_BRAND_SCOPE"],
    [{ errors: [{ extensions: { code: "SHOP_INACTIVE" } }] }, "SHOP_INACTIVE"],
    [{ errors: [{ extensions: { code: "FORBIDDEN" } }] }, "SHOP_FORBIDDEN"],
    [{ errors: [{ extensions: { code: "INTERNAL_SERVER_ERROR" } }] }, "SHOPIFY_UNAVAILABLE"],
    [{ errors: [{ message: "secret" }] }, "SHOPIFY_GRAPHQL_FAILURE"],
    [{ data: { shop: { name: "M", brand: { logo: { ...image("1"), originalSrc: "http://localhost/logo" } } } } },
      "SHOPIFY_INVALID_RESPONSE"],
  ])("rejects invalid/incomplete GraphQL without observing removals (%s)", async (body, code) => {
    const client = reader(async () => new Response(JSON.stringify(body)));
    await client.read("merchant.myshopify.com", T0).then(() => { throw new Error("expected rejection"); },
      (error: unknown) => expectsCode(error, code));
  });

  it("will not forward a shop token to caller-controlled domains", async () => {
    const token = vi.fn(async () => "token");
    const client = new ShopifyAdminBrandReader({ accessToken: token, fetchImpl: vi.fn() });
    await client.read("attacker.example", T0).catch((error: unknown) => expectsCode(error, "SHOPIFY_INVALID_RESPONSE"));
    expect(token).not.toHaveBeenCalled();
  });

  it("rejects oversized responses before deserialising", async () => {
    const client = reader(async () => new Response("x".repeat(256 * 1024 + 100)));
    await client.read("merchant.myshopify.com", T0).catch((error: unknown) =>
      expectsCode(error, "SHOPIFY_INVALID_RESPONSE"));
  });
});
