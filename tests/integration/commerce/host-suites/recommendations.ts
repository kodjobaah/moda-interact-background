import { describe, expect, it } from "vitest";
import { hostFixture as f } from "../host.fixture.js";

export function registerRecommendationHostTests() {
  describe("recommendation grants and policy gates", () => {
    it("retains both canonical discount descriptors while NONE exposes neither to the model", async () => {
      await f.run(async (request) => {
        expect(request.tools.map((tool) => tool.name)).not.toContain("commerce_get_discount_options");
        expect(request.tools.map((tool) => tool.name)).not.toContain("commerce_get_discount_details");
        return f.final();
      });
      const names = f.active.builtInTools.map((tool) => tool.name);
      expect(names).toEqual(["commerce_get_discount_options", "commerce_get_discount_details"]);
      expect(f.grants.get(f.state.id).grantedTools.filter((tool: any) => tool.kind === "BUILT_IN")).toHaveLength(2);
      expect(f.observations.filter((call) => call.method === "tools/call")).toHaveLength(0);
    });

    it("replaces model prose with an exact refreshed product answer", async () => {
      const descriptor = f.active.capabilities[0]!.toolDescriptor;
      descriptor.name = "commerce_get_product";
      descriptor.description = "Read a current product and variant.";
      descriptor.inputSchema = {
        type: "object", properties: { productId: { type: "string", maxLength: 128 }, variantId: { type: ["string", "null"], maxLength: 128 } },
        required: ["productId", "variantId"], additionalProperties: false,
      };
      f.active.grantedTools[0]!.toolName = "commerce_get_product";
      f.active.responseContract.detailsSchema = {
        type: "object",
        properties: {
          productRecommendationVersion: { type: "string", maxLength: 1, enum: ["1"] },
          productRecommendations: { type: "array", maxItems: 3, items: {
            type: "object", properties: {
              scope: { type: "string", maxLength: 19, enum: ["PRODUCT_ONLY", "ADD_TO_BASKET", "REPLACE_BASKET_LINE"] },
              basketLineId: { type: ["string", "null"], maxLength: 128 }, productId: { type: "string", maxLength: 128 },
              variantId: { type: ["string", "null"], maxLength: 128 },
              quantity: { type: "integer", minimum: 1, maximum: 99 },
              promotionKind: { type: "string", maxLength: 11, enum: ["NONE", "NATIVE_SALE", "DISCOUNT"] },
              offerIds: { type: "array", maxItems: 3, items: { type: "string", maxLength: 128 } },
            }, required: ["scope", "basketLineId", "productId", "variantId", "quantity", "promotionKind", "offerIds"],
            additionalProperties: false,
          } },
        }, required: ["productRecommendationVersion", "productRecommendations"], additionalProperties: false,
      };
      f.active.responseContractHash = f.digest(f.responseContractCanonicalJson(f.active.responseContract));
      f.toolResults = { commerce_get_product: { contractVersion: "commerce.v1", status: "OK", renderedText: "Blue linen shirt", data: { product: {
        productId: "product-shirt", variantId: "variant-blue", title: "Blue linen shirt",
        url: "https://fixture.myshopify.com/products/blue-linen-shirt", available: true,
        unitPrice: "24.00", currency: "GBP", productType: "Shirt", vendor: "Fixture",
        categories: [], categoryIds: [], collectionIds: [], saleEvidence: null, observedAt: "2026-11-05T12:00:00Z",
      } } } };
      let step = 0;
      const result = await f.run(async (request) => {
        step += 1;
        if (step === 1) {
          expect(request.tools.map((tool) => tool.name)).toContain("commerce_get_product");
          return { calls: [{ name: "commerce_get_product", arguments: { productId: "product-shirt", variantId: "variant-blue" } }], outputTokens: 10 };
        }
        return f.final({ answerKind: "ANSWER", referralReason: null, replyText: "MODEL PROSE MUST BE DISCARDED",
          details: { productRecommendationVersion: "1", productRecommendations: [{ scope: "PRODUCT_ONLY",
            basketLineId: null, productId: "product-shirt", variantId: "variant-blue", quantity: 1,
            promotionKind: "NONE", offerIds: [] }] } });
      });
      expect(result.replyText).toBe([
        "For a proposed purchase of 1:",
        "Blue linen shirt",
        "Current listed price: £24.00",
        "View product: https://fixture.myshopify.com/products/blue-linen-shirt",
      ].join("\n"));
      expect(result.replyText).not.toContain("MODEL PROSE");
      expect(result.hostComposedReplyCandidates).toEqual([
        result.replyText,
        "Store: https://fixture.myshopify.com",
      ]);
      expect(f.observations.filter((call) => call.method === "tools/call" && call.params.name === "commerce_get_product")).toHaveLength(2);
      expect(f.observations.filter((call) => call.method === "tools/call" && String(call.params.name).includes("discount"))).toHaveLength(0);
    });
  });
}
