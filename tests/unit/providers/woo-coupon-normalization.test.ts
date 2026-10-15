import { describe, expect, it } from "vitest";
import {
  deliverableWooCode, normalizeWooCoupon, normalizeWooCouponBatch, normalizeWooCoupons,
} from "../../../src/providers/woo-coupon-normalization.js";

const NOW = new Date("2026-10-13T12:00:00Z");
const coupon = (overrides: Record<string, unknown> = {}) => ({
  id: 42, code: "SAVE15", discount_type: "percent", amount: "15.00",
  usage_count: 0, usage_limit: 100, date_expires_gmt: "2026-11-13T12:00:00",
  individual_use: true, product_ids: [123], excluded_product_ids: [],
  free_shipping: false, email_restrictions: ["customer@example.com"],
  used_by: ["someone@example.com"], meta_data: [{ key: "secret", value: "never" }],
  ...overrides,
});

describe("Woo coupon normalisation: mirror, do not validate provider business rules", () => {
  it("maps identity, code, UTC dates and safe metadata without persisting provider PII", () => {
    const result = normalizeWooCoupon(coupon(), NOW);
    expect(result).toMatchObject({
      shopifyDiscountNodeId: "woo:coupon:42", method: "CODE", title: "SAVE15",
      singleRedeemCode: "SAVE15", providerStatus: "ACTIVE", fixedSelectable: true,
      codeCount: 1, startsAt: null, providerType: "WooCoupon:code",
    });
    expect(result.endsAt?.toISOString()).toBe("2026-11-13T12:00:00.000Z");
    expect(result.providerSnapshot).toMatchObject({
      provider: "WOOCOMMERCE", couponId: 42, code: "SAVE15",
      discountType: "percent", amount: "15.00", usageLimit: 100,
      productIds: [123], individualUse: true,
    });
    const serialized = JSON.stringify(result);
    for (const forbidden of ["customer@example.com", "someone@example.com", "never"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("allows unknown or long types, zero or unusual amounts, expired/exhausted restrictions", () => {
    const type = `plugin_${"custom".repeat(40)}`;
    for (const oddity of [
      { discount_type: type }, { discount_type: "mystery" },
      { amount: "0" }, { amount: "not-a-normal-number" },
      { amount: "150", discount_type: "percent" },
      { date_expires_gmt: "2026-09-01T00:00:00" },
      { usage_count: 100, usage_limit: 100 },
      { date_expires_gmt: null, date_expires: "2026-11-01T01:00:00" },
      { usage_limit: -1 },
    ]) {
      expect(normalizeWooCoupon(coupon(oddity), NOW)).toMatchObject({
        providerStatus: "ACTIVE", fixedSelectable: true, singleRedeemCode: "SAVE15",
      });
    }
    const unknown = normalizeWooCoupon(coupon({ discount_type: type }), NOW);
    expect(unknown.providerType).toBe("WooCoupon:code");
    expect(unknown.providerSnapshot.discountType).toBe(type);
  });

  it("preserves >255-character codes without truncation", () => {
    const code = `LONG${"x".repeat(500)}`;
    const mapped = normalizeWooCoupon(coupon({ code }), NOW);
    expect(mapped.singleRedeemCode).toBe(code);
    expect(mapped.title).toBe(code);
    expect(mapped.providerSnapshot.code).toBe(code);
    expect(deliverableWooCode(code)).toBe(true);
  });

  it("records malformed optional fields as bounded diagnostics while keeping IDs and codes", () => {
    const scan = normalizeWooCouponBatch([coupon({
      date_expires_gmt: "yesterday", usage_limit: "not-an-int",
      product_ids: ["bad"], free_shipping: "yes", discount_type: { invalid: true },
      minimum_amount: { broken: true },
    })], NOW);
    expect(scan.observed[0]).toMatchObject({ providerStatus: "ACTIVE", fixedSelectable: true });
    expect(scan.observed[0]?.endsAt).toBeNull();
    expect(scan.observed[0]?.providerSnapshot).toMatchObject({
      dateExpiresGmt: null, usageLimit: null, productIds: null,
      freeShipping: null, discountType: null,
    });
    expect(scan.issueCount).toBe(6);
    expect(scan.issues).toContainEqual({
      couponId: 42, field: "date_expires_gmt", reason: "optional_field_ignored",
    });
    const diagnostic = JSON.stringify(scan.issues);
    expect(diagnostic).not.toContain("SAVE15");
    expect(diagnostic).not.toContain("customer@example.com");
  });

  it("retains a code-unusable provider ID without inventing an outbound code", () => {
    for (const code of [null, "", "  ", "AB\nINJECT", 1]) {
      const result = normalizeWooCoupon(coupon({ code }), NOW);
      expect(result).toMatchObject({
        shopifyDiscountNodeId: "woo:coupon:42", providerStatus: "UNDELIVERABLE",
        singleRedeemCode: null, fixedSelectable: false, codeCount: 0,
      });
      expect(result.providerSnapshot).not.toHaveProperty("code");
    }
    expect(normalizeWooCouponBatch([coupon({ code: null })], NOW))
      .toMatchObject({ codeUnavailableCount: 1, issueCount: 1 });
  });

  it("handles an empty scan; rejects malformed or duplicate provider IDs", () => {
    expect(normalizeWooCoupons([], NOW)).toEqual([]);
    for (const id of [-1, 0, "42", 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
      expect(() => normalizeWooCoupons([coupon({ id })], NOW))
        .toThrow("provider_identity_invalid");
    }
    expect(() => normalizeWooCoupons([coupon(), coupon({ code: "DIFFERENT" })], NOW))
      .toThrow("provider_identity_invalid");
  });

  it("limits diagnostics rather than copying huge malformed optional attributes", () => {
    const coupons = Array.from({ length: 100 }, (_, i) =>
      coupon({ id: i + 1, usage_count: { untrusted: "value" } }));
    const batch = normalizeWooCouponBatch(coupons, NOW);
    expect(batch.observed).toHaveLength(100);
    expect(batch.issueCount).toBe(100);
    expect(batch.issues).toHaveLength(20);
    expect(batch.issues.every((issue) => issue.reason === "optional_field_ignored")).toBe(true);
  });
});
