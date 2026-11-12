import { describe, expect, it, vi } from "vitest";
import { CommerceProductSchema, exampleFinal } from "@modainteract/moda-interact-shared/commerce";
import { verifyCommerceProductFacts } from "@modainteract/moda-interact-shared/commerce/presentation";
import { composeAiOutbound } from "../../../../src/services/conversation-wrappers/compose-ai-outbound.js";
import { appendRecoveryCheckoutFooter, withRecoveryCheckoutFooter, withLegacyRecoveryCheckoutFooter, RECOVERY_CHECKOUT_SEPARATOR } from "../../../../src/services/conversation-wrappers/recovery-checkout-footer.js";
import type { CommercePresentationInput } from "../../../../src/services/conversation-wrappers/contracts.js";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { ConversationWrapperService } from "../../../../src/services/conversation-wrappers/service.js";
import { digest, stableJson } from "../../../../src/services/conversation-wrappers/projection.js";
import type { PreparedWrapper, VerifiedWrapperContext, WrapperSlot } from "../../../../src/services/conversation-wrappers/contracts.js";

const checkoutUrl = "https://shop.example/checkouts/recover?key=opaque";
const context: VerifiedWrapperContext = { conversationId: "conversation", shopId: "shop", conversationLanguageTag: "en", merchantLanguageTag: "en", variables: {"checkout.url": checkoutUrl}, checkoutAvailable: true };
const plainPrepared: PreparedWrapper = {schemaVersion: 1, family: "MODA_CONVERSATION_WRAPPER", responseSlot: "response.body", header: [], body: [{kind: "responseSlot", name: "response.body"}], footer: [], conditionals: []};
function slot(prepared = plainPrepared): WrapperSlot {
 const contentHash = digest(stableJson(prepared));
 return {audience: "AI", definitionId: "ai-wrapper", editVersion: 1, definition: {id: "ai-wrapper", kind: "MODA_CONVERSATION_WRAPPER", audience: "AI", status: "PUBLISHED", sourceLanguageTag: "en", astSchemaVersion: 1, sourceHash: "a".repeat(64), publishedAt: new Date(), retiredAt: null, createdByAdminId: "admin", locales: [{id: "en", languageTag: "en", status: "SOURCE_SAVED", providerLanguageCode: null, localeAst: {schemaVersion: 1, prepared}, contentHash, reviewedAt: null, reviewedByAdminId: null}]}};
}
function harness(current: VerifiedWrapperContext | "TENANT_MISMATCH" | null = context, slots: WrapperSlot[] = [slot()]) {
 const logger = {info: vi.fn(), warn: vi.fn(), error: vi.fn()} as unknown as StructuredLogger;
 return new ConversationWrapperService({repository: {loadContext: async () => current, loadSlots: async () => slots}, logger, onMissingSlot: "passthrough"});
}
const input = {conversationId: "conversation", messageIdentity: "message", source: "AI" as const, responseBody: "This item is available."};

describe("ARCH-070 recovery checkout footer", () => {
 it("adds the trusted checkout footer even when the published wrapper contains only response.body", async () => {
  const result = await harness().renderConversationResponse(input);
  expect(result.kind).toBe("rendered");
  if(result.kind !== "rendered") return;
  expect(result.body).toBe(input.responseBody + RECOVERY_CHECKOUT_SEPARATOR + checkoutUrl);
 });
});

const pair = {productId: "product-1", variantId: "variant-1"};
const product = CommerceProductSchema.parse({...pair, title: "Snowboard", url: null, available: true, unitPrice: "629.95", currency: "USD", productType: "Snowboard", vendor: "Merchant", observedAt: "2026-11-12T12:00:00Z", imageUrl: "https://merchant.example/snowboard.jpg"});
function presentation(body: string, mode: "plain" | "details" | "recommendations" = "plain"): CommercePresentationInput {
 const details = verifyCommerceProductFacts([pair], [product]);
 if(details.kind !== "verified") throw new Error("invalid facts fixture");
 return {envelope: {...exampleFinal, replyText: body, answerKind: "ANSWER", referralReason: null, details: mode === "details" ? {productDetailSelections: [pair]} : {}}, verified: {schemaVersion: 1, brandName: null, locale: "en", disposition: mode === "details" ? "PRODUCT_DETAILS" : "STANDARD", storeUrl: "https://shop.example", products: mode === "recommendations" ? [{title: "Other snowboard", url: "https://shop.example/products/other", scope: "PRODUCT_ONLY", quantity: 1, currentPrice: "100", currency: "USD"}] : [], optionFacts: [], productFacts: mode === "details" ? details.productFacts : [], requiresShipping: null, policyUrl: null, includeNoVerifiedOffer: false}, productPairs: mode === "recommendations" ? [pair] : [], verifiedProducts: {shopId: "shop", platform: "SHOPIFY", products: [product]}, deadlineAt: Date.now() + 10000};
}

describe("trusted footer scope and canonicalization", () => {
 it.each([input.responseBody + RECOVERY_CHECKOUT_SEPARATOR + checkoutUrl, "Return here: " + checkoutUrl + "\nMore details.", "See " + checkoutUrl + ".\n" + checkoutUrl])("moves the exact trusted link to one final footer: %s", async body => {
  const result = await harness().renderConversationResponse({...input, responseBody: body});
  expect(result.kind).toBe("rendered");
  if(result.kind !== "rendered") return;
  expect(result.body.split("\n\n").at(-1)).toContain(checkoutUrl);
  expect(result.body.split(checkoutUrl)).toHaveLength(2);
  expect(result.body).toBe(withRecoveryCheckoutFooter(body, checkoutUrl));
 });
 it("avoids duplicate checkout-only wrapper sections without mistaking the model body for a prepared wrapper", async () => {
  const prepared: PreparedWrapper = {...plainPrepared, conditionals: [{when: "checkout.available", tokens: [{kind: "variable", name: "checkout.url"}]}]};
  const original = input.responseBody + "\n" + checkoutUrl;
  const result = await harness(context, [slot(prepared)]).renderConversationResponse({...input, responseBody: original});
  expect(result).toMatchObject({kind: "rendered", body: input.responseBody + RECOVERY_CHECKOUT_SEPARATOR + checkoutUrl});
 });
 it("moves a wrapper checkout section after the authored footer and leaves other links untouched", async () => {
  const prepared: PreparedWrapper = {...plainPrepared, conditionals: [{when: "checkout.available", tokens: [{kind: "text", value: "Your checkout: "}, {kind: "variable", name: "checkout.url"}]}], footer: [{kind: "text", value: "Merchant footer. https://shop.example/policies/refund"}]};
  const result = await harness(context, [slot(prepared)]).renderConversationResponse(input);
  expect(result.kind).toBe("rendered");
  if(result.kind !== "rendered") return;
  expect(result.body).toBe(input.responseBody + "\nMerchant footer. https://shop.example/policies/refund" + RECOVERY_CHECKOUT_SEPARATOR + "Your checkout: " + checkoutUrl);
  expect(result.body.split(checkoutUrl)).toHaveLength(2);
 });
 it("preserves embedded Markdown and parenthesized links without dangling empty markup", () => {
  for(const body of [`[Return to checkout](${checkoutUrl})`, `(${checkoutUrl})`, `prefix${checkoutUrl}`]) {
   expect(withRecoveryCheckoutFooter(body, checkoutUrl)).toBe(body + RECOVERY_CHECKOUT_SEPARATOR + checkoutUrl);
  }
 });
 it("retains the unrelated already-wrapped guard", async () => {
  const prepared: PreparedWrapper = {...plainPrepared, header: [{kind: "text", value: "Header"}], footer: [{kind: "text", value: "Footer"}]};
  const result = await harness(context, [slot(prepared)]).renderConversationResponse({...input, responseBody: "Header\nOriginal answer\nFooter"});
  expect(result).toEqual({kind: "rejected", reason: "ALREADY_WRAPPED"});
 });
 it("does not bypass a genuine authored envelope just because checkout is also present", async () => {
  const prepared: PreparedWrapper = {...plainPrepared, header: [{kind: "text", value: "Header"}], footer: [{kind: "text", value: "Footer"}], conditionals: [{when: "checkout.available", tokens: [{kind: "variable", name: "checkout.url"}]}]};
  const result = await harness(context, [slot(prepared)]).renderConversationResponse({...input, responseBody: "Header\nOriginal answer\n" + checkoutUrl + "\nFooter"});
  expect(result).toEqual({kind: "rejected", reason: "ALREADY_WRAPPED"});
 });
 it("normalizes a render copy without mutating the original host envelope", async () => {
  const prepared: PreparedWrapper = {...plainPrepared, conditionals: [{when: "checkout.available", tokens: [{kind: "variable", name: "checkout.url"}]}]};
  const commercePresentation = presentation(input.responseBody + "\n" + checkoutUrl);
  const before = JSON.stringify(commercePresentation.envelope);
  const result = await harness(context, [slot(prepared)]).renderConversationResponse({...input, commercePresentation});
  expect(result).toMatchObject({kind: "rendered", body: input.responseBody + RECOVERY_CHECKOUT_SEPARATOR + checkoutUrl});
  expect(JSON.stringify(commercePresentation.envelope)).toBe(before);
 });
 it("is idempotent with multiple differently labelled checkout lines and a custom ending", () => {
  const body = `Answer.\nFirst checkout: ${checkoutUrl}\nSecond checkout: ${checkoutUrl}\nMerchant footer.`;
  const once = withRecoveryCheckoutFooter(body, checkoutUrl);
  expect(once).toContain("First checkout:");
  expect(once).toContain("Merchant footer.");
  expect(once.endsWith(RECOVERY_CHECKOUT_SEPARATOR + "Second checkout: " + checkoutUrl)).toBe(true);
  expect(once.split(checkoutUrl)).toHaveLength(2);
  expect(withRecoveryCheckoutFooter(once, checkoutUrl)).toBe(once);
 });
 it("does not replace different checkout URLs or a trusted URL nested inside another link", () => {
  const other = checkoutUrl + "&discount=SAVE";
  const nested = "https://other.example/?redirect=" + checkoutUrl;
  const body = other + "\n" + nested;
  expect(withRecoveryCheckoutFooter(body, checkoutUrl)).toBe(body + RECOVERY_CHECKOUT_SEPARATOR + checkoutUrl);
 });
 it("uses eligible HUMAN context while excluding inactive or mismatched context", async () => {
  expect(await harness({...context, checkoutAvailable: false, variables: {}}).renderConversationResponse(input)).toMatchObject({kind: "rendered", body: input.responseBody});
  expect(await harness(context, []).renderConversationResponse({...input, source: "HUMAN"})).toEqual({kind: "no-wrapper", reason: "NOT_CONFIGURED", body: input.responseBody + RECOVERY_CHECKOUT_SEPARATOR + checkoutUrl, recoveryCheckoutUrl: checkoutUrl});
  expect(await harness("TENANT_MISMATCH").renderConversationResponse(input)).toEqual({kind: "rejected", reason: "TENANT_MISMATCH"});
 });
 it.each(["http://shop.example/checkout", "https://user:pass@shop.example/checkout", "https://shop.example:8443/checkout", "https://shop.example/checkout\n", "https://shop.invalid/checkout", "not-a-url"])("refuses unsafe trusted augmentation: %s", async url => {
  expect(await harness({...context, variables: {"checkout.url": url}}).renderConversationResponse(input)).toEqual({kind: "rejected", reason: "VARIABLE_UNAVAILABLE"});
 });
 it("refuses a missing checkout value when eligible rather than inventing a link", () => {
  expect(appendRecoveryCheckoutFooter({body: input.responseBody, source: "AI", context: {...context, variables: {}}})).toEqual({kind: "rejected", reason: "VARIABLE_UNAVAILABLE"});
 });
 it("keeps unsafe control characters out of augmented no-wrapper output", async () => {
  expect(await harness(context, []).renderConversationResponse({...input, responseBody: "Unsafe\u0000text"})).toEqual({kind: "rejected", reason: "INVALID_INPUT"});
 });
 it("retains the original no-wrapper comparison unless the exact trusted footer augments it", async () => {
  const service = harness(context, []);
  expect(await composeAiOutbound(service, {conversationId: input.conversationId, messageId: input.messageIdentity, generatedResponse: input.responseBody})).toMatchObject({kind: "ready", text: input.responseBody + RECOVERY_CHECKOUT_SEPARATOR + checkoutUrl, wrapper: null});
  for(const result of [{kind: "no-wrapper" as const, reason: "NOT_CONFIGURED" as const, body: "rewritten\n\n" + checkoutUrl, recoveryCheckoutUrl: checkoutUrl}, {kind: "no-wrapper" as const, reason: "NOT_CONFIGURED" as const, body: input.responseBody + "\n\nhttp://shop.example", recoveryCheckoutUrl: "http://shop.example"}]) {
   await expect(composeAiOutbound({renderConversationResponse: async () => result}, {conversationId: input.conversationId, messageId: input.messageIdentity, generatedResponse: input.responseBody})).rejects.toThrow("AI_WRAPPER_PASSTHROUGH_MISMATCH");
  }
 });
 it.each(["plain", "details", "recommendations"] as const)("carries the footer in %s presentation and its delivery plan with and without wrappers", async mode => {
  for(const slots of [[], [slot()]]) {
   const result = await harness(context, slots).renderConversationResponse({...input, commercePresentation: presentation(input.responseBody, mode)});
   expect(["rendered", "no-wrapper"]).toContain(result.kind);
   if(result.kind !== "rendered" && result.kind !== "no-wrapper") continue;
   expect(result.body).toBe(input.responseBody + RECOVERY_CHECKOUT_SEPARATOR + checkoutUrl);
   expect(result.deliveryPlan?.body).toBe(result.body);
  }
 });
 it("keeps footer-bearing application provenance stable on immutable replay and rejects tampering", async () => {
  const body = "Return here: " + checkoutUrl + "\nStill available.";
  const service = harness();
  const request = {...input, responseBody: body};
  const first = await service.renderConversationResponse(request);
  if(first.kind !== "rendered") throw new Error("expected rendered");
  expect(await service.renderConversationResponse({...request, previousApplication: first})).toEqual({...first, replayed: true});
  expect(await service.renderConversationResponse({...request, previousApplication: {...first, recoveryCheckoutUrl: "https://other.example/checkout"}})).toEqual({kind: "rejected", reason: "REPLAY_MISMATCH"});
  expect(await service.renderConversationResponse({...request, previousApplication: {...first, body: first.body + "changed"}})).toEqual({kind: "rejected", reason: "REPLAY_MISMATCH"});
 });
 it("preserves immutable older applications rather than appending after preparation", async () => {
  const service = harness({...context, checkoutAvailable: false, variables: {}});
  const first = await service.renderConversationResponse(input);
  if(first.kind !== "rendered") throw new Error("expected rendered");
  expect(await harness().renderConversationResponse({...input, previousApplication: first})).toEqual({...first, replayed: true});
  expect(first.body).not.toContain(checkoutUrl);
 });
 it("includes the footer in the 4096 limit and refuses overflow without cutting the URL", async () => {
  const exact = "a".repeat(4096 - checkoutUrl.length - RECOVERY_CHECKOUT_SEPARATOR.length);
  for(const slots of [[], [slot()]]) {
   const good = await harness(context, slots).renderConversationResponse({...input, responseBody: exact});
   expect(["rendered", "no-wrapper"]).toContain(good.kind);
   if(good.kind === "rendered" || good.kind === "no-wrapper") expect(good.body.length).toBe(4096);
   expect(await harness(context, slots).renderConversationResponse({...input, responseBody: exact + "a"})).toEqual({kind: "rejected", reason: "OUTPUT_TOO_LONG"});
  }
 });
 it("puts the complete footer inside the image caption and falls back to text before 1024 overflow", async () => {
  const prepared = {...plainPrepared, productImage: {variable: "response.productImage" as const, placement: "BEFORE_BODY" as const, optional: true as const}};
  const image = {schemaVersion: 1 as const, shopId: "shop", ...pair, publicUrl: "https://media.example/snowboard.jpg", objectKey: `conversation-products/v1/${"a".repeat(64)}/${"b".repeat(64)}/${"c".repeat(64)}.jpg`, contentSha256: "c".repeat(64), contentType: "image/jpeg" as const, byteLength: 100, width: 1125 as const, height: 600 as const};
  const prepareConversationProductImage = vi.fn(async () => ({kind: "READY", image, stage: "READY", durationMs: 1} as const));
  const mediaDependencies = {readShopBrandPublicMediaConfiguration: async () => ({publicOrigin: "https://media.example", bucketName: "media"}), readR2Configuration: async () => ({endpoint: "https://fixture.r2.cloudflarestorage.com", accessKeyId: "fixture", secretAccessKey: "fixture"}), prepareConversationProductImage};
  const service = new ConversationWrapperService({repository: {loadContext: async () => context, loadSlots: async () => [slot(prepared)]}, mediaDependencies: mediaDependencies as never});
  for(const length of [100, 1000]) {
   const body = "a".repeat(length);
   const result = await service.renderConversationResponse({...input, responseBody: body, commercePresentation: presentation(body, "details")});
   expect(result.kind).toBe("rendered");
   if(result.kind !== "rendered") continue;
   expect(result.deliveryPlan?.kind).toBe(length === 100 ? "IMAGE" : "TEXT");
   expect(result.deliveryPlan?.body).toBe(body + RECOVERY_CHECKOUT_SEPARATOR + checkoutUrl);
  }
  expect(prepareConversationProductImage).toHaveBeenCalledTimes(1);
 });
});


describe("legacy immutable footer replay", () => {
 it("reuses a prior configured no-divider footer byte-identically", async () => {
  const first = await harness().renderConversationResponse(input);
  if(first.kind !== "rendered") throw new Error("expected rendered");
  const body = withLegacyRecoveryCheckoutFooter(input.responseBody, checkoutUrl);
  const previous = {...first, body, applicationKey: digest(stableJson({conversationId: input.conversationId, messageIdentity: first.messageIdentity,
   source: first.source, wrapperDefinitionId: first.wrapperDefinitionId, localeId: first.localeId, contentHash: first.contentHash,
   editVersion: first.slotEditVersion, responseDigest: first.responseDigest, bodyDigest: digest(body), recoveryCheckoutUrlDigest: digest(checkoutUrl)}))};
  expect(await harness().renderConversationResponse({...input, previousApplication: previous})).toEqual({...previous, replayed:true});
  expect(previous.body).not.toContain("──────────");
 });
 it("preserves an already prepared no-slot legacy footer in the AI compose adapter", async () => {
  const body = withLegacyRecoveryCheckoutFooter(input.responseBody, checkoutUrl);
  const result = await composeAiOutbound({renderConversationResponse: async () => ({kind:"no-wrapper", reason:"NOT_CONFIGURED", body, recoveryCheckoutUrl:checkoutUrl})},
   {conversationId:input.conversationId,messageId:input.messageIdentity,generatedResponse:input.responseBody});
  expect(result).toMatchObject({kind:"ready",text:body});
 });
});
