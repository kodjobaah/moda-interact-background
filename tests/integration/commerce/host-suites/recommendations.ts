import { describe, expect, it } from "vitest";
import { composeCommerceWhatsAppPreview } from "@modainteract/moda-interact-shared/commerce/presentation";
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

    it("preserves agent prose with exact freshly verified product presentation", async () => {
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
        productId: "gid://shopify/Product/101", variantId: "gid://shopify/ProductVariant/101", title: "Blue linen shirt",
        url: "https://fixture.myshopify.com/products/blue-linen-shirt", available: true,
        unitPrice: "24.00", currency: "GBP", productType: "Shirt", vendor: "Fixture",
        categories: [], categoryIds: [], collectionIds: [], saleEvidence: null, observedAt: "2026-11-05T12:00:00Z",
      } } } };
      let step = 0;
      const result = await f.run(async (request) => {
        step += 1;
        if (step === 1) {
          expect(request.tools.map((tool) => tool.name)).toContain("commerce_get_product");
          return { calls: [{ name: "commerce_get_product", arguments: { productId: "gid://shopify/Product/101", variantId: "gid://shopify/ProductVariant/101" } }], outputTokens: 10 };
        }
        return f.final({ answerKind: "ANSWER", referralReason: null, replyText: "The blue linen shirt is available for you.",
          details: { productRecommendationVersion: "1", productRecommendations: [{ scope: "PRODUCT_ONLY",
            basketLineId: null, productId: "gid://shopify/Product/101", variantId: "gid://shopify/ProductVariant/101", quantity: 1,
            promotionKind: "NONE", offerIds: [] }] } });
      });
      expect(result.replyText).toBe("The blue linen shirt is available for you.");
      expect(result.commercePresentation?.verified.products).toMatchObject([{title:"Blue linen shirt"}]);
      expect(result.commercePresentation?.verifiedProducts?.products).toMatchObject([{productId:"gid://shopify/Product/101",variantId:"gid://shopify/ProductVariant/101"}]);
      expect(result).not.toHaveProperty("hostComposedReplyCandidates");
      expect(f.observations.filter((call) => call.method === "tools/call" && call.params.name === "commerce_get_product")).toHaveLength(2);
      expect(f.observations.filter((call) => call.method === "tools/call" && String(call.params.name).includes("discount"))).toHaveLength(0);
    });

    it("retains checkout identity for a later generic product question and composes verified facts", async () => {
      const descriptor = f.active.capabilities[0]!.toolDescriptor;
      descriptor.name = "commerce_get_product";
      descriptor.description = "Read a current product and variant.";
      descriptor.inputSchema = {
        type: "object", properties: { productId: { type: "string", maxLength: 128 }, variantId: { type: ["string", "null"], maxLength: 128 } },
        required: ["productId", "variantId"], additionalProperties: false,
      };
      f.active.grantedTools[0]!.toolName = "commerce_get_product";
      f.active.responseContract.detailsSchema = {
        type: "object", properties: { productDetailSelections: { type: "array", maxItems: 3, items: {
          type: "object", properties: { productId: { type: "string", maxLength: 128 }, variantId: { type: ["string", "null"], maxLength: 128 } },
          required: ["productId", "variantId"], additionalProperties: false,
        } } }, required: ["productDetailSelections"], additionalProperties: false,
      };
      f.active.responseContractHash = f.digest(f.responseContractCanonicalJson(f.active.responseContract));
      f.toolResults = { commerce_get_product: { contractVersion: "commerce.v1", status: "OK", renderedText: "Blue linen shirt", data: { product: {
        productId: "gid://shopify/Product/101", variantId: "gid://shopify/ProductVariant/101", title: "Blue linen shirt",
        url: null, available: false, description: { status: "AVAILABLE", text: "Soft linen fabric." },
        unitPrice: "24.00", currency: "GBP", productType: "Shirt", vendor: "Fixture",
        categories: [], categoryIds: [], collectionIds: [], saleEvidence: null, observedAt: "2026-11-05T12:00:00Z",
      } } } };
      await f.run(async () => f.final());
      const laterContext = structuredClone(f.context);
      laterContext.conversation.history = [{ role: "assistant", content: "We can help with your checkout." }];
      laterContext.conversation.messages = [{ role: "user", content: "Tell me about the fabric of another shirt, not my checkout." }];
      let step = 0;
      const result = await f.run(async (request) => {
        expect((request.context as any).trustedRecovery.recovery).toMatchObject({ id: laterContext.recovery.id, checkoutToken: laterContext.recovery.checkoutToken });
        step += 1;
        if (step === 1) {
          expect(request.tools.map((tool) => tool.name)).toContain("commerce_get_product");
          return { calls: [{ name: "commerce_get_product", arguments: { productId: "gid://shopify/Product/101", variantId: "gid://shopify/ProductVariant/101" } }], outputTokens: 10 };
        }
        return f.final({ answerKind: "ANSWER", referralReason: null, replyText: "The blue linen shirt is available for you.",
          details: { productDetailSelections: [{ productId: "gid://shopify/Product/101", variantId: "gid://shopify/ProductVariant/101" }] } });
      }, laterContext);
      expect(f.observations.every(call => call.claims.shopId === laterContext.shopId)).toBe(true);
      expect(result.commercePresentation?.verified).toMatchObject({ disposition: "PRODUCT_DETAILS", products: [], includeNoVerifiedOffer: false });
      expect(result.commercePresentation?.verified.productFacts).toHaveLength(1);
      const composed = composeCommerceWhatsAppPreview({ envelope: result.commercePresentation!.envelope, presentation: result.commercePresentation!.verified });
      expect(composed).toMatchObject({ kind: "ready" });
      if (composed.kind === "ready") expect(composed.body).toContain("Soft linen fabric.");
      expect(result.productContextUpdate?.references).toEqual(expect.arrayContaining([expect.objectContaining({ productId: "gid://shopify/Product/101", variantId: "gid://shopify/ProductVariant/101" })]));
      expect(f.observations.filter((call) => call.method === "tools/call" && call.params.name === "commerce_get_product")).toHaveLength(2);
      expect(f.observations.filter((call) => call.method === "tools/call" && String(call.params.name).includes("discount"))).toHaveLength(0);
    });

    it("uses the current-context product before browse proposals in soft replies", async () => {
      const base = structuredClone(f.active.capabilities[0]!);
      const makeCapability = (suffix: string, name: string, inputSchema: Record<string, unknown>, position: number) => ({
        ...structuredClone(base),
        capabilityId: `capability-${suffix}`,
        key: `feature_${suffix}`,
        position,
        toolDescriptor: { ...structuredClone(base.toolDescriptor), toolId: `tool-${suffix}`,
          toolRevisionId: `revision-${suffix}`, name, description: `Fixture ${name}.`, inputSchema },
      });
      const search = makeCapability("search", "commerce_search_products", {
        type: "object", properties: {
          query: { type: ["string", "null"], maxLength: 200 }, browse: { type: "boolean" },
          availableOnly: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 20 },
          cursor: { type: ["string", "null"], maxLength: 2048 },
        }, required: ["query", "browse", "availableOnly", "limit", "cursor"], additionalProperties: false,
      }, 0);
      const get = makeCapability("get", "commerce_get_product", {
        type: "object", properties: {
          productId: { type: "string", maxLength: 128 }, variantId: { type: ["string", "null"], maxLength: 128 },
        }, required: ["productId", "variantId"], additionalProperties: false,
      }, 1);
      f.active.capabilities = [search, get] as any;
      f.active.selectedCapabilityKeys = [search.key, get.key];
      f.active.grantedTools = [
        ...f.active.grantedTools.filter((tool: any) => tool.kind === "BUILT_IN"),
        ...[search, get].map((capability) => ({
          toolId: capability.toolDescriptor.toolId,
          toolRevisionId: capability.toolDescriptor.toolRevisionId,
          toolName: capability.toolDescriptor.name,
          definitionVersion: capability.toolDescriptor.definitionVersion,
          capabilityKeys: [capability.key],
        })),
      ] as any;
      f.active.responseContract.detailsSchema = {
        type: "object",
        properties: {
          responseDisposition: { type: "string", maxLength: 32, enum: ["STANDARD", "OUT_OF_SCOPE_REDIRECT", "SHIPPING_INFORMATION_UNVERIFIED"] },
          productRecommendationVersion: { type: "string", maxLength: 1, enum: ["1"] },
          productRecommendations: { type: "array", maxItems: 3, items: {
            type: "object", properties: {
              scope: { type: "string", maxLength: 19, enum: ["PRODUCT_ONLY", "ADD_TO_BASKET", "REPLACE_BASKET_LINE"] },
              basketLineId: { type: ["string", "null"], maxLength: 128 }, productId: { type: "string", maxLength: 128 },
              variantId: { type: ["string", "null"], maxLength: 128 }, quantity: { type: "integer", minimum: 1, maximum: 99 },
              promotionKind: { type: "string", maxLength: 11, enum: ["NONE", "NATIVE_SALE", "DISCOUNT"] },
              offerIds: { type: "array", maxItems: 3, items: { type: "string", maxLength: 128 } },
            }, required: ["scope", "basketLineId", "productId", "variantId", "quantity", "promotionKind", "offerIds"],
            additionalProperties: false,
          } },
        }, required: ["responseDisposition", "productRecommendationVersion", "productRecommendations"], additionalProperties: false,
      };
      f.active.responseContractHash = f.digest(f.responseContractCanonicalJson(f.active.responseContract));
      const product = (productId: string, variantId: string, title: string, slug: string, unitPrice: string) => ({
        productId, variantId, title, url: `https://fixture.myshopify.com/products/${slug}`, available: true,
        unitPrice, currency: "GBP", productType: "Shirt", vendor: "Fixture", categories: [], categoryIds: [],
        collectionIds: [], saleEvidence: null, observedAt: "2026-11-05T12:00:00Z",
      });
      const currentProduct = product("gid://shopify/Product/102", "gid://shopify/ProductVariant/102", "Customer context shirt", "customer-context", "18.00");
      const browseProduct = product("gid://shopify/Product/103", "gid://shopify/ProductVariant/103", "Browse shirt", "browse-shirt", "22.00");
      const result = (data: unknown, renderedText: string) => ({ contractVersion: "commerce.v1", status: "OK", data, renderedText });
      const searchResult = (item: typeof currentProduct) => ({ products: [item], cursor: null, truncated: false });
      f.toolResults = {
        commerce_search_products: [
          result(searchResult(currentProduct), "Customer context shirt"),
          result(searchResult(browseProduct), "Browse shirt"),
        ],
        commerce_get_product: result({ product: currentProduct }, "Customer context shirt"),
      };
      let step = 0;
      const proposal = (item: typeof currentProduct) => ({ scope: "PRODUCT_ONLY", basketLineId: null,
        productId: item.productId, variantId: item.variantId, quantity: 1, promotionKind: "NONE", offerIds: [] });
      const response = await f.run(async () => {
        step += 1;
        if (step === 1) return { calls: [{ name: "commerce_search_products", arguments: {
          query: "linen shirt", browse: false, availableOnly: true, limit: 5, cursor: null,
        } }], outputTokens: 10 };
        if (step === 2) return { calls: [{ name: "commerce_search_products", arguments: {
          query: null, browse: true, availableOnly: true, limit: 5, cursor: null,
        } }], outputTokens: 10 };
        return f.final({ answerKind: "ANSWER", referralReason: null, replyText: "I can help with the product you were viewing.",
          details: { responseDisposition: "OUT_OF_SCOPE_REDIRECT", productRecommendationVersion: "1",
            productRecommendations: [proposal(browseProduct), proposal(currentProduct)] } });
      });

      expect(response.replyText).toBe("I can help with the product you were viewing.");
      expect(response.commercePresentation?.productPairs).toEqual([{productId:currentProduct.productId,variantId:currentProduct.variantId}]);
      expect(response.commercePresentation?.verified.products).not.toEqual(expect.arrayContaining([expect.objectContaining({title:"Browse shirt"})]));
      expect(f.observations.filter((call) => call.method === "tools/call").map((call) => call.params.name)).toEqual([
        "commerce_search_products", "commerce_search_products", "commerce_get_product",
      ]);
      expect(f.observations.filter((call) => call.method === "tools/call" && String(call.params.name).includes("discount"))).toHaveLength(0);
    });
  });
}
