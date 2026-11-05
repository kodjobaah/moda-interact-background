import { describe, expect, it } from "vitest";
import { selectShippingPresentation } from "../../../../src/commerce/recommendations/shipping.js";

export function registerShippingResponseTests() {
  describe("shipping response selection", () => {
    it("preserves an observed requires-shipping fact when no policy is available", () => {
      const observation = {
        provider: "SHOPIFY", observedAt: "2026-11-05T00:00:00.000Z",
        product: { status: "AVAILABLE", productId: "p-1", variantId: "v-1", requiresShipping: true,
          virtual: false, weight: null, dimensions: null, shippingClassId: null, shippingClassSlug: null },
        policy: { status: "UNSUPPORTED", trust: "UNTRUSTED_REFERENCE", title: null, bodyStatus: "NOT_AVAILABLE",
          bodyHtml: null, url: null, updatedAt: null },
      } as const;
      expect(selectShippingPresentation({
        selection: { productId: "p-1", variantId: "v-1" }, observation, refreshed: observation,
      })).toMatchObject({ requiresShipping: true, policyUrl: null });
    });
  });
}
