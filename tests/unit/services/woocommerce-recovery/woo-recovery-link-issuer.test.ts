import { describe, expect, it } from "vitest";
import { buildWooRecoveryUrl, generateWooRecoveryToken, prepareWooRecoveryLink } from "../../../../src/services/woocommerce-recovery/woo-recovery-link-issuer.js";

describe("Woo recovery link issuer", () => {
  it("builds a generation URL with a fresh opaque token and preserves the verified home subpath", () => {
    const site = prepareWooRecoveryLink("https://shop.example.com/store/", "shop.example.com");
    expect(site.kind).toBe("ready");
    if (site.kind !== "ready") return;
    const firstToken = generateWooRecoveryToken();
    const secondToken = generateWooRecoveryToken();

    const url = new URL(buildWooRecoveryUrl(site, "recovery-123", firstToken));
    expect(url.href).toMatch(/^https:\/\/shop\.example\.com\/store\/\?moda_interact_resume=1&r=recovery-123&t=[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("t")).not.toBe(secondToken);
    expect(firstToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.search).not.toMatch(/coupon|product|email|phone/i);
  });

  it.each([
    ["http://shop.example.com/store", "shop.example.com", "CANONICAL_SITE_INVALID"],
    ["https://localhost/store", "localhost", "CANONICAL_SITE_INVALID"],
    ["https://192.168.1.25/store", "192.168.1.25", "CANONICAL_SITE_INVALID"],
    ["https://shop.example.com/store?next=https://other.example", "shop.example.com", "CANONICAL_SITE_INVALID"],
    ["https://shop.example.com/store", "other.example.com", "SHOP_HOST_MISMATCH"],
    ["https://shop.example.com/store", "shop.example.test", "SHOP_DOMAIN_INVALID"],
  ] as const)("omits a link for unsafe or unverified site configuration", (site, domain, reason) => {
    expect(prepareWooRecoveryLink(site, domain)).toEqual({ kind: "omitted", reason });
  });
});
