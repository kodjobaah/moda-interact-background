import { createHash } from "node:crypto";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { exampleManifest, exampleGrant, exampleTurn, exampleFinal, responseContractCanonicalJson, commerceProductSelectionConflict } from "@modainteract/moda-interact-shared/commerce";
import { runCommerceTurn } from "@modainteract/moda-interact-shared/commerce/runner";
import { diagnosticFinalSchemaNormalForm } from "../../../src/commerce/diagnostics/final-schema-normal-form.js";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const pair = { productId: "gid://shopify/Product/1", variantId: null };
const identity = { type: "object" as const, properties: { productId: { type: ["string", "null"] as ("string" | "null")[], maxLength: 128 }, variantId: { type: ["string", "null"] as ("string" | "null")[], maxLength: 128 } }, required: ["productId", "variantId"], additionalProperties: false };
async function fixture(shipping: boolean) {
 const manifest = exampleManifest(digest, true), descriptor = manifest.capabilities[0]!.toolDescriptor;
 descriptor.name = "commerce_get_product"; manifest.grantedTools[0]!.toolName = descriptor.name;
 manifest.responseContract.detailsSchema = { type: "object", properties: {
  productDetailSelections: { type: "array", maxItems: 3, items: structuredClone(identity) }, productOptionSelections: { type: "array", maxItems: 3, items: structuredClone(identity) },
  productRecommendations: { type: "array", maxItems: 3, items: structuredClone(identity) }, productRecommendationVersion: { type: "string", maxLength: 1, enum: ["1"] },
  responseDisposition: { type: "string", maxLength: 64, enum: ["STANDARD", "OUT_OF_SCOPE_REDIRECT", "SHIPPING_INFORMATION_UNVERIFIED"] }, shippingInformationSelection: structuredClone(identity),
 }, required: [], additionalProperties: false };
 manifest.responseContractHash = digest(responseContractCanonicalJson(manifest.responseContract));
 if (shipping) { const member = structuredClone(manifest.capabilities[0]!); member.key = "shipping"; member.capabilityId = "shipping-cap"; member.position = 1; member.toolDescriptor = { ...member.toolDescriptor, name: "commerce_get_shipping_information", toolId: "shipping-tool", toolRevisionId: "shipping-rev" }; manifest.capabilities.push(member); manifest.selectedCapabilityKeys.push(member.key); manifest.grantedTools.push({ ...manifest.grantedTools[0]!, toolName: member.toolDescriptor.name, toolId: "shipping-tool", toolRevisionId: "shipping-rev", capabilityKeys: [member.key] }); }
 let calls = 0, schema: unknown;
 const product = { ...pair, title: "Fixture", url: null, unitPrice: "20.00", currency: "USD", available: true, productType: "Snowboard", vendor: "Fixture", categories: [], categoryIds: [], collectionIds: [], saleEvidence: null, observedAt: new Date().toISOString() };
 const ship = { provider: "SHOPIFY", observedAt: new Date().toISOString(), product: { status: "NOT_REQUESTED", productId: null, variantId: null, requiresShipping: null, virtual: null, weight: null, dimensions: null, shippingClassId: null, shippingClassSlug: null }, policy: { status: "SCOPE_NOT_GRANTED", trust: "UNTRUSTED_REFERENCE", title: null, bodyStatus: "NOT_AVAILABLE", bodyHtml: null, url: null, updatedAt: null } };
 const outcome = await runCommerceTurn({ turn: exampleTurn, manifest, grant: exampleGrant(manifest), platform: "SHOPIFY", context: {}, history: [], hostInstructions: [], language: { tag: "en", source: "shopify" }, signal: AbortSignal.timeout(3000), dependencies: { now: Date.now, digest,
  model: { invoke: async request => { if (++calls === 1) return { calls: manifest.capabilities.map(capability => ({ name: capability.toolDescriptor.name, arguments: { handle: "fixture" } })), outputTokens: 1 }; schema = request.tools.find(tool => tool.name === "finalResponse")!.inputSchema; return { calls: [{ name: "finalResponse", arguments: structuredClone(exampleFinal) }], outputTokens: 1 }; } },
  tools: manifest.capabilities.map(capability => ({ descriptor: capability.toolDescriptor, isAuthorized: async () => true, execute: async () => ({ contractVersion: "commerce.v1" as const, status: "OK" as const, data: capability.toolDescriptor.name === "commerce_get_product" ? { product } : ship, renderedText: "Fixture" }) })),
 } });
 if (!schema) throw new Error("FIXTURE_SCHEMA_NOT_CAPTURED:" + JSON.stringify(outcome));
 return { schema, contract: manifest.responseContract };
}
const answer = (details: Record<string, unknown>) => ({ ...structuredClone(exampleFinal), answerKind: "ANSWER", referralReason: null, replyText: "Fixture reply", details });
describe("known finalResponse diagnostic schema normal form", () => {
 it.each([false, true])("preserves exact baseline acceptance for product/referral/language/selection/shipping matrix (shipping=%s)", async shipping => {
  const { schema, contract } = await fixture(shipping), before = structuredClone(schema);
  const normalized = diagnosticFinalSchemaNormalForm(schema, contract); expect(normalized).not.toBeNull(); expect(schema).toEqual(before);
  const ajv = new Ajv({ allErrors: true, strict: false }); const original = ajv.compile(schema as object), changed = ajv.compile(normalized!);
  const details = [{}, { responseDisposition: "STANDARD" }, { productDetailSelections: [pair] }, { productDetailSelections: [] }, { productOptionSelections: [pair] }, { productOptionSelections: [] }, { productRecommendations: [pair], productRecommendationVersion: "1" }, { productRecommendations: [pair] }, { productRecommendationVersion: "1" }, { productRecommendations: [], productRecommendationVersion: "1" }, { productRecommendations: [pair], productRecommendationVersion: "2" }, { productDetailSelections: Array(4).fill(pair) }, { productDetailSelections: [{ ...pair, unexpected: true }] }, { productDetailSelections: [{ productId: 3, variantId: null }] }, { productDetailSelections: [pair], productOptionSelections: [pair] }, { shippingInformationSelection: { productId: null, variantId: null }, responseDisposition: "STANDARD" }, { responseDisposition: "SHIPPING_INFORMATION_UNVERIFIED" }, { shippingInformationSelection: pair, responseDisposition: "STANDARD" }, { responseDisposition: "UNKNOWN" }];
  const language = [{ detectedLanguageTag: null, detectedLanguageConfidence: null }, { detectedLanguageTag: "en", detectedLanguageConfidence: 0 }, { detectedLanguageTag: "en", detectedLanguageConfidence: 1 }, { detectedLanguageTag: null, detectedLanguageConfidence: 1 }, { detectedLanguageTag: "en", detectedLanguageConfidence: null }, { detectedLanguageTag: "en", detectedLanguageConfidence: -1 }, { detectedLanguageTag: "en", detectedLanguageConfidence: 1.1 }, { detectedLanguageTag: 3, detectedLanguageConfidence: 0.5 }];
  for (const value of details) for (const locale of language) { const candidate = { ...answer(value), ...locale }; expect(Boolean(changed(candidate)), JSON.stringify(candidate)).toBe(Boolean(original(candidate))); expect(commerceProductSelectionConflict(candidate.details)).toBe(commerceProductSelectionConflict(value)); }
  const reasons = (schema as { properties: { referralReason: { enum: unknown[] } } }).properties.referralReason.enum;
  for (const reason of reasons) for (const value of details) { const candidate = { ...structuredClone(exampleFinal), referralReason: reason, details: value }; expect(Boolean(changed(candidate))).toBe(Boolean(original(candidate))); }
  for (const candidate of [{ ...answer({ productDetailSelections: [pair] }), referralReason: "null" }, { ...answer({ productDetailSelections: [pair] }), unknownEnvelope: true }, { ...exampleFinal, evidenceIds: ["unexpected"] }, { ...exampleFinal, referralReason: "UNKNOWN" }]) expect(Boolean(changed(candidate))).toBe(Boolean(original(candidate)));
  expect(changed(answer({ productDetailSelections: [pair] }))).toBe(true); expect(changed(answer({}))).toBe(false); expect(changed(structuredClone(exampleFinal))).toBe(true);
  expect(changed(answer({ responseDisposition: "SHIPPING_INFORMATION_UNVERIFIED" }))).toBe(shipping);
 });
 it("refuses unsupported envelopes, extra conjunctions, leaf logic and contradictory bounds", async () => {
  const { schema, contract } = await fixture(false);
  expect(diagnosticFinalSchemaNormalForm({}, contract)).toBeNull();
  const extra = structuredClone(schema) as { allOf: unknown[] }; extra.allOf.push({ not: {} }); expect(diagnosticFinalSchemaNormalForm(extra, contract)).toBeNull();
  const altered = structuredClone(schema) as { required: string[] }; altered.required.pop(); expect(diagnosticFinalSchemaNormalForm(altered, contract)).toBeNull();
  const conflictContract = structuredClone(contract); conflictContract.detailsSchema.properties!.productDetailSelections!.maxItems = 0;
  expect(diagnosticFinalSchemaNormalForm(schema, conflictContract)).toBeNull();
 });
});
