import { describe, expect, it, vi } from "vitest";
import { composeCommerceWhatsAppPreview } from "@modainteract/moda-interact-shared/commerce/presentation";
import type { CommerceFinalResponse } from "@modainteract/moda-interact-shared/commerce";
import { prepareProductFactsPresentation } from "./presentation.js";
const pair = { productId: "p1", variantId: null };
const envelope = (details: Record<string, unknown> = {}, replyText = "Model prose must not supply facts"): CommerceFinalResponse => ({answerKind:"ANSWER",replyText,referralReason:null,detectedLanguageTag:null,detectedLanguageConfidence:null,evidenceIds:[],details});
const product = { ...pair, title:"Shirt", url:null, available:null, unitPrice:null, currency:null, productType:null,vendor:null,observedAt:"2026-11-08T00:00:00Z",options:{status:"AVAILABLE",items:[{name:"Size",values:["S","M","L"],usedForVariants:true}]}};
const setup = (details: Record<string, unknown>) => ({envelope:envelope(details),authorizedPairs:[pair],readProduct:vi.fn(async () => ({product})),consumeBudget:vi.fn(),assertCurrent:vi.fn(),brandName:null,locale:"en" as const,storeUrl:"https://shop.example"});
describe("host product facts verification", () => {
 it("renders plain sizes without a purchase URL or recommendation and truthfully limits unknown details", async () => {
  const input=setup({productDetailSelections:[pair],responseDisposition:"PRODUCT_DETAILS"}); const p=await prepareProductFactsPresentation(input);
  expect(input.readProduct).toHaveBeenCalledExactlyOnceWith(pair); expect(input.consumeBudget).toHaveBeenCalledTimes(1); expect(input.assertCurrent).toHaveBeenCalledTimes(2);
  const result=composeCommerceWhatsAppPreview({envelope:input.envelope,presentation:p!});
  expect(result.kind).toBe("ready"); if(result.kind!=="ready") return;
  expect(result.body).toBe("Shirt\nSize: S, M, L\nProduct information is incomplete.");
  expect(p).toMatchObject({products:[],includeNoVerifiedOffer:false,disposition:"PRODUCT_DETAILS"});
 });
 it.each([{productDetailSelections:[pair,pair]},{productDetailSelections:[{...pair,title:"forged"}]},{productDetailSelections:[pair],productOptionSelections:[pair]},{productDetailSelections:[{...pair,variantId:"invented"}]}])("rejects invalid, duplicate, mixed or unobserved exact pairs before reads",async details=>{
  const input=setup(details); await expect(prepareProductFactsPresentation(input)).rejects.toMatchObject({stage:"presentation.verify"}); expect(input.readProduct).not.toHaveBeenCalled();
 });
 it("does not infer any selection from yes or prose",async()=>{const input=setup({});input.envelope.replyText="yes, size medium";expect(await prepareProductFactsPresentation(input)).toBeNull();expect(input.readProduct).not.toHaveBeenCalled();});
 it("propagates exhausted budget before a provider call",async()=>{const input=setup({productOptionSelections:[pair]});input.consumeBudget.mockImplementation(()=>{throw new Error("BUDGET_EXHAUSTED")});await expect(prepareProductFactsPresentation(input)).rejects.toThrow("BUDGET_EXHAUSTED");expect(input.readProduct).not.toHaveBeenCalled();});
 it("rejects a different fresh product identity",async()=>{const input=setup({productOptionSelections:[pair]});input.readProduct.mockResolvedValue({product:{...product,productId:"other"}});await expect(prepareProductFactsPresentation(input)).rejects.toMatchObject({code:"PRODUCT_NOT_FOUND"});});
 it("preserves legacy options and canonical missing-fact limitation",async()=>{const input=setup({productOptionSelections:[pair]});expect(await prepareProductFactsPresentation(input)).toMatchObject({disposition:"PRODUCT_OPTIONS",optionFacts:[{productId:"p1"}]});});
 it("uses the actual Shared composer 4096/4097 envelope boundary",async()=>{const p=await prepareProductFactsPresentation(setup({productDetailSelections:[pair]}));const presentation={...p!,disposition:"STANDARD" as const};expect(composeCommerceWhatsAppPreview({envelope:envelope({},"x".repeat(4096)),presentation})).toMatchObject({kind:"ready",body:"x".repeat(4096)});expect(composeCommerceWhatsAppPreview({envelope:envelope({},"x".repeat(4097)),presentation})).toMatchObject({kind:"refused"});});
});

it("matches Studio's identical synthetic Tree fixture byte-for-byte", async () => {
 // Identical literal inputs to Commerce tests/arch066-preview-presentation.test.ts:8-15;
 // deliberately no cross-service import or production customer/recovery fabrication.
 const now = Date.parse("2026-11-08T12:00:00Z");
 const pair = { productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/2" };
 const { CommerceProductSchema, exampleFinal } = await import("@modainteract/moda-interact-shared/commerce");
 const { verifyCommerceProductFacts } = await import("@modainteract/moda-interact-shared/commerce/presentation");
 const product = CommerceProductSchema.parse({ ...pair, title: "Tree", url: "https://shop.example/tree", available: true, unitPrice: "12.50", currency: "GBP", productType: null, vendor: null, observedAt: new Date(now).toISOString(), description: { status: "AVAILABLE", text: "Oak & fern" }, attributes: { status: "AVAILABLE", items: [{ name: "Height", values: ["30 cm"] }] }, options: { status: "NOT_PROVIDED", items: [] }, selectedOptions: [] });
 const envelope = { ...exampleFinal, answerKind: "ANSWER" as const, referralReason: null, details: { productDetailSelections: [pair], responseDisposition: "PRODUCT_DETAILS" } };
 const verified = await prepareProductFactsPresentation({ envelope, authorizedPairs: [pair], readProduct: async () => ({ product }), consumeBudget: () => {}, assertCurrent: () => {}, brandName: "Trees", locale: "en", storeUrl: "https://shop.example" });
 const facts = verifyCommerceProductFacts([pair], [product]);
 expect(facts.kind).toBe("verified"); if (facts.kind !== "verified") throw Error("fixture invalid");
 const studioCanonicalInput = { envelope, presentation: { schemaVersion: 1 as const, brandName: "Trees", locale: "en" as const, disposition: "PRODUCT_DETAILS" as const, storeUrl: "https://shop.example", products: [], optionFacts: [], productFacts: facts.productFacts, requiresShipping: null, policyUrl: null, includeNoVerifiedOffer: false } };
 expect(verified).toEqual(studioCanonicalInput.presentation);
 const actual = composeCommerceWhatsAppPreview({ envelope, presentation: verified! });
 const studioExpected = composeCommerceWhatsAppPreview(studioCanonicalInput);
 expect(actual).toEqual(studioExpected);
 if (actual.kind !== "ready" || studioExpected.kind !== "ready") throw Error("fixture refused");
 expect(Buffer.from(actual.body)).toEqual(Buffer.from(studioExpected.body));
 expect(actual.body).toBe("Tree\nOak & fern\nHeight: 30 cm");
});
