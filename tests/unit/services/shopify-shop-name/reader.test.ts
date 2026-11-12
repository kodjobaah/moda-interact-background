import { describe, expect, it, vi } from "vitest";
import { ShopifyAdminNameReader, SHOPIFY_NAME_QUERY } from "../../../../src/services/shopify-shop-name/reader.js";
import type { NameClaim } from "../../../../src/services/shopify-shop-name/contracts.js";
const claim: NameClaim = { shopId: "selected-shop", domain: "selected.myshopify.com", installedAt: "2026-11-12T00:00:00Z", leaseOwner: "owner", leaseUntil: "2026-11-12T00:02:00Z" };
const session = vi.fn(async () => ({ shopId: claim.shopId, shop: claim.domain, accessToken: "shpat_synthetic" }));
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
describe("basic Shopify name reader", () => {
  it("requests only shop.name without read_brand, using selected Shop ID and matching credential domain", async () => {
    const fetchImpl = vi.fn(async () => json({ data: { shop: { name: "  Synthetic Shop  " } } }));
    expect(await new ShopifyAdminNameReader({ session, fetchImpl }).read(claim)).toBe("Synthetic Shop");
    expect(session).toHaveBeenLastCalledWith(claim.shopId, { signal: expect.any(AbortSignal) });
    expect(fetchImpl).toHaveBeenCalledWith(`https://${claim.domain}/admin/api/2026-07/graphql.json`, expect.objectContaining({ body: JSON.stringify({ query: SHOPIFY_NAME_QUERY }) }));
    expect(SHOPIFY_NAME_QUERY).toBe("query ModaBasicShopName { shop { name } }");
  });
  it.each([{ shopId: "other", shop: claim.domain }, { shopId: claim.shopId, shop: "other.myshopify.com" }])("never sends a token to a mismatched claimed identity %#", async identity => {
    const fetchImpl = vi.fn();
    await expect(new ShopifyAdminNameReader({ session: async () => ({ ...identity, accessToken: "secret" }), fetchImpl }).read(claim)).rejects.toMatchObject({ code: "SESSION_IDENTITY_CONFLICT" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([null, {}, { name: "" }, { name: "x".repeat(2049) }, { name: "Injected\nHeader" }])("rejects malformed names %#", async shop => {
    await expect(new ShopifyAdminNameReader({ session, fetchImpl: async () => json({ data: { shop } }) }).read(claim)).rejects.toMatchObject({ code: "SHOPIFY_INVALID_RESPONSE" });
  });
  it.each([401, 403, 429, 500])("classifies HTTP %s without blanking a name", async status => {
    await expect(new ShopifyAdminNameReader({ session, logger: { warn: vi.fn() }, fetchImpl: async () => json({ errors: [{ message: "Distinct upstream failure", extensions: { code: "UPSTREAM_FAILURE" } }] }, status) }).read(claim)).rejects.toMatchObject({ retryable: status >= 429 });
  });
  it("retains safe originating GraphQL errors, redacts secret echoes and isolates logging failure", async () => {
    const warn = vi.fn();
    const reader = new ShopifyAdminNameReader({ session, logger: { warn }, fetchImpl: async () => json({ errors: [
      { message: "Distinct upstream rejection", extensions: { code: "ACCESS_DENIED" } },
      { message: "token shpat_private email person@example.test" },
    ] }) });
    await expect(reader.read(claim)).rejects.toMatchObject({ code: "ACCESS_DENIED", retryable: false });
    expect(warn).toHaveBeenCalledWith("shop_brand.name.provider_failed", expect.objectContaining({ providerErrors: [
      { message: "Distinct upstream rejection", code: "ACCESS_DENIED" }, { message: "[REDACTED]" },
    ], redactionApplied: true }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("shpat_private");
    await expect(new ShopifyAdminNameReader({ session, logger: { warn: () => { throw new Error("sink"); } }, fetchImpl: async () => json({}, 401) }).read(claim)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
  it("bounds body bytes and total token/provider wait", async () => {
    await expect(new ShopifyAdminNameReader({ session, fetchImpl: async () => new Response("x", { headers: { "content-length": "999999" } }) }).read(claim)).rejects.toMatchObject({ code: "SHOPIFY_INVALID_RESPONSE" });
    await expect(new ShopifyAdminNameReader({ session: async () => new Promise(() => {}), timeoutMs: 5, logger: { warn: vi.fn() } }).read(claim)).rejects.toMatchObject({ code: "SHOPIFY_TIMEOUT" });
    await expect(new ShopifyAdminNameReader({ session, fetchImpl: async () => new Promise(() => {}), timeoutMs: 5, logger: { warn: vi.fn() } }).read(claim)).rejects.toMatchObject({ code: "SHOPIFY_TIMEOUT" });
  });
  it("revoked token acquisition does no HTTP work and does not leak provider details", async () => {
    const fetchImpl = vi.fn(); const warn = vi.fn();
    await expect(new ShopifyAdminNameReader({ session: async () => { throw new Error("shpat_private"); }, fetchImpl, logger: { warn } }).read(claim)).rejects.toMatchObject({ code: "TOKEN_UNAVAILABLE" });
    expect(fetchImpl).not.toHaveBeenCalled(); expect(JSON.stringify(warn.mock.calls)).not.toContain("shpat_private");
  });
});
