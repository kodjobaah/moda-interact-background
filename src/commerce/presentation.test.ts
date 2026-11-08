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
