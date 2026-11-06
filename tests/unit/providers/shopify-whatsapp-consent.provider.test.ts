import { describe, expect, it, vi } from "vitest";
import { ShopifyWhatsAppConsentProvider } from "../../../src/providers/shopify-whatsapp-consent.provider.js";

const GID = "gid://shopify/Customer/12345";
const SHOP = "sample-shop.myshopify.com";

function graphqlResponse(
  consent: unknown = { state: "SUBSCRIBED", updatedAt: "2026-10-20T09:00:00.000Z" },
  phoneNumber: unknown = "+447400123456",
) {
  return new Response(JSON.stringify({
    data: { customer: { id: GID, defaultPhoneNumber: { phoneNumber, whatsAppMarketingConsent: consent } } },
  }), { status: 200 });
}

function provider(response: Response | ((_: string | URL | Request, init?: RequestInit) => Promise<Response>)) {
  const http = typeof response === "function" ? response : vi.fn().mockResolvedValue(response);
  const session = vi.fn().mockResolvedValue({ shop: SHOP, accessToken: "injected-test-token" });
  return { client: new ShopifyWhatsAppConsentProvider({ fetchImpl: http, session }), http, session };
}

describe("ShopifyWhatsAppConsentProvider", () => {
  it("only performs the Admin 2026-07 GraphQL customer read with the existing offline token", async () => {
    const { client, http, session } = provider(graphqlResponse());
    expect(await client.readCurrent({ shopId: "shop-1", customerGid: GID })).toEqual({
      kind: "OBSERVED", customerGid: GID, phoneNumber: "+447400123456",
      state: "SUBSCRIBED", updatedAt: "2026-10-20T09:00:00.000Z",
    });
    expect(session).toHaveBeenCalledWith("shop-1", { signal: expect.any(AbortSignal) });
    expect(http).toHaveBeenCalledTimes(1);
    const [endpoint, options] = vi.mocked(http).mock.calls[0]!;
    expect(String(endpoint)).toBe(`https://${SHOP}/admin/api/2026-07/graphql.json`);
    expect(options?.method).toBe("POST");
    expect(options?.redirect).toBe("error");
    expect(options?.headers).toMatchObject({ "X-Shopify-Access-Token": "injected-test-token" });
    const request = JSON.parse(options?.body as string);
    expect(request.query).toContain("whatsAppMarketingConsent { state updatedAt }");
    expect(request.query).not.toMatch(/mutation|smsMarketingConsent/i);
    expect(request.variables).toEqual({ id: GID });
  });

  it.each(["UNSUBSCRIBED", "PENDING", "NEVER_SUBSCRIBED", "REDACTED"] as const)(
    "returns non-granted Shopify state %s verbatim", async (state) => {
      const { client } = provider(graphqlResponse({ state, updatedAt: null }));
      expect(await client.readCurrent({ shopId: "shop-1", customerGid: GID })).toMatchObject({
        kind: "OBSERVED", state, updatedAt: null,
      });
    },
  );

  it.each([
    [{ data: { customer: null } }, { kind: "NOT_FOUND" }],
    [{ data: { customer: { id: GID, defaultPhoneNumber: null } } }, { kind: "NOT_FOUND" }],
    [{ errors: [{ message: "Access denied for customer.whatsAppMarketingConsent", extensions: { code: "ACCESS_DENIED" } }], data: { customer: null } }, { kind: "UNAVAILABLE", reason: "ACCESS_DENIED" }],
    [{ errors: [{ message: "GraphQL validation failed" }], data: { customer: null } }, { kind: "UNAVAILABLE", reason: "GRAPHQL" }],
    [{ data: { customer: { id: "gid://shopify/Customer/999", defaultPhoneNumber: {} } } }, { kind: "UNAVAILABLE", reason: "INVALID_RESPONSE" }],
    [{ data: { customer: { id: GID, defaultPhoneNumber: { phoneNumber: "+447400123456", whatsAppMarketingConsent: { state: "UNKNOWN", updatedAt: null } } } } }, { kind: "UNAVAILABLE", reason: "INVALID_RESPONSE" }],
    [{ data: { customer: { id: GID, defaultPhoneNumber: { phoneNumber: "+447400123456" } } } }, { kind: "UNAVAILABLE", reason: "INVALID_RESPONSE" }],
    [{ data: { customer: { id: GID, defaultPhoneNumber: { phoneNumber: "+447400123456", whatsAppMarketingConsent: { state: "SUBSCRIBED" } } } } }, { kind: "UNAVAILABLE", reason: "INVALID_RESPONSE" }],
    [{ errors: "malformed", data: { customer: null } }, { kind: "UNAVAILABLE", reason: "GRAPHQL" }],
  ] as const)("fails closed for missing/protected/malformed GraphQL fields", async (body, expected) => {
    const { client } = provider(new Response(JSON.stringify(body), { status: 200 }));
    expect(await client.readCurrent({ shopId: "shop-1", customerGid: GID })).toEqual(expected);
  });

  it.each([401, 403, 429, 503])("classifies HTTP %s without ever granting", async (status) => {
    const { client } = provider(new Response("denied", { status }));
    expect(await client.readCurrent({ shopId: "shop-1", customerGid: GID })).toEqual({
      kind: "UNAVAILABLE", reason: status === 401 || status === 403 ? "ACCESS_DENIED" : "HTTP",
    });
  });

  it("rejects a non-GID identity before reading the selected Shop session", async () => {
    const { client, session, http } = provider(graphqlResponse());
    expect(await client.readCurrent({ shopId: "shop-1", customerGid: "12345" })).toMatchObject({ kind: "UNAVAILABLE" });
    expect(session).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
  });

  it("fails closed on offline token permission failures", async () => {
    const client = new ShopifyWhatsAppConsentProvider({
      session: vi.fn().mockRejectedValue(new Error("secret redacted")),
      fetchImpl: vi.fn(),
    });
    expect(await client.readCurrent({ shopId: "shop-1", customerGid: GID })).toEqual({ kind: "UNAVAILABLE", reason: "ACCESS_DENIED" });
  });

  it("times out a hanging request, aborts the transport and never returns a grant", async () => {
    const http = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const client = new ShopifyWhatsAppConsentProvider({
      fetchImpl: http, session: vi.fn().mockResolvedValue({ shop: SHOP, accessToken: "test-token" }), timeoutMs: 12,
    });
    expect(await client.readCurrent({ shopId: "shop-1", customerGid: GID })).toEqual({ kind: "UNAVAILABLE", reason: "TIMEOUT" });
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("rejects bodies larger than its hard limit and malformed JSON", async () => {
    for (const response of [new Response("not-json"),
      new Response("x".repeat(300_000))]) {
      const { client } = provider(response);
      expect(await client.readCurrent({ shopId: "shop-1", customerGid: GID })).toEqual({
        kind: "UNAVAILABLE", reason: "INVALID_RESPONSE",
      });
    }
  });
});
