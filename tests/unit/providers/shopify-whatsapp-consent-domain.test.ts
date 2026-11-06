import { describe, expect, it, vi } from "vitest";
import { ShopifyWhatsAppConsentProvider } from "../../../src/providers/shopify-whatsapp-consent.provider.js";

const CUSTOMER_GID = "gid://shopify/Customer/12345";
const STORED_SHOP = "verified-install.myshopify.com";
const STOREFRONT_DOMAIN = "brand.example";
const CONSENT_RESPONSE = new Response(JSON.stringify({
  data: { customer: null },
}), { status: 200 });

describe("Shopify WhatsApp consent endpoint identity", () => {
  it("uses the selected Shop snapshot endpoint even when a custom storefront domain is supplied as display context", async () => {
    const session = vi.fn().mockResolvedValue({ shop: STORED_SHOP, accessToken: "selected-shop-token" });
    const fetchImpl = vi.fn().mockResolvedValue(CONSENT_RESPONSE.clone());
    const provider = new ShopifyWhatsAppConsentProvider({ session, fetchImpl });
    const input = {
      shopId: "selected-shop-1",
      customerGid: CUSTOMER_GID,
      // Legacy/display-only input is deliberately ignored; it cannot pick the credential recipient.
      shopDomain: STOREFRONT_DOMAIN,
    } as Parameters<typeof provider.readCurrent>[0];

    await expect(provider.readCurrent(input)).resolves.toEqual({ kind: "NOT_FOUND" });

    expect(session).toHaveBeenCalledWith("selected-shop-1", { signal: expect.any(AbortSignal) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [endpoint, request] = fetchImpl.mock.calls[0]!;
    expect(String(endpoint)).toBe(`https://${STORED_SHOP}/admin/api/2026-07/graphql.json`);
    expect(String(endpoint)).not.toContain(STOREFRONT_DOMAIN);
    expect(request).toMatchObject({ method: "POST", redirect: "error" });
    expect(request?.headers).toMatchObject({ "X-Shopify-Access-Token": "selected-shop-token" });
  });

  it("does not contact a provider when the selected Shop has no valid session association", async () => {
    const session = vi.fn().mockRejectedValue(new Error("SESSION_IDENTITY_CONFLICT private-session-canary"));
    const fetchImpl = vi.fn();
    const provider = new ShopifyWhatsAppConsentProvider({ session, fetchImpl });

    await expect(provider.readCurrent({ shopId: "foreign-shop", customerGid: CUSTOMER_GID }))
      .resolves.toEqual({ kind: "UNAVAILABLE", reason: "ACCESS_DENIED" });

    expect(session).toHaveBeenCalledWith("foreign-shop", { signal: expect.any(AbortSignal) });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    "verified-install.myshopify.com:8443",
    "verified-install.myshopify.com/path-override",
    "user@verified-install.myshopify.com",
    "https://verified-install.myshopify.com",
  ])("rejects a malformed stored endpoint before sending the credential (%s)", async (shop) => {
    const session = vi.fn().mockResolvedValue({ shop, accessToken: "must-not-be-sent" });
    const fetchImpl = vi.fn();
    const provider = new ShopifyWhatsAppConsentProvider({ session, fetchImpl });

    await expect(provider.readCurrent({ shopId: "selected-shop-1", customerGid: CUSTOMER_GID }))
      .resolves.toEqual({ kind: "UNAVAILABLE", reason: "INVALID_RESPONSE" });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("contains session/provider error details and refuses redirects", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("redirect refused with private-token-canary"));
    const session = vi.fn().mockResolvedValue({ shop: STORED_SHOP, accessToken: "private-token-canary" });
    const provider = new ShopifyWhatsAppConsentProvider({ session, fetchImpl });

    const result = await provider.readCurrent({ shopId: "selected-shop-1", customerGid: CUSTOMER_GID });
    expect(result).toEqual({ kind: "UNAVAILABLE", reason: "HTTP" });
    expect(JSON.stringify(result)).not.toContain("private-token-canary");
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });
});
