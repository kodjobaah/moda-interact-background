import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WooCouponPageTransport } from "../../../src/providers/woo-coupon-transport.js";
import { signLocalWooCouponPath } from "../../../src/providers/woo-coupon-local-oauth.js";

const credential = { consumerKey: "ck_example", consumerSecret: "cs_example" };
const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function localServer(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return `http://woo-local.test:${port}/shop`;
}

const localDns = async () => [{ address: "127.0.0.1", family: 4 as const }];

describe("ARCH-036 Woo coupon HTTP read", () => {
  it("constructs bounded pagination and signs local HTTP without Basic credentials", async () => {
    const received: string[] = [];
    const url = await localServer((req, res) => {
      received.push(req.url ?? "");
      expect(req.headers.authorization).toBeUndefined();
      res.writeHead(200, {
        "content-type": "application/json", "x-wp-total": "1", "x-wp-totalpages": "1",
      });
      res.end(JSON.stringify([{ id: 42 }]));
    });
    const transport = new WooCouponPageTransport(localDns);
    const response = await transport.readPage({ canonicalSiteUrl: url, mode: "local-development" }, credential, 1, 100);
    expect(response).toEqual({ coupons: [{ id: 42 }], total: 1, totalPages: 1 });
    const path = new URL(received[0]!, "http://woo-local.test");
    expect(path.pathname).toBe("/shop/wp-json/wc/v3/coupons");
    expect(path.searchParams.get("page")).toBe("1");
    expect(path.searchParams.get("per_page")).toBe("100");
    expect(path.searchParams.get("orderby")).toBe("id");
    expect(path.searchParams.get("order")).toBe("asc");
    expect(path.searchParams.get("oauth_signature_method")).toBe("HMAC-SHA256");
    expect(path.searchParams.has("oauth_signature")).toBe(true);
    expect(received[0]).not.toContain("cs_example");
  });

  it("never follows a provider redirect or accepts missing pagination headers", async () => {
    const redirected = await localServer((_req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1/private" }); res.end();
    });
    const transport = new WooCouponPageTransport(localDns);
    await expect(transport.readPage({ canonicalSiteUrl: redirected, mode: "local-development" }, credential, 1, 100))
      .rejects.toThrow("provider_unavailable");
    const noHeaders = await localServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" }); res.end("[]");
    });
    await expect(transport.readPage({ canonicalSiteUrl: noHeaders, mode: "local-development" }, credential, 1, 100))
      .rejects.toThrow("invalid_page");
  });

  it("rejects local DNS addresses in production and mixed public/private answers", async () => {
    const transport = new WooCouponPageTransport(localDns);
    await expect(transport.readPage({ canonicalSiteUrl: "https://woo.example", mode: "public" }, credential, 1, 100))
      .rejects.toThrow("unsafe_target");
    const mixed = new WooCouponPageTransport(async () => [
      { address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 },
    ]);
    await expect(mixed.readPage({ canonicalSiteUrl: "https://woo.example", mode: "public" }, credential, 1, 100))
      .rejects.toThrow("unsafe_target");
  });

  it("rejects unsupported or mismatched DNS address families", async () => {
    const site = { canonicalSiteUrl: "https://woo.example", mode: "public" as const };
    for (const family of [0, 6]) {
      const transport = new WooCouponPageTransport(async () => [
        { address: "93.184.216.34", family },
      ]);
      await expect(transport.readPage(site, credential, 1, 100))
        .rejects.toThrow("unsafe_target");
    }
  });

  it("matches API-007 OAuth signature construction", () => {
    const path = signLocalWooCouponPath("http://woo-local.test:8000", "/shop/wp-json/wc/v3/coupons?page=1&per_page=100&orderby=id&order=asc",
      credential, { nonce: "a".repeat(32), timestamp: 1728000000 });
    expect(path).toContain("oauth_signature_method=HMAC-SHA256");
    expect(path).toContain("oauth_timestamp=1728000000");
    // Fixed API-007 HMAC-SHA256 vector for the identical method/path/nonce/timestamp.
    expect(new URL(path, "http://woo-local.test:8000").searchParams.get("oauth_signature"))
      .toBe("JmXx1SgJYvpJ+im+8dTVFcQKg35Ym8rmDv780SI7BYU=");
    expect(path).not.toContain(credential.consumerSecret);
  });
});

it("respects the validated per-transport page cap before making DNS requests", async () => {
  const { loadWooCouponSyncConfig } = await import("../../../src/services/woo-coupon-sync-config.js");
  const dns = vi.fn(localDns);
  const transport = new WooCouponPageTransport(dns, loadWooCouponSyncConfig({ WOO_COUPON_SYNC_MAX_PAGES: "2" }));
  await expect(transport.readPage({ canonicalSiteUrl: "https://woo.example", mode: "public" }, credential, 3, 100))
    .rejects.toThrow("invalid_page");
  expect(dns).not.toHaveBeenCalled();
});
