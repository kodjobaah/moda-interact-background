import { describe, expect, it } from "vitest";
import { hostFixture as f } from "../host.fixture.js";

const pair = { productId: "gid://shopify/Product/101", variantId: "gid://shopify/ProductVariant/101" };
const generic = { productId: null, variantId: null };
const recommendation = { ...pair, scope: "PRODUCT_ONLY", basketLineId: null, quantity: 1, promotionKind: "NONE", offerIds: [] };
const product = { ...pair, title: "Blue linen shirt", url: "https://fixture.myshopify.com/products/shirt", available: true,
  unitPrice: "24.00", currency: "GBP", productType: "Shirt", vendor: "Fixture", categories: [], categoryIds: [], collectionIds: [], saleEvidence: null,
  observedAt: "2026-11-05T12:00:00Z" };
const shipping = { provider: "SHOPIFY", observedAt: "2026-11-05T12:00:00Z",
  product: { status: "NOT_REQUESTED", productId: null, variantId: null, requiresShipping: null, virtual: null, weight: null,
    dimensions: null, shippingClassId: null, shippingClassSlug: null },
  policy: { status: "SCOPE_NOT_GRANTED", trust: "UNTRUSTED_REFERENCE", title: null, bodyStatus: "NOT_AVAILABLE", bodyHtml: null, url: null, updatedAt: null } };
const ok = (data: unknown) => ({ contractVersion: "commerce.v1", status: "OK", data, renderedText: "Untrusted fixture text" });
function configure() {
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
    }, required: [], additionalProperties: false,
  };
  f.active.responseContractHash = f.digest(f.responseContractCanonicalJson(f.active.responseContract));

  Object.assign(f.active.responseContract.detailsSchema.properties!, {
    responseDisposition: { type: "string", enum: ["STANDARD", "SHIPPING_INFORMATION_UNVERIFIED"], maxLength: 64 },
    shippingInformationSelection: { type: "object", properties: {
      productId: { type: ["string", "null"], maxLength: 128 }, variantId: { type: ["string", "null"], maxLength: 128 },
    }, required: ["productId", "variantId"], additionalProperties: false },
  });
  const capability = structuredClone(f.active.capabilities[0]!);
  capability.capabilityId = "shipping-capability"; capability.key = "shipping-read"; capability.position = 1;
  capability.toolDescriptor = { ...capability.toolDescriptor, toolId: "shipping-tool", toolRevisionId: "shipping-revision",
    name: "commerce_get_shipping_information", description: "Read shipping information.", inputSchema: {
      type: "object", properties: { productId: { type: ["string", "null"], maxLength: 128 }, variantId: { type: ["string", "null"], maxLength: 128 } },
      required: ["productId", "variantId"], additionalProperties: false,
    } };
  f.active.capabilities.push(capability); f.active.selectedCapabilityKeys.push(capability.key);
  f.active.grantedTools.push({ toolId: "shipping-tool", toolRevisionId: "shipping-revision", toolName: "commerce_get_shipping_information",
    definitionVersion: "1.0.0", capabilityKeys: [capability.key] });
  f.active.responseContractHash = f.digest(f.responseContractCanonicalJson(f.active.responseContract));
  f.toolResults = { commerce_get_product: ok({ product }), commerce_get_shipping_information: ok(shipping) };
}
const answer = (details: Record<string, unknown>) => f.final({ answerKind: "ANSWER", referralReason: null,
  replyText: "Our current catalogue has the blue linen shirt.", details });
export function registerSelectionSemanticsTests() {
  describe("published runner to host selection semantics", () => {
    it.each(["missing version", "unobserved shipping", "unobserved shipping disposition"])("corrects %s once using observed product IDs", async mode => {
      configure(); let calls = 0;
      const result = await f.run(async request => {
        calls++;
        if (calls === 1) return { calls: [{ name: "commerce_get_product", arguments: pair }], outputTokens: 1 };
        if (calls === 2) return answer(mode === "missing version" ? { responseDisposition: "STANDARD", productRecommendations: [recommendation] } :
          mode === "unobserved shipping" ? { shippingInformationSelection: generic } : { responseDisposition: "SHIPPING_INFORMATION_UNVERIFIED" });
        expect(calls).toBe(3); expect(request.requiredToolName).toBe("finalResponse");
        expect(request.tools.map(tool => tool.name)).toEqual(["finalResponse"]);
        return answer({ productRecommendationVersion: "1", productRecommendations: [recommendation] });
      });
      expect(calls).toBe(3); expect(result.commercePresentation!.verified.products).toHaveLength(1);
      expect(f.observations.filter(call => call.method === "tools/call")).toHaveLength(2);
    });
    it("refuses unobserved shipping disposition even with a freshly verified fallback product", async () => {
      configure(); let calls = 0;
      await expect(f.run(async () => ++calls === 1 ? { calls: [{ name: "commerce_get_product", arguments: pair }], outputTokens: 1 } :
        answer({ productRecommendationVersion: "1", productRecommendations: [recommendation], responseDisposition: "SHIPPING_INFORMATION_UNVERIFIED" })))
        .rejects.toMatchObject({ code: "INVALID_FINAL", retryable: false });
      expect(calls).toBe(2);
      expect(f.observations.filter(call => call.method === "tools/call" && call.params.name === "commerce_get_product")).toHaveLength(2);
    });
    it("preserves shipping-only limitations when no products were observed", async () => {
      configure(); let calls = 0;
      const result = await f.run(async () => ++calls === 1 ? { calls: [{ name: "commerce_get_shipping_information", arguments: generic }], outputTokens: 1 } :
        answer({ responseDisposition: "STANDARD", shippingInformationSelection: generic }));
      expect(calls).toBe(2); expect(result.commercePresentation!.verified.products).toHaveLength(0);
      expect(f.observations.filter(call => call.method === "tools/call")).toHaveLength(2);
    });
    it("logs only bounded final-selection shape, never model prose", async () => {
      configure(); let calls = 0;
      const records: Array<Record<string, unknown>> = [];
      const logger = f.createLogger({ serviceName: "moda-messaging-worker", environment: f.environment,
        sink: record => records.push(record as unknown as Record<string, unknown>) });
      await f.run(async () => ++calls === 1 ? { calls: [{ name: "commerce_get_product", arguments: pair }], outputTokens: 1 } :
        f.final({ answerKind: "ANSWER", referralReason: null, replyText: "PRIVATE_PROSE_SENTINEL", details: {
          responseDisposition: "STANDARD", productRecommendationVersion: "1", productRecommendations: [recommendation],
        } }), f.context, undefined, logger);
      const shapes = records.filter(record => record.event === "commerce.response.composition" &&
        (record.data as Record<string, unknown>)?.stage === "SELECTION_SHAPE");
      expect(shapes).toHaveLength(1);
      expect(shapes[0]!.data).toMatchObject({ recommendationVersion: "V1", recommendationArray: "ARRAY", recommendationCount: 1,
        detailArray: "ABSENT", optionArray: "ABSENT", disposition: "STANDARD", rawShippingSelectionPresent: false,
        parsedShippingSelectionPresent: false, parsedRecommendationCount: 1 });
      expect(JSON.stringify(shapes)).not.toContain("PRIVATE_PROSE_SENTINEL");
      expect(JSON.stringify(shapes)).not.toContain(pair.productId);
    });
    it("refuses an exhausted correction without repeating product reads", async () => {
      configure(); let calls = 0;
      await expect(f.run(async () => ++calls === 1 ? { calls: [{ name: "commerce_get_product", arguments: pair }], outputTokens: 1 } :
        answer({ responseDisposition: "STANDARD", productRecommendations: [recommendation] }))).rejects.toMatchObject({ code: "INVALID_FINAL", retryable: false });
      expect(calls).toBe(3); expect(f.observations.filter(call => call.method === "tools/call")).toHaveLength(1);
    });
    it.each([false, true])("accepts observed generic policy limitations, dispositionOnly=%s", async dispositionOnly => {
      configure(); let calls = 0;
      const result = await f.run(async () => ++calls === 1 ? { calls: [
        { name: "commerce_get_product", arguments: pair }, { name: "commerce_get_shipping_information", arguments: generic },
      ], outputTokens: 1 } : answer(dispositionOnly ? { responseDisposition: "SHIPPING_INFORMATION_UNVERIFIED" } :
        { responseDisposition: "STANDARD", shippingInformationSelection: generic }));
      expect(calls).toBe(2); expect(result.commercePresentation!.verified.products).toHaveLength(0);
      expect(f.observations.filter(call => call.method === "tools/call" && call.params.name === "commerce_get_shipping_information")).toHaveLength(2);
    });
    it.each(["provider", "product", "variant"])("does not refresh or trust %s mismatch in original shipping evidence", async mode => {
      configure(); const original = structuredClone(shipping);
      if (mode === "provider") original.provider = "WOOCOMMERCE";
      if (mode === "product") Object.assign(original.product, { status: "AVAILABLE", productId: pair.productId, requiresShipping: true, virtual: false });
      if (mode === "variant") Object.assign(original.product, { status: "AVAILABLE", productId: pair.productId, variantId: pair.variantId, requiresShipping: true, virtual: false });
      f.toolResults = { ...f.toolResults, commerce_get_shipping_information: [ok(original), ok(shipping)] };
      let calls = 0;
      await expect(f.run(async () => ++calls === 1 ? { calls: [
        { name: "commerce_get_product", arguments: pair }, { name: "commerce_get_shipping_information", arguments: generic },
      ], outputTokens: 1 } : answer({ productRecommendationVersion: "1", productRecommendations: [recommendation],
        responseDisposition: "SHIPPING_INFORMATION_UNVERIFIED", shippingInformationSelection: generic })))
        .rejects.toMatchObject({ code: "INVALID_FINAL", retryable: false });
      expect(calls).toBe(2);
      expect(f.observations.filter(call => call.method === "tools/call" && call.params.name === "commerce_get_shipping_information")).toHaveLength(1);
    });
    it.each(["provider", "product", "variant", "failed"])("rejects %s mismatch in fresh shipping evidence", async mode => {
      configure();
      const fresh = structuredClone(shipping);
      if (mode === "provider") fresh.provider = "WOOCOMMERCE";
      if (mode === "product") Object.assign(fresh.product, { status: "AVAILABLE", productId: pair.productId, requiresShipping: true, virtual: false });
      if (mode === "variant") Object.assign(fresh.product, { status: "AVAILABLE", productId: pair.productId, variantId: pair.variantId, requiresShipping: true, virtual: false });
      f.toolResults = { ...f.toolResults, commerce_get_shipping_information: [ok(shipping), mode === "failed" ?
        { contractVersion: "commerce.v1", status: "ERROR", code: "UNAVAILABLE", retryable: true } : ok(fresh)] };
      let calls = 0;
      await expect(f.run(async () => ++calls === 1 ? { calls: [
        { name: "commerce_get_product", arguments: pair }, { name: "commerce_get_shipping_information", arguments: generic },
      ], outputTokens: 1 } : answer({ responseDisposition: "STANDARD", shippingInformationSelection: generic }))).rejects.toMatchObject({ code: mode === "failed" ? "UNAVAILABLE" : "INVALID_FINAL" });
      expect(calls).toBe(2);
    });
  });
}
