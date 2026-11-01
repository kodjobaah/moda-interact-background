import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildOutreachProductObjectKey,
  isOutreachProductObjectKey,
} from "../../../../src/services/recovery-product-media/outreach-product-object-key.js";
import { normalizeOutreachMerchantSite } from "../../../../src/services/recovery-product-media/merchant-site-segment.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const base = {
  platform: "WOOCOMMERCE" as const,
  merchantSite: "myshop.com-myshop",
  preparedAt: new Date("2024-02-29T23:59:59.999Z"),
  outreachAttemptId: "attempt_7d91b",
  providerProductId: "987654321",
  providerVariantId: "variation/blue",
  contentSha256: "a".repeat(64),
};

describe("outreach product object key", () => {
  it("builds the exact UTC, attempt-specific key with source identity digests", () => {
    const key = buildOutreachProductObjectKey(base);
    expect(key).toBe(`outreach-products/woocommerce/myshop.com-myshop/2024/02/29/attempt_7d91b/p-${hash("woocommerce\0" + base.providerProductId)}/v-${hash("woocommerce\0" + base.providerVariantId)}/sha256-${base.contentSha256}.jpg`);
    expect(key.split("/")).toHaveLength(10);
    expect(isOutreachProductObjectKey(key)).toBe(true);
  });

  it("rebuilds deterministically, distinguishes platforms, merchants, attempts and variants", () => {
    expect(buildOutreachProductObjectKey(base)).toBe(buildOutreachProductObjectKey({ ...base }));
    expect(buildOutreachProductObjectKey({ ...base, platform: "SHOPIFY" }))
      .not.toBe(buildOutreachProductObjectKey(base));
    expect(buildOutreachProductObjectKey({ ...base, merchantSite: "other.com" }))
      .not.toBe(buildOutreachProductObjectKey(base));
    expect(buildOutreachProductObjectKey({ ...base, outreachAttemptId: "attempt_2" }))
      .not.toBe(buildOutreachProductObjectKey(base));
    expect(buildOutreachProductObjectKey({ ...base, providerVariantId: null })).toContain("/v-none/");
    expect(buildOutreachProductObjectKey({ ...base,
      preparedAt: new Date("2024-03-01T00:00:00.000Z") })).toContain("/2024/03/01/");
  });

  it.each([
    ["https://myshop.com/A", "myshop.com-A"],
    ["https://myshop.com/store-", "myshop.com-store~2D"],
  ])("accepts normalized merchant namespace %s through the key builder and independent guard", (site, expected) => {
    const merchantSite = normalizeOutreachMerchantSite(site);
    expect(merchantSite).toBe(expected);
    const key = buildOutreachProductObjectKey({ ...base, merchantSite: merchantSite! });
    expect(key.split("/")[2]).toBe(expected);
    expect(isOutreachProductObjectKey(key)).toBe(true);
  });

  it.each([
    { ...base, platform: "shopify" },
    { ...base, merchantSite: "../bad" },
    { ...base, preparedAt: new Date("invalid") },
    { ...base, outreachAttemptId: "has/slash" },
    { ...base, providerProductId: "" },
    { ...base, providerVariantId: "bad\nvalue" },
    { ...base, contentSha256: "A".repeat(64) },
  ] as const)("rejects malformed key input", (input) => {
    expect(() => buildOutreachProductObjectKey(input as never)).toThrowError("OUTREACH_PRODUCT_OBJECT_KEY_INVALID");
  });

  it("strictly rejects key shape and date errors", () => {
    const valid = buildOutreachProductObjectKey(base);
    expect(isOutreachProductObjectKey(valid.replace("/2024/02/29/", "/2023/02/29/"))).toBe(false);
    expect(isOutreachProductObjectKey(valid.replace("outreach-products/", "shop-brands/"))).toBe(false);
    expect(isOutreachProductObjectKey(`${valid}/extra`)).toBe(false);
    expect(isOutreachProductObjectKey(valid.replace("myshop.com-myshop", "../escape"))).toBe(false);
  });
});
