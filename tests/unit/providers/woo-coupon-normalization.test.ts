import { describe, expect, it } from "vitest";
import { normalizeWooCoupon, normalizeWooCoupons } from "../../../src/providers/woo-coupon-normalization.js";

const NOW = new Date("2026-10-13T12:00:00Z");
const coupon = (overrides: Record<string, unknown> = {}) => ({
  id: 42, code: "SAVE15", discount_type: "percent", amount: "15.00",
  usage_count: 0, usage_limit: 100, date_expires_gmt: "2026-11-13T12:00:00",
  individual_use: true, product_ids: [123], excluded_product_ids: [],
  free_shipping: false, email_restrictions: ["customer@example.com"],
  used_by: ["someone@example.com"], meta_data: [{ key: "secret", value: "never" }],
  ...overrides,
});

describe("Woo coupon normalisation", () => {
  it("maps id, code, money, UTC expiry and restrictions without persisting customer data", () => {
    const result = normalizeWooCoupon(coupon(), NOW);
    expect(result).toMatchObject({
      shopifyDiscountNodeId: "woo:coupon:42", method: "CODE", title: "SAVE15",
      singleRedeemCode: "SAVE15", providerStatus: "ACTIVE", fixedSelectable: true,
      codeCount: 1, startsAt: null,
    });
    expect(result.endsAt?.toISOString()).toBe("2026-11-13T12:00:00.000Z");
    expect(result.providerSnapshot).toMatchObject({
      provider: "WOOCOMMERCE", couponId: 42, code: "SAVE15",
      discountType: "percent", amount: "15.00", usageLimit: 100,
      productIds: [123], individualUse: true,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("customer@example.com");
    expect(serialized).not.toContain("someone@example.com");
    expect(serialized).not.toContain("never");
  });

  it("marks expired, exhausted and unsupported rules without clearing stored selections", () => {
    expect(normalizeWooCoupon(coupon({ date_expires_gmt: "2026-09-01T00:00:00" }), NOW))
      .toMatchObject({ providerStatus: "EXPIRED", fixedSelectable: false });
    expect(normalizeWooCoupon(coupon({ usage_limit: 0, usage_count: 500 }), NOW))
      .toMatchObject({ providerStatus: "ACTIVE", fixedSelectable: true });
    expect(normalizeWooCoupon(coupon({ usage_count: 100 }), NOW))
      .toMatchObject({ providerStatus: "EXHAUSTED", fixedSelectable: false });
    expect(normalizeWooCoupon(coupon({ discount_type: "mystery" }), NOW))
      .toMatchObject({ providerStatus: "UNSUPPORTED", fixedSelectable: false });
    expect(normalizeWooCoupon(coupon({ date_expires_gmt: null, date_expires: "2026-11-01T01:00:00" }), NOW))
      .toMatchObject({ providerStatus: "UNSUPPORTED", fixedSelectable: false });
    expect(normalizeWooCoupon(coupon({ date_expires_gmt: null }), NOW))
      .toMatchObject({ providerStatus: "ACTIVE", fixedSelectable: true });
  });

  it("handles a valid empty scan and rejects duplicate provider IDs", () => {
    expect(normalizeWooCoupons([], NOW)).toEqual([]);
    expect(() => normalizeWooCoupons([coupon(), coupon({ code: "OTHER" })], NOW))
      .toThrow("invalid_coupon");
  });

  it.each([
    { id: -1 }, { code: "" }, { code: "X\nHeader: unsafe" },
    { amount: "-10" }, { amount: "not-money" },
    { usage_count: -1 }, { product_ids: ["bad"] },
    { date_expires_gmt: "yesterday" }, { discount_type: 1 },
  ])("fails the complete scan on malformed coupon fields: %j", (change) => {
    expect(() => normalizeWooCoupon(coupon(change), NOW)).toThrow("invalid_coupon");
  });
});
