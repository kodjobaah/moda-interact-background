import { describe, expect, it } from "vitest";
import { CommerceProductSchema, type CommerceConversationProductContext } from "@modainteract/moda-interact-shared/commerce";
import { composeCommerceWhatsAppPreview } from "@modainteract/moda-interact-shared/commerce/presentation";
import { hostFixture as f } from "../host.fixture.js";

const pair = (n: number) => ({ productId: `gid://shopify/Product/${n}`, variantId: null });
const product = (n: number) => CommerceProductSchema.parse({ ...pair(n), title: `Shirt ${n}`, url: null, available: false,
  unitPrice: "99.00", currency: "GBP", productType: "Shirt", vendor: null, observedAt: new Date().toISOString(),
  options: { status: "AVAILABLE", items: [{ name: "Size", values: ["S", "M", "L"], usedForVariants: true }] },
  selectedOptions: [] });
const ok = (data: unknown) => ({ contractVersion: "commerce.v1", status: "OK", data, renderedText: "Fixture catalogue" });
const answer = (details: Record<string, unknown> = {}, replyText = "Verified product facts") => f.final({ answerKind: "ANSWER", referralReason: null, details, replyText });
const searchArgs = { query: "shirts", browse: false, availableOnly: false, limit: 3, cursor: null, categoryId: null };
function configure() {
  const base = structuredClone(f.active.capabilities[0]!);
  const schemas = [
    { name: "commerce_search_products", properties: { query: { type: ["string", "null"], maxLength: 200 }, browse: { type: "boolean" }, availableOnly: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 20 }, cursor: { type: ["string", "null"], maxLength: 2048 }, categoryId: { type: ["string", "null"], maxLength: 128 } } },
    { name: "commerce_get_product", properties: { productId: { type: "string", maxLength: 128 }, variantId: { type: ["string", "null"], maxLength: 128 } } },
  ];
  const capabilities = schemas.map((tool, position) => ({ ...structuredClone(base), capabilityId: `context-cap-${position}`, key: `context_${position}`, position,
    toolDescriptor: { ...structuredClone(base.toolDescriptor), toolId: `context-tool-${position}`, toolRevisionId: `context-rev-${position}`, name: tool.name, description: `Read ${tool.name}`, inputSchema: { type: "object", properties: tool.properties, required: Object.keys(tool.properties), additionalProperties: false } } }));
  f.active.capabilities = capabilities as any;
  f.active.selectedCapabilityKeys = capabilities.map(c => c.key);
  f.active.grantedTools = [...f.active.grantedTools.filter((t: any) => t.kind === "BUILT_IN"), ...capabilities.map(c => ({ toolId: c.toolDescriptor.toolId, toolRevisionId: c.toolDescriptor.toolRevisionId, toolName: c.toolDescriptor.name, definitionVersion: c.toolDescriptor.definitionVersion, capabilityKeys: [c.key] }))] as any;
  f.active.responseContract.detailsSchema = { type: "object", properties: {
    productOptionSelections: { type: "array", maxItems: 3, items: { type: "object", properties: { productId: { type: "string", maxLength: 128 }, variantId: { type: ["string", "null"], maxLength: 128 } }, required: ["productId", "variantId"], additionalProperties: false } },
  }, required: [], additionalProperties: false };
  const properties = f.active.responseContract.detailsSchema.properties as Record<string, unknown>;
  properties.productDetailSelections = properties.productOptionSelections;
  f.active.responseContractHash = f.digest(f.responseContractCanonicalJson(f.active.responseContract));
}
function turn(version: number, message: string, prior?: CommerceConversationProductContext) {
  f.state.inboundVersion = version; f.state.processingInboundVersion = version; f.state.processingStartedAt = new Date();
  const context = structuredClone(f.context); context.conversation.version = version; context.conversation.messages = [{ role: "user", content: message }];
  f.db.commerceConversationProductContext.findFirst.mockResolvedValue(prior ? { conversationId: prior.conversationId, shopId: prior.shopId, references: prior, schemaVersion: 1, revision: version - 1, sourceInboundVersion: version - 1, expiresAt: new Date(Date.now() + 86400000) } : null);
  return context;
}
export function registerProductContextAcceptanceTests() {
 describe("ARCH066 product-reference acceptance", () => {
  it("discovers three shirts, clarifies bare yes, then freshly verifies explicit sizes without guessing a variant", async () => {
   configure(); const products = [product(11), product(12), product(13)];
   f.toolResults = { commerce_search_products: ok({ products, cursor: null, truncated: false }), commerce_get_product: products.map(p => ok({ product: p })) };
   let step = 0;
   const discovered = await f.run(async () => ++step === 1 ? { calls: [{ name: "commerce_search_products", arguments: searchArgs }], outputTokens: 10 } : answer({ productOptionSelections: products.map(p => ({ productId: p.productId, variantId: null })) }), turn(1, "Show me three shirts"));
   expect(discovered.productContextUpdate?.references).toHaveLength(3);
   const prior = discovered.productContextUpdate!;
   const afterDiscovery = f.observations.length;
   const clarification = await f.run(async request => { expect(JSON.stringify(request.context)).toContain(products[1]!.productId); return answer({}, "Which of the three shirts would you like sizes for?"); }, turn(2, "yes", prior));
   expect(clarification.replyText).toContain("Which of the three shirts");
   expect(f.observations.slice(afterDiscovery).filter(o => o.method === "tools/call")).toHaveLength(0);
   f.toolResults.commerce_get_product = ok({ product: product(12) });
   const beforeSizes = f.observations.length;
   const sized = await f.run(async () => answer({ productOptionSelections: [pair(12)] }), turn(3, "Sizes for Shirt 12 please", prior));
   const reads = f.observations.slice(beforeSizes).filter(o => o.method === "tools/call");
   expect(reads.map(o => [o.params.name, o.params.arguments])).toEqual([["commerce_get_product", pair(12)]]);
   const composed = composeCommerceWhatsAppPreview({ envelope: sized.commercePresentation!.envelope, presentation: sized.commercePresentation!.verified });
   expect(composed).toMatchObject({ kind: "ready", body: "Shirt 12\nSize: S, M, L" });
   expect(JSON.stringify(sized.commercePresentation!.verified)).not.toContain("99.00");
  });
  it.each(["NOT_FOUND", "DENIED"])("handles deleted reference %s without weakening hard denial", async code => {
   configure(); const old = product(21), replacement = product(22);
   const prior: CommerceConversationProductContext = { schemaVersion: 1, shopId: f.context.shopId, conversationId: f.context.conversation.conversationId, platform: "SHOPIFY", updatedAt: new Date().toISOString(), references: [{ ...pair(21), title: old.title, observedAt: new Date().toISOString() }] };
   f.toolResults = { commerce_get_product: [{ contractVersion: "commerce.v1", status: "ERROR", code, retryable: false }, ok({ product: replacement })], commerce_search_products: ok({ products: [replacement], cursor: null, truncated: false }) };
   let step = 0;
   const result = await f.run(async () => { step++; if (step === 1) return { calls: [{ name: "commerce_get_product", arguments: pair(21) }], outputTokens: 10 }; if (step === 2 && code === "NOT_FOUND") return { calls: [{ name: "commerce_search_products", arguments: searchArgs }], outputTokens: 10 }; return code === "DENIED" ? f.final({ referralReason: "TOOL_REVOKED" }) : answer({ productOptionSelections: [pair(22)] }); }, turn(2, "What sizes does the old shirt have?", prior));
   const reads = f.observations.filter(o => o.method === "tools/call");
   if (code === "DENIED") { expect(result.answerKind).toBe("REFER_TO_STORE"); expect(result.productContextUpdate).toBeUndefined(); expect(reads.map(o => o.params.name)).toEqual(["commerce_get_product"]); }
   else { expect(result.answerKind).toBe("ANSWER"); expect(reads.map(o => o.params.name)).toEqual(["commerce_get_product", "commerce_search_products", "commerce_get_product"]); expect(result.commercePresentation!.verified.optionFacts[0]!.productId).toBe(replacement.productId); }
  });
  it.each(['first one', 'the green finish'])('uses remembered presentation/options for %s but refreshes exact stock in the current turn', async message => {
   configure();
   const now = new Date().toISOString();
   const products = [product(30), product(10), product(20)].map((p, index) => ({ ...p, selectedOptions: [{ name: 'Finish', value: index === 0 ? 'Green' : 'Natural' }], stock: { status: 'KNOWN' as const, quantity: 7, scope: 'VARIANT' as const } }));
   const prior: CommerceConversationProductContext = { schemaVersion: 1, shopId: f.context.shopId, conversationId: f.context.conversation.conversationId, platform: 'SHOPIFY', updatedAt: now,
    references: [...products].reverse().map(p => ({ productId: p.productId, variantId: p.variantId, title: p.title, observedAt: now, selectedOptions: p.selectedOptions })),
    presentation: { references: products.map(p => ({ productId: p.productId, variantId: p.variantId })), presentedAt: now } };
   f.toolResults = { commerce_get_product: ok({ product: { ...products[0], stock: { status: 'KNOWN', quantity: 2, scope: 'VARIANT' } } }) };
   const result = await f.run(async request => {
    const references = (request.context as any).productReferences;
    expect(references.presentation.references).toEqual(prior.presentation!.references);
    expect(references.references.find((ref: any) => ref.productId === pair(30).productId).selectedOptions).toEqual([{ name: 'Finish', value: 'Green' }]);
    expect(JSON.stringify(request.context)).not.toContain('"stock"');
    return answer({ productDetailSelections: [pair(30)] }, 'There are 7 in stock');
   }, turn(2, message, prior));
   const composed = composeCommerceWhatsAppPreview({ envelope: result.commercePresentation!.envelope, presentation: result.commercePresentation!.verified });
   expect(result.commercePresentation!.verified.productFacts![0]!.stock).toEqual({ status: 'KNOWN', quantity: 2, scope: 'VARIANT' });
   expect(composed.kind).toBe('ready');
   if (composed.kind === 'ready') { expect(composed.body).toContain('2'); expect(composed.body).not.toContain('7 in stock'); }
   expect(f.observations.filter(o => o.method === 'tools/call').map(o => [o.params.name, o.params.arguments])).toEqual([['commerce_get_product', pair(30)]]);
  });

 });
}
