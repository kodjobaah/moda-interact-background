import { describe, expect, it } from "vitest";
import { selectShippingPresentation } from "../../../../src/commerce/recommendations/shipping.js";

describe("selectShippingPresentation", () => {
  it("retains a confirmed requires-shipping fact when policy is unavailable", () => {
    const info = { provider: "SHOPIFY" as const, observedAt: "2026-11-05T00:00:00.000Z",
      product: { status: "AVAILABLE" as const, productId: "p1", variantId: "v1", requiresShipping: true,
        virtual: false, weight: null, dimensions: null, shippingClassId: null, shippingClassSlug: null },
      policy: { status: "SCOPE_NOT_GRANTED" as const, trust: "UNTRUSTED_REFERENCE" as const, title: null,
        bodyStatus: "NOT_AVAILABLE" as const, bodyHtml: null, url: null, updatedAt: null } };
    expect(selectShippingPresentation({ selection: { productId: "p1", variantId: "v1" }, observation: info, refreshed: info }))
      .toEqual({ requiresShipping: true, policyUrl: null, limitation: true });
  });

  it("keeps an available policy URL when the source body is empty", () => {
    const info = { provider: "SHOPIFY" as const, observedAt: "2026-11-05T00:00:00.000Z",
      product: { status: "AVAILABLE" as const, productId: "p1", variantId: "v1", requiresShipping: true,
        virtual: false, weight: null, dimensions: null, shippingClassId: null, shippingClassSlug: null },
      policy: { status: "AVAILABLE" as const, trust: "UNTRUSTED_REFERENCE" as const, title: null,
        bodyStatus: "EMPTY" as const, bodyHtml: null, url: "https://shop.example/policies/shipping", updatedAt: null } };
    expect(selectShippingPresentation({ selection: { productId: "p1", variantId: "v1" }, observation: info, refreshed: info }))
      .toMatchObject({ requiresShipping: true, policyUrl: "https://shop.example/policies/shipping" });
  });
});
