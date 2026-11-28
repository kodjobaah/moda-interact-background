import { describe, expect, it } from "vitest";
import type { NormalizedAbandonedCheckout } from "../../../src/domain/abandoned-checkout.js";
import { collectShopifyCheckoutPhones } from "../../../src/services/shopify-whatsapp-consent/phone-resolution.js";

function checkout(input: {
  customer?: string | null;
  billing?: string | null;
  shipping?: string | null;
  billingCountry?: string | null;
  shippingCountry?: string | null;
}): NormalizedAbandonedCheckout {
  return {
    customer: {
      shopifyCustomerId: null,
      email: null,
      phone: input.customer ?? null,
      firstName: null,
      lastName: null,
    },
    billingPhone: input.billing ?? null,
    shippingPhone: input.shipping ?? null,
    billingCountryCode: input.billingCountry ?? "GB",
    shippingCountryCode: input.shippingCountry ?? "GB",
    internationalContext: {
      countryCode: "GB",
      currencyCode: "GBP",
      languageTag: null,
      languageSource: null,
      timeZone: null,
    },
  } as NormalizedAbandonedCheckout;
}

describe("Shopify checkout phone collection", () => {
  it("returns all distinct customer, billing and shipping numbers by priority", () => {
    const result = collectShopifyCheckoutPhones(
      checkout({
        customer: "+447400123456",
        billing: "+447400654321",
        shipping: "+447400987654",
      }),
    );
    expect(result.valid.map((p) => [p.source, p.canonicalRecipient])).toEqual([
      ["customer", "447400123456"],
      ["billing", "447400654321"],
      ["shipping", "447400987654"],
    ]);
    expect(result.invalidSources).toEqual([]);
  });

  it("stores a single canonical record when all checkout fields carry the same number", () => {
    const result = collectShopifyCheckoutPhones(
      checkout({
        customer: "+447400123456",
        billing: "07400 123456",
        shipping: "+44 7400 123456",
      }),
    );
    expect(result.valid).toEqual([
      { source: "customer", priority: 1, canonicalRecipient: "447400123456" },
    ]);
  });

  it("uses the shipping country context for local shipping numbers", () => {
    const result = collectShopifyCheckoutPhones(
      checkout({
        shipping: "07400 123456",
        shippingCountry: "GB",
      }),
    );
    expect(result.valid).toEqual([
      { source: "shipping", priority: 3, canonicalRecipient: "447400123456" },
    ]);
  });

  it("does not infer a recipient from an invalid phone", () => {
    const result = collectShopifyCheckoutPhones(
      checkout({ customer: "invalid", shipping: "+447400123456" }),
    );
    expect(result.valid.map((p) => p.source)).toEqual(["shipping"]);
    expect(result.invalidSources).toEqual(["customer"]);
  });
});
