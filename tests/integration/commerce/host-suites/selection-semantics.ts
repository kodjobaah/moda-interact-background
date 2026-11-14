import { describe, expect, it } from "vitest";
import { hostFixture as f } from "../host.fixture.js";
import { ConversationWrapperService } from "../../../../src/services/conversation-wrappers/service.js";
import { composeAiOutbound } from "../../../../src/services/conversation-wrappers/compose-ai-outbound.js";

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
function configureIdentity() {
  configure();
  const selection = { type: "array", maxItems: 3, items: { type: "object", properties: {
    productId: { type: "string", maxLength: 128 }, variantId: { type: ["string", "null"], maxLength: 128 },
  }, required: ["productId", "variantId"], additionalProperties: false } };
  Object.assign(f.active.responseContract.detailsSchema.properties!, { productDetailSelections: selection, productOptionSelections: structuredClone(selection) });
  f.active.responseContractHash = f.digest(f.responseContractCanonicalJson(f.active.responseContract));
}
const answer = (details: Record<string, unknown>) => f.final({ answerKind: "ANSWER", referralReason: null,
  replyText: "Our current catalogue has the blue linen shirt.", details });
const flatRecommendation = (selected: unknown[], replyText = "Our current catalogue has verified products.") => ({
  calls: [{ id: "flat-provider-final", name: "recovery_complete_recommendations", arguments: {
    replyText, detectedLanguageTag: null, detectedLanguageConfidence: null, evidenceIds: [],
    productRecommendationVersion: "1", productRecommendations: selected,
  } }], outputTokens: 1,
});
export function registerSelectionSemanticsTests() {
  describe("published runner to host selection semantics", () => {
    it.each(["missing", "duplicate"])("refuses raw native provider %s call IDs before any tool dispatch", async mode => {
      configure();
      const call = { name: "commerce_get_product", arguments: pair };
      await expect(f.run(async request => {
        expect(request.toolTranscript).toEqual([]);
        return { calls: mode === "missing" ? [call] : [{ ...call, id: "same" }, { ...call, id: "same" }], outputTokens: 1 };
      }, undefined, undefined, undefined, true)).rejects.toMatchObject({
        code: "INVALID_FINAL", diagnostic: { runnerDiagnostic: { reasonCode: "MODEL_TOOL_CALL_ID_INVALID" } },
      });
      expect(f.observations.filter(call => call.method === "tools/call")).toHaveLength(0);
    });
    it.each(["empty", "foreign", "multi", "nonproduct"])("rejects terminal %s completion without another model or read", async mode => {
      configure(); let calls = 0;
      const args = { selectedPairs: mode === "empty" ? [] : [{ ...pair, ...(mode === "foreign" ? { productId: "foreign-product" } : {}) }] };
      const raw = { calls: [{ id: "raw-terminal-1", name: mode === "nonproduct" ? "recovery_complete_answer" : "recovery_complete_details",
        arguments: mode === "nonproduct" ? { replyText: "Current product facts.", detectedLanguageTag: null, detectedLanguageConfidence: null, evidenceIds: [] } : args }], outputTokens: 1 };
      if (mode === "multi") raw.calls.push({ ...raw.calls[0]!, id: "raw-terminal-2" });
      const before = structuredClone(raw);
      await expect(f.run(async request => {
        calls++; if (calls > 3) throw new Error("Terminal invalid decision must not retry");
        if (calls === 1) return { calls: [{ id: "read-before-terminal", name: "commerce_get_product", arguments: pair }], outputTokens: 1 };
        if (calls === 2) return { calls: [], text: "Product facts without selections.", outputTokens: 1 };
        expect(request.requireToolCall).toBe(true); return raw;
      })).rejects.toMatchObject({ code: "INVALID_FINAL", retryable: false });
      expect(calls).toBe(3); expect(raw).toEqual(before);
      expect(f.observations.filter(call => call.method === "tools/call")).toHaveLength(1);
    });
    it("refuses stale current-turn state after flat completion before final reads or delivery", async () => {
      configure(); let calls = 0;
      await expect(f.run(async () => {
        calls++; if (calls === 1) return { calls: [{ name: "commerce_get_product", arguments: pair }], outputTokens: 1 };
        if (calls === 2) return { calls: [], text: "Product facts.", outputTokens: 1 };
        f.state.inboundVersion = 2;
        return flatRecommendation([recommendation]);
      })).rejects.toMatchObject({ code: "STALE_TURN" });
      expect(calls).toBe(3); expect(f.observations.filter(call => call.method === "tools/call")).toHaveLength(1);
    });
    it("replaces only a bound identity decision with independently refreshed product facts and price", async () => {
      configureIdentity(); let calls = 0;
      const initial = { ...product, title: "Initial title", unitPrice: "24.00", stock: { status: "KNOWN", scope: "VARIANT", quantity: 10 } };
      const fresh = { ...initial, title: "Refreshed title", unitPrice: "29.00", stock: { status: "KNOWN", scope: "VARIANT", quantity: 7 } };
      f.toolResults = { commerce_get_product: [ok({ product: initial }), ok({ product: fresh })] };
      const raw = { calls: [{ id: "identity-final", name: "recovery_complete_details", arguments: { selectedPairs: [pair] } }], outputTokens: 1 };
      const before = structuredClone(raw);
      const result = await f.run(async request => {
        calls++; if (calls === 1) return { calls: [{ name: "commerce_get_product", arguments: pair }], outputTokens: 1 };
        if (calls === 2) return { calls: [], text: "Initial model prose", outputTokens: 1 };
        expect(request.requireToolCall).toBe(true); expect(request.instructions.join("\n")).toContain("supply only its schema fields");
        return raw;
      });
      expect(result.replyText).toContain("Refreshed title"); expect(result.replyText).toContain("29.00");
      expect(result.replyText).not.toMatch(/Initial title|24\.00|Initial model prose/);
      expect(raw).toEqual(before); expect(calls).toBe(3);
      expect(f.observations.filter(call => call.method === "tools/call")).toHaveLength(2);
    });
    it("never returns the initial identity title body when independent refresh fails", async () => {
      configureIdentity(); let calls = 0;
      f.toolResults = { commerce_get_product: [ok({ product }), ok({ product: null })] };
      const raw = { calls: [{ id: "identity-no-refresh", name: "recovery_complete_details", arguments: { selectedPairs: [pair] } }], outputTokens: 1 };
      const before = structuredClone(raw);
      await expect(f.run(async () => {
        calls++; if (calls === 1) return { calls: [{ name: "commerce_get_product", arguments: pair }], outputTokens: 1 };
        if (calls === 2) return { calls: [], text: "Initial model prose", outputTokens: 1 };
        return raw;
      })).rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND" });
      expect(calls).toBe(3); expect(raw).toEqual(before);
      expect(f.observations.filter(call => call.method === "tools/call")).toHaveLength(2);
    });
    it.each([false, true])("refreshes every unioned atomic identity before any body can return (missing second=%s)", async missing => {
      configureIdentity(); let calls = 0;
      const second = { productId: "gid://shopify/Product/202", variantId: null };
      const other = { ...product, ...second, title: "Second initial title" };
      f.toolResults = { commerce_get_product: [ok({ product }), ok({ product: other }),
        ok({ product: { ...product, title: "First refreshed", unitPrice: "28.00" } }),
        ok({ product: missing ? null : { ...other, title: "Second refreshed", unitPrice: "39.00" } })] };
      const raw = { text: "Untrusted historical price prose", calls: [
        { id: "atomic-first", name: "recovery_complete_details", arguments: { selectedPairs: [pair] } },
        { id: "atomic-second", name: "recovery_complete_details", arguments: { selectedPairs: [second, pair] } },
      ], outputTokens: 1 }; const before = structuredClone(raw);
      const run = f.run(async () => {
        calls++; if (calls === 1) return { calls: [pair, second].map(arguments_ => ({ name: "commerce_get_product", arguments: arguments_ })), outputTokens: 1 };
        if (calls === 2) return { calls: [], text: "Product facts", outputTokens: 1 };
        return raw;
      });
      if (missing) await expect(run).rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND" });
      else { const result = await run; expect(result.replyText).toContain("First refreshed"); expect(result.replyText).toContain("Second refreshed");
        expect(result.replyText).toContain("28.00"); expect(result.replyText).toContain("39.00"); expect(result.replyText).not.toContain("historical price");
        expect(result.commercePresentation!.envelope.details.productDetailSelections).toEqual([pair, second]); }
      expect(raw).toEqual(before); expect(calls).toBe(3);
      expect(f.observations.filter(call => call.method === "tools/call")).toHaveLength(4);
    });
    it("does not replace an ordinary model answer that has no bound identity completion", async () => {
      configureIdentity(); let calls = 0;
      const result = await f.run(async () => ++calls === 1 ? { calls: [{ name: "commerce_get_product", arguments: pair }], outputTokens: 1 } :
        { ...answer({ productDetailSelections: [pair] }), calls: [{ ...answer({ productDetailSelections: [pair] }).calls[0]!, arguments: { ...answer({ productDetailSelections: [pair] }).calls[0]!.arguments, replyText: "Ordinary verified model reply." } }] });
      expect(result.replyText).toBe("Ordinary verified model reply."); expect(calls).toBe(2);
    });
    it("retains explicit language detection through the rich factual completion branch", async () => {
      configureIdentity(); f.state.languageTag = "en"; f.state.languageSource = "DETECTED";
      const context = structuredClone(f.context); context.conversation.messages = [{ role: "user", content: "¿Qué opciones tiene este producto? Por favor, responde en español." }];
      let calls = 0;
      const result = await f.run(async request => {
        calls++; if (calls === 1) return { calls: [{ name: "commerce_get_product", arguments: pair }], outputTokens: 1 };
        if (calls === 2) return { calls: [], text: "Tenemos este producto.", outputTokens: 1 };
        expect(request.instructions.join("\n")).toContain("new language detection");
        return { calls: [{ id: "rich-language-final", name: "recovery_complete_details_with_context", arguments: {
          replyText: "Aquí están los detalles del producto.", detectedLanguageTag: "es", detectedLanguageConfidence: 0.99, evidenceIds: [], productDetailSelections: [pair],
        } }], outputTokens: 1 };
      }, context);
      expect(result.detectedLanguageTag).toBe("es"); expect(result.replyText).toBe("Aquí están los detalles del producto.");
      expect(result.commercePresentation!.verified.locale).toBe("es");
    });
    it("guides catalogue facts to exact detail selections on the ordinary final call without granting promotions", async () => {
      configure();
      f.active.responseContract.detailsSchema.properties!.productDetailSelections = { type: "array", maxItems: 3, items: { type: "object", properties: {
        productId: { type: "string", maxLength: 128 }, variantId: { type: ["string", "null"], maxLength: 128 },
      }, required: ["productId", "variantId"], additionalProperties: false } };
      f.active.responseContractHash = f.digest(f.responseContractCanonicalJson(f.active.responseContract));
      const final = answer({ productDetailSelections: [pair] }); const original = structuredClone(final);
      let calls = 0;
      await f.run(async request => {
        calls++;
        if (calls === 1) expect(request.toolTranscript).toEqual([]);
        else expect(request.toolTranscript).toEqual([
          expect.objectContaining({ role: "assistant" }), expect.objectContaining({ role: "tool" }),
        ]);
        expect(request.instructions.join("\n")).toContain("Category, catalogue and availability questions");
        expect(request.instructions.join("\n")).toContain("Do not create productRecommendations merely to enumerate");
        if (calls === 1) return { calls: [{ id: "read-category-facts", name: "commerce_get_product", arguments: pair }], outputTokens: 20 };
        expect(request.requiredToolName).toBeUndefined();
        return final;
      });
      expect(calls).toBe(2);
      // One model-requested read plus the existing independent final product verification.
      expect(f.observations.filter(call => call.method === "tools/call")).toHaveLength(2); expect(final).toEqual(original);
    });
    it("forwards nested product selection constraints, strict and ordinary/forced choice through the actual SDK HTTP serializer", async () => {
      configure();
      f.active.responseContract.detailsSchema.properties!.productDetailSelections = { type: "array", maxItems: 3, items: { type: "object", properties: {
        productId: { type: "string", maxLength: 128 }, variantId: { type: ["string", "null"], maxLength: 128 },
      }, required: ["productId", "variantId"], additionalProperties: false } };
      f.active.responseContractHash = f.digest(f.responseContractCanonicalJson(f.active.responseContract));
      const mock = new f.LLMock({ port: 0 }); await mock.start();
      try {
        const url = new URL(mock.url); expect(["localhost", "127.0.0.1", "[::1]"]).toContain(url.hostname);
        f.aiMockRoute.baseURL = `${url.origin}/v1`; f.aiMockRoute.constructions.length = 0;
        const hasResult = (messages: readonly { content: unknown }[]) => messages.some(message => typeof message.content === "string" && message.content.includes("Trusted commerce Tool result JSON"));
        mock.on({ model: "moda/test-only", predicate: request => !hasResult(request.messages) }, { toolCalls: [{ name: "commerce_get_product", arguments: pair }] });
        const empty = answer({}).calls[0]!.arguments;
        const isTerminal = (request: { tools?: Array<{ function?: { name?: string } }> }) => request.tools?.some(tool => tool.function?.name === "recovery_complete_details") === true;
        mock.on({ model: "moda/test-only", predicate: request => hasResult(request.messages) && !isTerminal(request) }, { toolCalls: [{ name: "finalResponse", arguments: empty }] });
        const flat = { selectedPairs: [pair] };
        mock.on({ model: "moda/test-only", predicate: request => isTerminal(request) }, { toolCalls: [{ name: "recovery_complete_details", arguments: flat }] });
        const model = new f.OpenRouterModelClient({ provider: "moda", providerModelId: "test-only", configurationSchemaVersion: 1, configuration: {}, credential: "test-only-no-provider-key" });
        expect(f.aiMockRoute.constructions).toEqual([{ model: "moda/test-only", baseURL: `${url.origin}/v1` }]);
        const inputs: import("@modainteract/moda-interact-shared/commerce/runner").ModelRequest[] = [];
        const steps: import("@modainteract/moda-interact-shared/commerce/runner").ModelStep[] = [];
        const result = await f.run(async (request, signal) => { inputs.push(request); const step = await model.invoke(request, signal); steps.push(step); return step; });
        expect(result.commercePresentation!.envelope.details).toMatchObject({ productDetailSelections: [pair] });
        expect(result.commercePresentation!.verified.productFacts).toHaveLength(1);
        const requests = mock.getRequests().filter(request => request.method === "POST" && request.path.endsWith("/chat/completions"));
        expect(requests).toHaveLength(3);
        for (let index = 0; index < requests.length; index++) {
          const body = requests[index]!.body as { tools: { function: { name: string; description: string; parameters: Record<string, unknown>; strict: boolean } }[]; tool_choice: unknown; max_tokens: number };
          const name = index === 2 ? "recovery_complete_details" : "finalResponse";
          const final = body.tools.find(tool => tool.function.name === name)!.function;
          const expected = inputs[index]!.tools.find(tool => tool.name === name)!;
          expect(final.parameters).toEqual(expected.inputSchema); expect(final.description).toBe(expected.description); expect(final.strict).toBe(true);
          expect(body.max_tokens).toBe(inputs[index]!.maxOutputTokens);
          expect(body.tool_choice).toEqual(index === 2 ? "required" : "auto");
          if (index === 2) {
            expect(final.parameters).not.toHaveProperty("allOf");
            expect(final.parameters).toMatchObject({ type: "object", properties: { selectedPairs: { type: "array", minItems: 1 } } });
          }
          if (index === 1) {
            const allOf = final.parameters.allOf as { anyOf?: { properties?: { details?: { anyOf: unknown[] } } }[] }[];
            const constraint = allOf.at(-1)!.anyOf!.find(branch => branch.properties?.details)!.properties!.details!;
            expect(constraint.anyOf).toContainEqual({ required: ["productDetailSelections"], properties: { productDetailSelections: { type: "array", minItems: 1 } } });
          }
        }
        expect(steps.slice(1).map(step => step.calls[0]!.arguments)).toEqual([empty, flat]);
        expect(steps[2]!.calls[0]!.name).toBe("recovery_complete_details");
        expect(steps[2]!.calls[0]!.id).toBeTruthy();
        expect(f.observations.filter(call => call.method === "tools/call")).toHaveLength(2);
      } finally { f.aiMockRoute.baseURL = null; f.aiMockRoute.constructions.length = 0; await mock.stop(); }
    });
    it("forces one typed JSON-null correction then verifies two products and the trusted recovery footer", async () => {
      configure();
      const otherPair = { productId: "gid://shopify/Product/102", variantId: "gid://shopify/ProductVariant/102" };
      const otherProduct = { ...product, ...otherPair, title: "Green linen shirt", url: null };
      f.toolResults = { ...f.toolResults, commerce_get_product: [ok({ product }), ok({ product: otherProduct }), ok({ product }), ok({ product: otherProduct })] };
      let calls = 0;
      const result = await f.run(async request => {
        calls++;
        if (calls === 1) return { calls: [{ name: "commerce_get_product", arguments: pair }, { name: "commerce_get_product", arguments: otherPair }], outputTokens: 1 };
        if (calls === 2) return { calls: [], text: "We offer blue and green linen shirts.", outputTokens: 1 };
        expect(calls).toBe(3); expect(request.requiredToolName).toBeUndefined(); expect(request.requireToolCall).toBe(true);
        expect(request.tools.map(tool => tool.name)).toContain("recovery_complete_recommendations"); expect(request.tools.map(tool => tool.name)).not.toContain("recovery_complete_answer");
        return flatRecommendation([recommendation, { ...recommendation, ...otherPair }], "We offer Blue linen shirt and Green linen shirt.");
      });
      expect(calls).toBe(3); expect(result.referralReason).toBeNull();
      expect(result.commercePresentation!.verified.products).toHaveLength(2);
      expect(f.observations.filter(call => call.method === "tools/call")).toHaveLength(4);
      const checkoutUrl = "https://fixture.myshopify.com/checkouts/recover?key=synthetic";
      const wrapper = new ConversationWrapperService({ repository: {
        loadContext: async () => ({ conversationId: f.state.id, shopId: "shop-fixture", conversationLanguageTag: "en", merchantLanguageTag: "en",
          variables: { "checkout.url": checkoutUrl }, checkoutAvailable: true }), loadSlots: async () => [],
      }, logger: f.createLogger({ serviceName: "moda-messaging-worker", environment: f.environment, sink: () => {} }), onMissingSlot: "passthrough" });
      const composed = await composeAiOutbound(wrapper, { conversationId: f.state.id, messageId: "synthetic-message",
        generatedResponse: result.replyText!, commercePresentation: result.commercePresentation! });
      expect(composed.kind).toBe("ready");
      if (composed.kind !== "ready") throw new Error("Expected verified eligible recovery composition");
      expect(composed.text).toContain("Blue linen shirt"); expect(composed.text).toContain("Green linen shirt");
      expect(composed.text.endsWith(checkoutUrl)).toBe(true); expect(composed.text.split(checkoutUrl)).toHaveLength(2);
    });
    it.each(["literal-null", "missing", "answer-with-referral"])("fails closed on %s after exactly one correction", async reason => {
      configure(); let calls = 0;
      await expect(f.run(async request => {
        calls++;
        if (calls === 1) return { calls: [{ name: "commerce_get_product", arguments: pair }], outputTokens: 1 };
        if (calls === 2) return { calls: [], text: "We offer a linen shirt.", outputTokens: 1 };
        expect(calls).toBe(3); expect(request.requiredToolName).toBeUndefined(); expect(request.requireToolCall).toBe(true);
        const correction = answer({ productRecommendationVersion: "1", productRecommendations: [recommendation] });
        if (reason === "missing") delete correction.calls[0]!.arguments.referralReason;
        else correction.calls[0]!.arguments.referralReason = reason === "literal-null" ? "null" : "UNVERIFIABLE_FACTS";
        return correction;
      })).rejects.toMatchObject({ code: "INVALID_FINAL", retryable: false });
      expect(calls).toBe(3); expect(f.observations.filter(call => call.method === "tools/call")).toHaveLength(1);
    });
    it("observes an omitted final selection before the unchanged terminal refusal", async () => {
      configure(); let calls = 0;
      const records: Array<Record<string, unknown>> = [];
      const logger = f.createLogger({ serviceName: "moda-messaging-worker", environment: f.environment,
        sink: record => records.push(record as unknown as Record<string, unknown>) });
      const finalStep = answer({}); const originalCall = finalStep.calls[0]!;
      const originalArguments = originalCall.arguments; const snapshot = structuredClone(finalStep);
      await expect(f.run(async () => {
        calls++;
        if (calls === 1) return { calls: [{ name: "commerce_get_product", arguments: pair }], outputTokens: 1 };
        if (calls === 2) return { calls: [], text: "PRIVATE_PROSE_SENTINEL", outputTokens: 1 };
        return finalStep;
      }, f.context, undefined, logger)).rejects.toMatchObject({ code: "INVALID_FINAL", retryable: false,
        diagnostic: { runnerDiagnostic: { reasonCode: "TERMINAL_DECISION_INVALID" } } });
      expect(calls).toBe(3);
      expect(finalStep).toEqual(snapshot); expect(finalStep.calls[0]).toBe(originalCall);
      expect(originalCall.arguments).toBe(originalArguments);
      const shapes = records.filter(record => record.event === "commerce.host.model_bridge.final_selection_shape");
      expect(shapes).toHaveLength(3);
      expect(shapes[1]!.data).toMatchObject({ exactOneFinalResponse: false, forcedFinalResponse: false });
      expect(shapes[2]!.data).toMatchObject({ exactOneFinalResponse: true, forcedFinalResponse: true,
        detailsContainer: "OBJECT", detailArray: "ABSENT", recommendationArray: "ABSENT",
        responseContractHash: f.active.responseContractHash });
      const shapeIndex = records.indexOf(shapes[2]!);
      expect(records.slice(shapeIndex + 1).some(record => record.event === "commerce.turn.failed")).toBe(true);
      expect(JSON.stringify(shapes)).not.toContain("PRIVATE_PROSE_SENTINEL");
      expect(JSON.stringify(shapes)).not.toContain(pair.productId);
    });
    it("preserves a valid typed referral through the actual host", async () => {
      configure();
      const result = await f.run(async () => f.final({ answerKind: "REFER_TO_STORE", referralReason: "UNVERIFIABLE_FACTS", details: {} }));
      expect(result).toMatchObject({ answerKind: "REFER_TO_STORE", referralReason: "UNVERIFIABLE_FACTS" });
      expect(f.observations.filter(call => call.method === "tools/call")).toHaveLength(0);
    });
    it("preserves mandatory referral when a model attempts a JSON-null ANSWER", async () => {
      configure(); let calls = 0;
      f.toolResults = { commerce_get_product: { contractVersion: "commerce.v1", status: "ERROR", code: "DENIED", retryable: false } };
      await expect(f.run(async () => ++calls === 1 ? { calls: [{ name: "commerce_get_product", arguments: pair }], outputTokens: 1 } :
        answer({ productRecommendationVersion: "1", productRecommendations: [recommendation] }))).rejects.toMatchObject({ code: "INVALID_FINAL", retryable: false });
      expect(calls).toBe(2);
      expect(f.observations.filter(call => call.method === "tools/call")).toHaveLength(1);
    });

    it("accepts a correctly typed mandatory referral after a denied current-shop read", async () => {
      configure(); let calls = 0;
      f.toolResults = { commerce_get_product: { contractVersion: "commerce.v1", status: "ERROR", code: "DENIED", retryable: false } };
      const result = await f.run(async () => ++calls === 1 ? { calls: [{ name: "commerce_get_product", arguments: pair }], outputTokens: 1 } :
        f.final({ answerKind: "REFER_TO_STORE", referralReason: "TOOL_REVOKED", details: {} }));
      expect(result).toMatchObject({ answerKind: "REFER_TO_STORE", referralReason: "TOOL_REVOKED" });
      expect(calls).toBe(2); expect(f.observations.filter(call => call.method === "tools/call")).toHaveLength(1);
    });
    it.each(["missing version", "unobserved shipping", "unobserved shipping disposition"])("corrects %s once using observed product IDs", async mode => {
      configure(); let calls = 0;
      const result = await f.run(async request => {
        calls++;
        if (calls === 1) return { calls: [{ name: "commerce_get_product", arguments: pair }], outputTokens: 1 };
        if (calls === 2) return answer(mode === "missing version" ? { responseDisposition: "STANDARD", productRecommendations: [recommendation] } :
          mode === "unobserved shipping" ? { shippingInformationSelection: generic } : { responseDisposition: "SHIPPING_INFORMATION_UNVERIFIED" });
        expect(calls).toBe(3); expect(request.requiredToolName).toBeUndefined(); expect(request.requireToolCall).toBe(true);
        expect(request.tools.map(tool => tool.name)).toContain("recovery_complete_recommendations"); expect(request.tools.map(tool => tool.name)).not.toContain("recovery_complete_answer");
        return flatRecommendation([recommendation]);
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
      const records: Array<Record<string, unknown>> = [];
      const logger = f.createLogger({ serviceName: "moda-messaging-worker", environment: f.environment,
        sink: record => records.push(record as unknown as Record<string, unknown>) });
      await expect(f.run(async () => ++calls === 1 ? { calls: [{ name: "commerce_get_product", arguments: pair }], outputTokens: 1 } :
        answer({ responseDisposition: "STANDARD", productRecommendations: [recommendation] }), f.context, undefined, logger)).rejects.toMatchObject({ code: "INVALID_FINAL", retryable: false });
      expect(calls).toBe(3); expect(f.observations.filter(call => call.method === "tools/call")).toHaveLength(1);
      const shapes = records.filter(record => record.event === "commerce.host.model_bridge.final_selection_shape");
      expect(shapes).toHaveLength(3);
      expect(shapes[2]!.data).toMatchObject({ exactOneFinalResponse: true, forcedFinalResponse: true,
        recommendationVersion: "ABSENT", recommendationArray: "ARRAY", recommendationCount: 1 });
      expect(JSON.stringify(shapes)).not.toContain(pair.productId);
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
