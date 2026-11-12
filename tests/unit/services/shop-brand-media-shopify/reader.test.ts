import { describe, expect, it, vi } from "vitest";
import { ShopifyPublicBrandReader, SHOPIFY_BRAND_QUERY } from "../../../../src/services/shop-brand-media-shopify/reader.js";
import { shopifyBrandObservations } from "../../../../src/services/shop-brand-media-shopify/mapping.js";
import { ShopifyAdminNameReader } from "../../../../src/services/shopify-shop-name/reader.js";
import type { ShopifyBrandSyncClaim } from "../../../../src/services/shop-brand-media-shopify/contracts.js";
const claim: ShopifyBrandSyncClaim = { shopId: "s", shopDomain: "synthetic.myshopify.com", installedAt: new Date().toISOString(), leaseOwner: "owner", leaseUntil: new Date(Date.now() + 120000).toISOString() };
const media = (id: string) => ({ id: `gid://shopify/MediaImage/${id}`, image: { url: `https://cdn.shopify.com/${id}.png`, width: 480, height: 180 } });
const response = (brand: unknown, status = 200, version = "2026-07") => new Response(JSON.stringify({ data: { shop: { brand } } }), { status, headers: { "x-shopify-api-version": version } });
const logger = { warn: vi.fn() };
describe("stable public Shopify brand source", () => {
 it("uses only pinned public Storefront fields with no token/cookie/credential, rejects redirects and records public provenance", async () => {
  const fetchImpl = vi.fn(async () => response({ logo: media("1"), squareLogo: media("2"), coverImage: media("3") }));
  const result = await new ShopifyPublicBrandReader({ fetchImpl, logger }).read(claim);
  const [url, init] = fetchImpl.mock.calls[0]!;
  expect(url).toBe(`https://${claim.shopDomain}/api/2026-07/graphql.json`);
  expect(init).toMatchObject({ credentials: "omit", redirect: "error", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: SHOPIFY_BRAND_QUERY }) });
  expect(Object.keys(init!.headers!)).toEqual(["Content-Type"]);
  expect(result.logo?.reference).toMatch(/^shopify-storefront:sha256:[a-f0-9]{64}$/);
  expect(result).not.toHaveProperty("brandName");
  expect(shopifyBrandObservations("s", result)).toMatchObject([{ role: "LOGO", sourceUrl: "https://cdn.shopify.com/1.png" }, { role: "SQUARE_LOGO", sourceUrl: "https://cdn.shopify.com/2.png" }, { role: "COVER_IMAGE", sourceUrl: "https://cdn.shopify.com/3.png" }]);
 });
 it("keeps basic name acquisition independent of brand permissions and public channel lock", async () => {
  const name = new ShopifyAdminNameReader({ session: async () => ({ shopId: "s", shop: claim.shopDomain, accessToken: "synthetic" }), fetchImpl: async () => new Response(JSON.stringify({ data: { shop: { name: "Known name" } } })) });
  expect(await name.read({ ...claim, domain: claim.shopDomain })).toBe("Known name");
  await expect(new ShopifyPublicBrandReader({ logger, fetchImpl: async () => new Response(JSON.stringify({ errors: [{ message: "Online Store channel is locked.", extensions: { code: "BAD_REQUEST" } }] }), { status: 400 }) }).read(claim)).rejects.toMatchObject({ code: "CHANNEL_LOCKED", retryable: false });
 });
 it("maps successful explicit null and square fallback without inventing an asset", async () => {
  const empty = await new ShopifyPublicBrandReader({ logger, fetchImpl: async () => response(null) }).read(claim);
  expect(shopifyBrandObservations("s", empty).every(x => x.sourceUrl === null)).toBe(true);
  const fallback = await new ShopifyPublicBrandReader({ logger, fetchImpl: async () => response({ logo: media("1"), squareLogo: null, coverImage: null }) }).read(claim);
  expect(fallback.squareLogo).toBeNull(); expect(shopifyBrandObservations("s", fallback)[1]).toMatchObject({ sourceUrl: "https://cdn.shopify.com/1.png", sourceReference: expect.stringContaining("fallback:shopify-storefront:") });
 });
 it.each([{}, { logo: null, coverImage: null }, { logo: { ...media("1"), image: null }, squareLogo: null, coverImage: null }, { logo: { ...media("1"), id: "fake" }, squareLogo: null, coverImage: null }, { logo: { ...media("1"), image: { url: "http://localhost/logo", width: 1, height: 1 } }, squareLogo: null, coverImage: null }, { logo: { ...media("1"), image: { url: "https://cdn.shopify.com/logo\n", width: 1, height: 1 } }, squareLogo: null, coverImage: null }])("rejects partial/unsafe asset data %# instead of interpreting removal", async brand => {
  await expect(new ShopifyPublicBrandReader({ logger, fetchImpl: async () => response(brand) }).read(claim)).rejects.toMatchObject({ code: "SHOPIFY_INVALID_RESPONSE" });
 });
 it.each([401, 403, 404, 429, 500])("refuses HTTP%s without observing assets", async status => {
  await expect(new ShopifyPublicBrandReader({ logger, fetchImpl: async () => new Response("unsafe error", { status }) }).read(claim)).rejects.toMatchObject({ retryable: status >= 429 });
 });
 it("bounds response bytes/time, rejects wrong version and never contacts untrusted domains", async () => {
  await expect(new ShopifyPublicBrandReader({ logger, fetchImpl: async () => response(null, 200, "2026-10") }).read(claim)).rejects.toMatchObject({ code: "SHOPIFY_INVALID_RESPONSE" });
  await expect(new ShopifyPublicBrandReader({ logger, fetchImpl: async () => new Response("x".repeat(262145), { headers: { "x-shopify-api-version": "2026-07" } }) }).read(claim)).rejects.toMatchObject({ code: "SHOPIFY_INVALID_RESPONSE" });
  await expect(new ShopifyPublicBrandReader({ logger, timeoutMs: 5, fetchImpl: async () => new Promise(() => {}) }).read(claim)).rejects.toMatchObject({ code: "SHOPIFY_TIMEOUT" });
  const fetchImpl = vi.fn(); await expect(new ShopifyPublicBrandReader({ logger, fetchImpl }).read({ ...claim, shopDomain: "attacker.example" })).rejects.toMatchObject({ code: "SHOPIFY_INVALID_RESPONSE" }); expect(fetchImpl).not.toHaveBeenCalled();
 });
 it("preserves safe originating errors, redacts echoes, and isolates sink failure", async () => {
  const warn = vi.fn();
  const errors = [{ message: "Distinct public provider rejection", extensions: { code: "THROTTLED" } }, { message: "shpat_secret person@example.test" }];
  await expect(new ShopifyPublicBrandReader({ logger: { warn }, fetchImpl: async () => new Response(JSON.stringify({ errors }), { headers: { "x-shopify-api-version": "2026-07" } }) }).read(claim)).rejects.toMatchObject({ code: "SHOPIFY_THROTTLED" });
  expect(warn).toHaveBeenCalledWith("shop_brand.shopify.provider_failed", expect.objectContaining({ providerErrors: [{ message: "Distinct public provider rejection", code: "THROTTLED" }, { message: "[REDACTED]" }], redactionApplied: true }));
  expect(JSON.stringify(warn.mock.calls)).not.toContain("shpat_secret");
  await expect(new ShopifyPublicBrandReader({ logger: { warn: () => { throw new Error("sink"); } }, fetchImpl: async () => new Response("", { status: 403 }) }).read(claim)).rejects.toMatchObject({ code: "SHOP_FORBIDDEN" });
 });
});
