import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { exampleManifest, exampleFinal, responseContractCanonicalJson, hasCommerceAcceptedProductSelection, type SubsetSchema, type CommerceResponseContract } from "@modainteract/moda-interact-shared/commerce";
import type { TerminalDecisionInput } from "@modainteract/moda-interact-shared/commerce/runner";
import { makeRecoveryTerminalFinalizer } from "../../../src/commerce/recovery-terminal-finalizer.js";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const pair = { productId: "product-1", variantId: null };
const observedProduct = { ...pair, title: "Blue shirt", url: null, available: true, unitPrice: "24.00", currency: "GBP", productType: "Shirt", vendor: "Fixture",
  categories: [], categoryIds: [], collectionIds: [], saleEvidence: null, observedAt: "2026-11-05T12:00:00Z" };
const toolResult = (tool: string, data: unknown) => ({ tool, result: { contractVersion: "commerce.v1", status: "OK", data } });
const shippingData = (generic: boolean) => ({ provider: "SHOPIFY", observedAt: "2026-11-05T12:00:00Z",
  product: { status: generic ? "NOT_REQUESTED" : "AVAILABLE", productId: generic ? null : pair.productId, variantId: null,
    requiresShipping: null, virtual: null, weight: null, dimensions: null, shippingClassId: null, shippingClassSlug: null },
  policy: { status: "SCOPE_NOT_GRANTED", trust: "UNTRUSTED_REFERENCE", title: null, bodyStatus: "NOT_AVAILABLE", bodyHtml: null, url: null, updatedAt: null } });
const observations = [toolResult("commerce_get_product", { product: observedProduct }), toolResult("commerce_get_shipping_information", shippingData(false)), toolResult("commerce_get_shipping_information", shippingData(true))];
const identity: SubsetSchema = { type: "array", maxItems: 3, items: { type: "object", properties: {
  productId: { type: "string", maxLength: 128 }, variantId: { type: ["string", "null"], maxLength: 128 },
}, required: ["productId", "variantId"], additionalProperties: false } };
function setup(hasEligibleEvidence?: (ids: readonly string[]) => boolean) {
  const contract = exampleManifest(digest, true).responseContract;
  contract.detailsSchema = { type: "object", properties: {
    productDetailSelections: structuredClone(identity), productOptionSelections: structuredClone(identity),
    productRecommendationVersion: { type: "string", enum: ["1"], maxLength: 1 }, productRecommendations: structuredClone(identity),
    shippingInformationSelection: structuredClone(identity.items!),
    responseDisposition: { type: "string", enum: ["STANDARD", "OUT_OF_SCOPE_REDIRECT", "SHIPPING_INFORMATION_UNVERIFIED"], maxLength: 64 },
  }, required: [], additionalProperties: false };
  const responseContractHash = digest(responseContractCanonicalJson(contract));
  const port = makeRecoveryTerminalFinalizer({ responseContract: contract, responseContractHash, digest, platform: "SHOPIFY", locale: "en", ...(hasEligibleEvidence ? { hasEligibleEvidence } : {}) })!;
  const common = { replyText: exampleFinal.replyText, detectedLanguageTag: null, detectedLanguageConfidence: null, evidenceIds: [] };
  const project = (name: string, args: Record<string, unknown>, requiredReferral: unknown = null, currentObservations: unknown[] = observations) => {
    const call = { id: "actual-provider-id", name, arguments: args };
    const input = { binding: { callId: call.id }, call, transportStep: { calls: [call], outputTokens: 1 },
      observations: currentObservations, requiredReferral } as unknown as TerminalDecisionInput;
    const before = structuredClone(input); const output = port.project(input);
    expect(input).toEqual(before); expect(output.binding).toBe(input.binding);
    return output;
  };
  return { contract, port, common, project };
}
describe("application flat terminal finalization", () => {
  it.each([ ["recovery_complete_details_with_context", "productDetailSelections"], ["recovery_complete_options_with_context", "productOptionSelections"],
    ["recovery_complete_recommendations", "productRecommendations"] ])("maps only model-issued %s selections", (name, field) => {
    const { project, common } = setup();
    const args = { ...common, [field]: [pair], ...(field === "productRecommendations" ? { productRecommendationVersion: "1" } : {}) };
    expect(project(name!, args)).toMatchObject({ kind: "decision", value: { answerKind: "ANSWER", details: {
      [field!]: [pair], ...(field === "productRecommendations" ? { productRecommendationVersion: "1" } : {}) } } });
  });
  it("retains nonproduct, redirect and both shipping limitation forms separately", () => {
    const { project, common } = setup();
    expect(project("recovery_complete_answer", common)).toMatchObject({ kind: "decision", value: { details: {} } });
    expect(project("recovery_complete_redirect", common)).toMatchObject({ kind: "decision", value: { details: { responseDisposition: "OUT_OF_SCOPE_REDIRECT" } } });
    expect(project("recovery_complete_shipping", { ...common, shippingInformationSelection: pair, responseDisposition: "STANDARD" })).toMatchObject({ kind: "decision", value: { details: { shippingInformationSelection: pair } } });
    expect(project("recovery_complete_shipping_unverified", common)).toMatchObject({ kind: "decision", value: { details: { responseDisposition: "SHIPPING_INFORMATION_UNVERIFIED" } } });
    expect(project("recovery_complete_shipping_unverified_selection", { ...common, shippingInformationSelection: pair })).toMatchObject({ kind: "decision", value: { details: { shippingInformationSelection: pair, responseDisposition: "SHIPPING_INFORMATION_UNVERIFIED" } } });
  });
  it("preserves exact mandatory referral and cannot project an answer over it", () => {
    const { project, common } = setup(); const { evidenceIds: _, ...withoutEvidence } = common;
    expect(project("recovery_complete_referral", { ...withoutEvidence, referralReason: "UNVERIFIABLE_FACTS" }, "UNVERIFIABLE_FACTS")).toMatchObject({ kind: "decision", value: { answerKind: "REFER_TO_STORE", referralReason: "UNVERIFIABLE_FACTS", evidenceIds: [], details: {} } });
    expect(project("recovery_complete_answer", common, "UNVERIFIABLE_FACTS").kind).toBe("invalid");
    expect(project("recovery_complete_referral", { ...withoutEvidence, referralReason: "UNKNOWN" }).kind).toBe("invalid");
  });
  it.each([[], [pair, pair], [{ productId: 3, variantId: null }], [pair, pair, pair, pair]])("refuses invalid selected identity arrays", selections => {
    const { project, common } = setup(); expect(project("recovery_complete_details_with_context", { ...common, productDetailSelections: selections }).kind).toBe("invalid");
  });
  it("refuses extra fields, missing fields, invalid language pair and recommendation version", () => {
    const { project, common } = setup();
    expect(project("recovery_complete_answer", { ...common, productId: "not-selected" }).kind).toBe("invalid");
    expect(project("recovery_complete_answer", { replyText: "missing language/evidence" }).kind).toBe("invalid");
    expect(project("recovery_complete_answer", { ...common, detectedLanguageTag: "en", detectedLanguageConfidence: null }).kind).toBe("invalid");
    expect(project("recovery_complete_recommendations", { ...common, productRecommendationVersion: "2", productRecommendations: [pair] }).kind).toBe("invalid");
  });
  it("preserves explicitly selected shipping adjuncts on each sole product family", () => {
    const { project, common } = setup();
    for (const [name, field] of [["recovery_complete_details_with_context", "productDetailSelections"], ["recovery_complete_options_with_context", "productOptionSelections"], ["recovery_complete_recommendations", "productRecommendations"]]) {
      expect(project(name!, { ...common, [field!]: [pair], ...(field === "productRecommendations" ? { productRecommendationVersion: "1" } : {}),
        shippingInformationSelection: pair, responseDisposition: "SHIPPING_INFORMATION_UNVERIFIED" })).toMatchObject({ kind: "decision", value: { details: {
        [field!]: [pair], shippingInformationSelection: pair, responseDisposition: "SHIPPING_INFORMATION_UNVERIFIED" } } });
    }
  });
  it("advertises only grounded product modes after current products, and only referral when mandatory", () => {
    const { port } = setup();
    const select = (observations: unknown[], requiredReferral: unknown = null) => port.selectTools!({ turn: {}, modelStep: 3, responseContractHash: port.responseContractHash,
      observations, requiredReferral } as never);
    expect(select([])).toEqual(expect.arrayContaining(["recovery_complete_answer", "recovery_complete_referral"]));
    expect(select([])).not.toContain("recovery_complete_details_with_context");
    const product = { ...pair, title: "Blue shirt", url: null, available: true, unitPrice: "24.00", currency: "GBP", productType: "Shirt", vendor: "Fixture",
      categories: [], categoryIds: [], collectionIds: [], saleEvidence: null, observedAt: "2026-11-05T12:00:00Z" };
    const observations = [{ tool: "commerce_get_product", result: { contractVersion: "commerce.v1", status: "OK", data: { product } } }];
    expect(select(observations)).toContain("recovery_complete_details_with_context");
    expect(select(observations)).not.toContain("recovery_complete_answer");
    expect(select(observations)).not.toContain("recovery_complete_redirect");
    expect(select(observations)).not.toContain("recovery_complete_shipping");
    expect(select(observations, "UNVERIFIABLE_FACTS")).toEqual(["recovery_complete_referral"]);
  });
  it("refuses unobserved or foreign product/shipping identities without filling them", () => {
    const { project, common } = setup();
    expect(project("recovery_complete_details_with_context", { ...common, productDetailSelections: [pair] }, null, []).kind).toBe("invalid");
    expect(project("recovery_complete_details_with_context", { ...common, productDetailSelections: [{ ...pair, productId: "foreign" }] }).kind).toBe("invalid");
    expect(project("recovery_complete_shipping", { ...common, shippingInformationSelection: pair, responseDisposition: "STANDARD" }, null, []).kind).toBe("invalid");
    expect(project("recovery_complete_shipping_unverified", common, null, []).kind).toBe("invalid");
    const foreign = [toolResult("commerce_get_shipping_information", { ...shippingData(false), provider: "WOOCOMMERCE" })];
    expect(project("recovery_complete_shipping", { ...common, shippingInformationSelection: pair, responseDisposition: "STANDARD" }, null, foreign).kind).toBe("invalid");
  });
  it.each(["STANDARD", "OUT_OF_SCOPE_REDIRECT", "SHIPPING_INFORMATION_UNVERIFIED"])("retains canonical shipping-only %s with current proof", responseDisposition => {
    const { project, common, contract } = setup();
    const result = project("recovery_complete_shipping", { ...common, shippingInformationSelection: pair, responseDisposition });
    expect(result.kind).toBe("decision");
    if (result.kind !== "decision") throw new Error("Expected canonical shipping decision");
    const value = result.value as { details: Record<string, unknown> };
    expect(value.details).toEqual({ shippingInformationSelection: pair, responseDisposition });
    expect(hasCommerceAcceptedProductSelection(value.details, contract, observations, "SHOPIFY")).toBe(true);
  });
  it.each(["custom disposition", "custom recommendation version"])("retains original canonical path for unsupported %s", mode => {
    const { contract } = setup();
    if (mode === "custom disposition") contract.detailsSchema.properties!.responseDisposition!.enum!.push("CUSTOM");
    else contract.detailsSchema.properties!.productRecommendationVersion!.enum = ["2"];
    expect(makeRecoveryTerminalFinalizer({ responseContract: contract, responseContractHash: digest(responseContractCanonicalJson(contract)), digest, platform: "SHOPIFY", locale: "en" })).toBeNull();
  });
  it("advertises only non-null canonical referral reasons", () => {
    const { port, project, common } = setup(); const descriptor = port.terminalTools.find(tool => tool.name === "recovery_complete_referral")!;
    const reason = (descriptor.inputSchema as SubsetSchema).properties!.referralReason!;
    expect(reason.type).toBe("string"); expect(reason.enum).not.toContain(null);
    const { evidenceIds: _, ...rest } = common;
    expect(project(descriptor.name, { ...rest, referralReason: null }).kind).toBe("invalid");
  });
  it("accepts the exact production pinned schema structure with all canonical dispositions", () => {
    const contract = JSON.parse(readFileSync(new URL("../../fixtures/commerce/pinned-terminal-response-structure.json", import.meta.url), "utf8")) as CommerceResponseContract;
    expect(contract.detailsSchema.properties!.responseDisposition!.enum).toEqual(["STANDARD", "OUT_OF_SCOPE_REDIRECT", "SHIPPING_INFORMATION_UNVERIFIED", "PRODUCT_OPTIONS", "PRODUCT_DETAILS"]);
    const port = makeRecoveryTerminalFinalizer({ responseContract: contract, responseContractHash: digest(responseContractCanonicalJson(contract)), digest, platform: "SHOPIFY", locale: "en" });
    expect(port).not.toBeNull();
    expect(port!.terminalTools.map(tool => tool.name)).toContain("recovery_complete_details_with_context");
    const shipping = port!.terminalTools.find(tool => tool.name === "recovery_complete_shipping")!;
    expect((shipping.inputSchema as SubsetSchema).properties!.responseDisposition!.enum).toEqual(["STANDARD", "OUT_OF_SCOPE_REDIRECT", "SHIPPING_INFORMATION_UNVERIFIED"]);
  });
  it("keeps evidence authority explicit and preserves the existing ineligible-evidence referral", () => {
    const absent = setup(); const args = { ...absent.common, evidenceIds: ["a".repeat(64)] };
    expect(absent.project("recovery_complete_answer", args).kind).toBe("invalid");
    const rejected = setup(() => false);
    expect(rejected.project("recovery_complete_answer", args)).toMatchObject({ kind: "decision", value: { answerKind: "REFER_TO_STORE", referralReason: "UNVERIFIABLE_FACTS", evidenceIds: [], details: {} } });
    const accepted = setup(() => true);
    expect(accepted.project("recovery_complete_answer", args)).toMatchObject({ kind: "decision", value: { answerKind: "ANSWER", evidenceIds: args.evidenceIds } });
    const failed = setup(() => { throw new Error("eligibility unavailable"); });
    expect(failed.project("recovery_complete_answer", args).kind).toBe("invalid");
  });
  it.each(["recovery_complete_details", "recovery_complete_options"])("accepts only model-selected identity fields for %s", name => {
    const { port, project } = setup();
    const descriptor = port.terminalTools.find(tool => tool.name === name)!;
    expect(descriptor.inputSchema).toMatchObject({ type: "object", required: ["selectedPairs"], additionalProperties: false });
    expect(Object.keys((descriptor.inputSchema as SubsetSchema).properties!)).toEqual(["selectedPairs"]);
    const result = project(name, { selectedPairs: [pair] });
    expect(result).toMatchObject({ kind: "decision", value: { answerKind: "ANSWER", evidenceIds: [], detectedLanguageTag: null, detectedLanguageConfidence: null } });
    for (const selectedPairs of [[], [pair, pair], [{ ...pair, productId: "foreign" }]]) expect(project(name, { selectedPairs }).kind).toBe("invalid");
    expect(project(name, { selectedPairs: [pair], replyText: "model claim" }).kind).toBe("invalid");
    expect(project(name, { selectedPairs: [pair] }, "UNVERIFIABLE_FACTS").kind).toBe("invalid");
  });
  it("handles30 repeated rows by exact agreed titles without choosing any initial price", () => {
    const { project } = setup();
    const products = Array.from({ length: 10 }, (_, index) => ({ ...observedProduct, productId: `product-${index}`, title: `Title ${index}`, unitPrice: "991.00" }));
    const repeated = [0, 1, 2].map(index => toolResult("commerce_search_products", { products: products.map(product => ({ ...product, unitPrice: index === 1 ? "992.00" : product.unitPrice })), cursor: null, truncated: false }));
    const selectedPairs = products.slice(0, 3).map(({ productId, variantId }) => ({ productId, variantId }));
    const result = project("recovery_complete_details", { selectedPairs }, null, repeated);
    expect(result).toMatchObject({ kind: "decision", value: { replyText: "Title 0\n\nTitle 1\n\nTitle 2" } });
    expect(JSON.stringify(result)).not.toMatch(/991|992/);
    const conflicting = structuredClone(repeated); (conflicting[1]!.result.data as { products: typeof products }).products[0]!.title = "Conflicting title";
    expect(project("recovery_complete_details", { selectedPairs }, null, conflicting).kind).toBe("invalid");
    const malformed = structuredClone(repeated); (malformed[1]!.result.data as { products: Record<string, unknown>[] }).products[0]!.title = null;
    expect(project("recovery_complete_details", { selectedPairs }, null, malformed).kind).toBe("invalid");
  });
  it("uses direct bounded root tools and refuses unsupported custom pinned detail shapes", () => {
    const { port, contract } = setup();
    expect(port.terminalTools.length).toBeLessThanOrEqual(11);
    for (const tool of port.terminalTools) {
      const schema = tool.inputSchema as SubsetSchema;
      expect(schema.type).toBe("object"); expect(schema.additionalProperties).toBe(false);
      expect(schema.required).toEqual(expect.arrayContaining(tool.name === "recovery_complete_details" || tool.name === "recovery_complete_options" ? ["selectedPairs"] : ["replyText", "detectedLanguageTag", "detectedLanguageConfidence"])); expect(schema).not.toHaveProperty("anyOf");
    }
    contract.detailsSchema.properties!.customRequired = { type: "string", maxLength: 20 };
    expect(makeRecoveryTerminalFinalizer({ responseContract: contract, responseContractHash: digest(responseContractCanonicalJson(contract)), digest, platform: "SHOPIFY", locale: "en" })).toBeNull();
  });
});
