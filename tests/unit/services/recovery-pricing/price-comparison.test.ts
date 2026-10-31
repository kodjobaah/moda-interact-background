import { describe, expect, it } from "vitest";
import {
  compareObservedLinePrices,
  deriveCheckoutPriceReconciliation,
  fingerprintRecoveryPricingBasket,
} from "../../../../src/services/recovery-pricing/price-comparison.js";
import type { LinePriceObservation } from "../../../../src/services/recovery-pricing/checkout-price-reconciliation.types.js";

describe("recovery pricing comparison", () => {
  it("compares decimal values exactly and never interprets catalogue equality as checkout proof", () => {
    const equal = compareObservedLinePrices({
      checkoutUnitPrice: "80.00",
      checkoutCurrency: "GBP",
      catalogueUnitPrice: "80.0",
      catalogueCurrency: "GBP",
    });
    expect(equal).toEqual({
      catalogueComparison: "EQUAL",
      reasonCodes: ["PRICE_CONTEXT_UNVERIFIED"],
    });

    const different = compareObservedLinePrices({
      checkoutUnitPrice: "9007199254740993.00",
      checkoutCurrency: "USD",
      catalogueUnitPrice: "9007199254740992.99",
      catalogueCurrency: "USD",
    });
    expect(different.catalogueComparison).toBe("DIFFERENT");
    expect(different.reasonCodes).toContain("CATALOGUE_PRICE_DIFFERENCE");
    expect(different.reasonCodes).toContain("PRICE_CONTEXT_UNVERIFIED");
  });

  it("uses runtime currency precision for GBP/USD, JPY and KWD", () => {
    expect(compareObservedLinePrices({
      checkoutUnitPrice: "1.00", checkoutCurrency: "GBP",
      catalogueUnitPrice: "1.0", catalogueCurrency: "GBP",
    }).catalogueComparison).toBe("EQUAL");
    expect(compareObservedLinePrices({
      checkoutUnitPrice: "1.00", checkoutCurrency: "USD",
      catalogueUnitPrice: "1.00", catalogueCurrency: "USD",
    }).catalogueComparison).toBe("EQUAL");
    expect(compareObservedLinePrices({
      checkoutUnitPrice: "100", checkoutCurrency: "JPY",
      catalogueUnitPrice: "101", catalogueCurrency: "JPY",
    }).catalogueComparison).toBe("DIFFERENT");
    expect(compareObservedLinePrices({
      checkoutUnitPrice: "1.234", checkoutCurrency: "KWD",
      catalogueUnitPrice: "1.233", catalogueCurrency: "KWD",
    }).catalogueComparison).toBe("DIFFERENT");
  });

  it("fails closed on excess precision, malformed amounts, unsupported currencies and currency mismatch", () => {
    for (const checkoutUnitPrice of ["1.001", "-1.00", " 1.00", "1e2", "1."]) {
      expect(compareObservedLinePrices({
        checkoutUnitPrice, checkoutCurrency: "USD",
        catalogueUnitPrice: "1.00", catalogueCurrency: "USD",
      }).catalogueComparison).toBe("INCOMPARABLE");
    }
    expect(compareObservedLinePrices({
      checkoutUnitPrice: "1.00", checkoutCurrency: "GBP",
      catalogueUnitPrice: "1.00", catalogueCurrency: "USD",
    })).toMatchObject({ catalogueComparison: "INCOMPARABLE", reasonCodes: expect.arrayContaining(["CURRENCY_MISMATCH"]) });
    expect(compareObservedLinePrices({
      checkoutUnitPrice: "1.00", checkoutCurrency: "ZZZ",
      catalogueUnitPrice: "1.00", catalogueCurrency: "ZZZ",
    })).toMatchObject({ catalogueComparison: "INCOMPARABLE", reasonCodes: expect.arrayContaining(["SOURCE_OBSERVATION_INVALID"]) });
  });

  it("hashes only the canonical ordered recovery basket without PII and preserves source line order", () => {
    const basket = {
      shopId: "shop-1",
      checkoutRecoveryId: "recovery-1",
      generation: 7,
      currency: "GBP",
      lineItems: [{ productId: "product-1", variantId: "variant-1", quantity: 2, price: "10.00" }],
    };
    const reordered = {
      generation: 7,
      checkoutRecoveryId: "recovery-1",
      shopId: "shop-1",
      currency: "GBP",
      lineItems: [{ price: "10.00", quantity: 2, variantId: "variant-1", productId: "product-1" }],
    };
    expect(fingerprintRecoveryPricingBasket(basket)).toBe(fingerprintRecoveryPricingBasket(reordered));
    expect(fingerprintRecoveryPricingBasket(basket)).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintRecoveryPricingBasket({ ...basket, lineItems: [...basket.lineItems, ...basket.lineItems] }))
      .not.toBe(fingerprintRecoveryPricingBasket(basket));
    expect(() => fingerprintRecoveryPricingBasket({ ...basket, lineItems: [{ productId: 7 }] }))
      .toThrow("Invalid basket fingerprint field: productId");
  });

  it("forces catalogue-only reports to remain partial without a current checkout subtotal", () => {
    const line: LinePriceObservation = {
      lineKey: "line-0001", productId: "product-1", variantId: "variant-1", quantity: 2,
      checkoutUnitPrice: "10.00", checkoutCurrency: "GBP", catalogueUnitPrice: "11.00",
      catalogueCurrency: "GBP", catalogueObservedAt: "2026-10-31T09:00:00.000Z",
      catalogueComparison: "DIFFERENT", checkoutPriceChange: "CONFIRMED_CHANGED", reasonCodes: [],
    };
    const report = deriveCheckoutPriceReconciliation({
      shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1",
      generation: 7, basketFingerprint: "a".repeat(64), evaluatedAt: "2026-10-31T09:00:00.000Z",
      lines: [line],
    });
    expect(report.completeness).toBe("PARTIAL");
    expect(report.currentMerchandiseSubtotal).toBeNull();
    expect(report.lines[0]?.checkoutPriceChange).toBe("UNVERIFIABLE");
    expect(report.lines[0]?.reasonCodes).toContain("PRICE_CONTEXT_UNVERIFIED");
  });
});