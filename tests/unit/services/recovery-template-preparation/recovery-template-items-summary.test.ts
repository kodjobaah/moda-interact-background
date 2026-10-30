import { describe, expect, it } from "vitest";
import { formatCheckoutItemsSummary } from "../../../../src/services/recovery-template-preparation/recovery-template-items-summary.js";

describe("saved checkout item summaries", () => {
  it("formats Shopify title, variant and quantity deterministically", () => {
    const items = [
      { title: "Shoes", variantTitle: "Blue / 9", quantity: 2 },
      { title: "Water bottle", variantTitle: "Default Title", quantity: 1 },
    ];
    expect(formatCheckoutItemsSummary(items, "en-US"))
      .toBe("2 × Shoes (Blue / 9) and 1 × Water bottle");
    expect(formatCheckoutItemsSummary(items, "en-US"))
      .toBe(formatCheckoutItemsSummary(items, "en-US"));
  });

  it("accepts WooCommerce persisted item rows and locale-formats quantities and lists", () => {
    const items = [
      { productId: "p1", variantId: null, title: "Chaussures", quantity: 2, total: "20.00" },
      { productId: "p2", variantId: "v2", title: "Bouteille", quantity: 1, total: "8.00" },
      { productId: "p3", variantId: null, title: "Sac", quantity: 1, total: "12.00" },
      { productId: "p4", variantId: null, title: "Gourde", quantity: 3, total: "6.00" },
    ];
    expect(formatCheckoutItemsSummary(items, "fr-FR"))
      .toBe("2 × Chaussures, 1 × Bouteille, 1 × Sac et +1");
  });

  it("omits invalid titles and fails closed if no valid product title remains", () => {
    expect(formatCheckoutItemsSummary([
      { title: "{{1}}", quantity: 2 }, { title: "\u0000unsafe", quantity: 1 },
      { title: "Valid", quantity: 1 },
    ], "en")).toBe("1 × Valid");
    expect(formatCheckoutItemsSummary([{ title: "{{1}}", quantity: 1 }], "en")).toBeNull();
    expect(formatCheckoutItemsSummary([], "en")).toBeNull();
    expect(formatCheckoutItemsSummary("not an array", "en")).toBeNull();
    expect(formatCheckoutItemsSummary([{ title: "Shoe", quantity: 0 }], "en")).toBeNull();
  });

  it("limits displayed rows, appends a bounded remainder and caps output length", () => {
    const many = Array.from({ length: 8 }, (_, index) => ({ title: `Item ${index}`, quantity: 1 }));
    expect(formatCheckoutItemsSummary(many, "en"))
      .toBe("1 × Item 0, 1 × Item 1, 1 × Item 2, and +5");
    const long = formatCheckoutItemsSummary(Array.from({ length: 3 }, () => ({
      title: "x".repeat(160), quantity: 1,
    })), "en");
    expect(long?.length).toBeLessThanOrEqual(400);
    expect(long?.endsWith("…")).toBe(true);
  });
});
