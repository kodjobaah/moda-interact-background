import { describe, expect, it } from "vitest";
import {
  isOutreachMerchantSiteSegment,
  normalizeOutreachMerchantSite,
} from "../../../../src/services/recovery-product-media/merchant-site-segment.js";

describe("normalizeOutreachMerchantSite", () => {
  it.each([
    ["https://myshop.com", "myshop.com"],
    ["myshop.com", "myshop.com"],
    ["https://myshop.com/myshop", "myshop.com-myshop"],
    ["https://myshop.com/myshop/", "myshop.com-myshop"],
    ["https://myshop.com/store/london", "myshop.com-store-london"],
    ["https://MYSHOP.COM", "myshop.com"],
    ["https://myshop.com/a-b", "myshop.com-a~2Db"],
    ["https://myshop.com/a/b", "myshop.com-a-b"],
    ["https://myshop.com/A", "myshop.com-A"],
    ["https://myshop.com/a", "myshop.com-a"],
  ])("normalizes %s", (site, expected) => {
    expect(normalizeOutreachMerchantSite(site)).toBe(expected);
  });

  it("encodes UTF-8 path bytes once and preserves case while removing only trailing slashes", () => {
    expect(normalizeOutreachMerchantSite("https://myshop.com/caf%C3%A9/~sale/")).toBe(
      "myshop.com-caf~C3~A9-~7Esale",
    );
    expect(normalizeOutreachMerchantSite("https://myshop.com/a%252Fb")).toBe("myshop.com-a~252Fb");
    expect(normalizeOutreachMerchantSite("https://myshop.com/a b")).toBe("myshop.com-a~20b");
  });

  it("accepts canonical uppercase and escaped path suffixes while rejecting malformed escapes and dot segments", () => {
    expect(isOutreachMerchantSiteSegment(normalizeOutreachMerchantSite("https://myshop.com/A")!)).toBe(true);
    expect(isOutreachMerchantSiteSegment(normalizeOutreachMerchantSite("https://myshop.com/store-")!)).toBe(true);
    expect(isOutreachMerchantSiteSegment("myshop.com-store~2d")).toBe(false);
    expect(isOutreachMerchantSiteSegment("myshop.com-store~GG")).toBe(false);
    expect(isOutreachMerchantSiteSegment("myshop.com-.")).toBe(false);
    expect(isOutreachMerchantSiteSegment("myshop.com-~2E~2E")).toBe(false);
  });

  it.each([
    "", " https://myshop.com", "https://myshop.com ", "http://myshop.com",
    "ftp://myshop.com", "//myshop.com/path", "https://user@myshop.com",
    "https://user:pass@myshop.com", "https://myshop.com:444/path",
    "https://localhost", "https://shop.localhost", "https://myshop.test",
    "https://127.0.0.1", "https://[::1]", "https://myshop.com/a/../b",
    "https://myshop.com/a/%2e%2e/b", "https://myshop.com/a/./b",
    "https://myshop.com/a%2Fb", "https://myshop.com/a%5Cb", "https://myshop.com/a//b",
    "https://myshop.com/%", "https://myshop.com/%0A", "https://myshop.com/%2e",
    "https://myshop.com/%2E%2E", `https://myshop.com/${"x".repeat(201)}`,
    `https://${"x".repeat(510)}.com`,
  ])("rejects unsafe or ambiguous identity %s", (site) => {
    expect(normalizeOutreachMerchantSite(site)).toBeNull();
  });
});
