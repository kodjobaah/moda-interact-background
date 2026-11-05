import { describe, expect, it } from "vitest";
import { decimalToMinorUnits, sumPurchaseSubtotal } from "../../../../src/commerce/recommendations/money.js";

describe("recommendation money", () => {
  it("uses strict currency precision and bigint subtotal arithmetic", () => {
    expect(decimalToMinorUnits("12.34", "GBP")).toBe(1234n);
    expect(decimalToMinorUnits("12.345", "GBP")).toBeNull();
    expect(decimalToMinorUnits("-1.00", "GBP")).toBeNull();
    expect(sumPurchaseSubtotal([{ amountDecimal: "12.34", quantity: 2 }], "GBP")).toBe(2468n);
  });
});
