import { exampleFinal } from "@modainteract/moda-interact-shared/commerce";
import type { CommercePresentationInput } from "../../../../src/services/conversation-wrappers/contracts.js";
import { describe, expect, it, vi } from "vitest";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { ConversationWrapperService } from "../../../../src/services/conversation-wrappers/service.js";
import { digest, stableJson } from "../../../../src/services/conversation-wrappers/projection.js";
import { chooseSlot, languageChoices } from "../../../../src/services/conversation-wrappers/selection.js";
import type {
  PreparedWrapper, VerifiedWrapperContext, WrapperReadPort, WrapperSlot,
} from "../../../../src/services/conversation-wrappers/contracts.js";

const response = "Original user-facing answer.";
const prepared: PreparedWrapper = {
  schemaVersion: 1, family: "MODA_CONVERSATION_WRAPPER", responseSlot: "response.body",
  header: [{ kind: "text", value: "Header" }], body: [{ kind: "responseSlot", name: "response.body" }],
  footer: [{ kind: "text", value: "Footer" }], conditionals: [],
};
const context: VerifiedWrapperContext = { conversationId: "conversation", shopId: "shop",
  conversationLanguageTag: "fr", merchantLanguageTag: "en", variables: {}, checkoutAvailable: false };
function slot(audience: "AI" | "HUMAN" | "SHARED", params: { published?: boolean; wrongKind?: boolean; preparedMissing?: boolean } = {}): WrapperSlot {
  const contentHash = digest(stableJson(prepared));
  return { audience, definitionId: `${audience}-def`, editVersion: 3, definition: {
    id: `${audience}-def`, kind: params.wrongKind ? "META_RECOVERY" : "MODA_CONVERSATION_WRAPPER",
    audience, status: "PUBLISHED", sourceLanguageTag: "en", astSchemaVersion: 1,
    sourceHash: "a".repeat(64), publishedAt: params.published === false ? null : new Date(),
    retiredAt: null, createdByAdminId: "platform-admin", locales: [
      { id: `${audience}-en`, languageTag: "en", status: "SOURCE_SAVED", providerLanguageCode: null,
        localeAst: { schemaVersion: 1, prepared }, contentHash,
        reviewedAt: null, reviewedByAdminId: null },
      { id: `${audience}-fr`, languageTag: "fr", status: "REVIEWED", providerLanguageCode: null,
        localeAst: params.preparedMissing ? { schemaVersion: 1 } : { schemaVersion: 1, prepared }, contentHash,
        reviewedAt: new Date(), reviewedByAdminId: "platform-admin" },
    ],
  } };
}
function harness(slots: WrapperSlot[], current: VerifiedWrapperContext | "TENANT_MISMATCH" | null = context) {
  const read = {
    loadContext: vi.fn(async () => current), loadSlots: vi.fn(async () => slots),
  } satisfies WrapperReadPort;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as unknown as StructuredLogger;
  const service = new ConversationWrapperService({ repository: read, logger });
  return { read, logger, service };
}
const input = { conversationId: "conversation", source: "AI" as const,
  messageIdentity: "outbound:one", responseBody: response };

describe("ARCH-047 BG005 selection and facade", () => {
  it("applies AI/HUMAN override, then SHARED, without fallback from invalid override", async () => {
    const { service } = harness([slot("SHARED"), slot("AI")]);
    const ai = await service.renderConversationResponse(input);
    expect(ai).toMatchObject({ kind: "rendered", wrapperDefinitionId: "AI-def", localeId: "AI-fr" });
    const human = await service.renderConversationResponse({ ...input, source: "HUMAN" });
    expect(human).toMatchObject({ kind: "rendered", wrapperDefinitionId: "SHARED-def" });
    const wrong = harness([slot("SHARED"), slot("AI", { wrongKind: true })]);
    expect(await wrong.service.renderConversationResponse(input))
      .toEqual({ kind: "rejected", reason: "DEFINITION_UNAVAILABLE" });
  });
  it("checks active definition publication, locale readiness and prepared projection", async () => {
    for (const [chosen, reason] of [
      [slot("AI", { published: false }), "DEFINITION_UNAVAILABLE"],
      [slot("AI", { preparedMissing: true }), "PREPARED_MISSING"],
    ] as const) {
      const service = harness([chosen]).service;
      expect(await service.renderConversationResponse(input)).toEqual({ kind: "rejected", reason });
    }
  });
  it("uses stored conversation language and merchant fallback only for unavailable locale", async () => {
    expect(languageChoices({ conversationTag: "fr-CA", merchantTag: "en", preferredTag: null,
      platformFallbackTag: null })).toEqual(["fr-CA", "fr", "en"]);
    expect(languageChoices({ conversationTag: "de", merchantTag: "en", preferredTag: "en",
      platformFallbackTag: null })).toBe("invalid");
    expect(chooseSlot([slot("SHARED")], "AI")).toMatchObject({ audience: "SHARED" });
    const { service } = harness([slot("SHARED")], { ...context, conversationLanguageTag: "de" });
    expect(await service.renderConversationResponse(input)).toMatchObject({ kind: "rendered", languageTag: "en" });
  });
  it("replays deterministic message output without consulting changed active slots", async () => {
    const { service, read } = harness([slot("AI")]);
    const first = await service.renderConversationResponse(input);
    expect(first.kind).toBe("rendered");
    if (first.kind !== "rendered") return;
    expect(first.body).toContain(response);
    expect((await service.renderConversationResponse(input))).toMatchObject({
      kind: "rendered", applicationKey: first.applicationKey, body: first.body,
    });
    read.loadSlots.mockRejectedValue(new Error("should not be called"));
    const replay = await service.renderConversationResponse({ ...input, previousApplication: first });
    expect(replay).toMatchObject({ ...first, replayed: true });
    expect(await service.renderConversationResponse({ ...input, responseBody: "Different",
      previousApplication: first })).toEqual({ kind: "rejected", reason: "REPLAY_MISMATCH" });
  });
  it("does not bypass tenant scoping or permit empty malformed inputs", async () => {
    const { service, read } = harness([slot("SHARED")], "TENANT_MISMATCH");
    expect(await service.renderConversationResponse(input)).toEqual({ kind: "rejected", reason: "TENANT_MISMATCH" });
    expect(read.loadSlots).not.toHaveBeenCalled();
    expect(await service.renderConversationResponse({ ...input, messageIdentity: "" }))
      .toEqual({ kind: "rejected", reason: "INVALID_INPUT" });
  });
  it("supports explicit no-wrapper passthrough, which does not claim admission", async () => {
    const read = { loadContext: async () => context, loadSlots: async () => [] } satisfies WrapperReadPort;
    const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as unknown as StructuredLogger;
    const service = new ConversationWrapperService({ repository: read, logger, onMissingSlot: "passthrough" });
    expect(await service.renderConversationResponse(input)).toEqual({ kind: "no-wrapper", body: response, reason: "NOT_CONFIGURED" });
    expect(await harness([]).service.renderConversationResponse(input)).toEqual({ kind: "unavailable", reason: "NOT_CONFIGURED" });
  });
  it("advances only after a composed length refusal and replays the selected candidate digest", async () => {
    const { service, read } = harness([slot("AI")]);
    const candidates = ["x".repeat(4090), "Compact complete reply."] as const;
    const first = await service.renderConversationResponse({ ...input, responseBody: candidates[0],
      hostComposedReplyCandidates: candidates });
    expect(first).toMatchObject({ kind: "rendered", responseDigest: digest(candidates[1]) });
    if (first.kind !== "rendered") return;
    expect(first.body).toContain(candidates[1]);
    read.loadContext.mockRejectedValue(new Error("replay must stay before reads"));
    expect(await service.renderConversationResponse({ ...input, responseBody: candidates[0],
      hostComposedReplyCandidates: candidates, previousApplication: first })).toMatchObject({ replayed: true });
  });
  it("rejects invalid or HUMAN candidate arrays before context reads", async () => {
    const { service, read } = harness([slot("AI")]);
    expect(await service.renderConversationResponse({ ...input, hostComposedReplyCandidates: ["Other"] }))
      .toEqual({ kind: "rejected", reason: "INVALID_INPUT" });
    expect(await service.renderConversationResponse({ ...input, source: "HUMAN", hostComposedReplyCandidates: [response] }))
      .toEqual({ kind: "rejected", reason: "INVALID_INPUT" });
    expect(read.loadContext).not.toHaveBeenCalled();
  });
  it("logs exceptions through shared-logger interface and rethrows, never swallows", async () => {
    const { service, read, logger } = harness([slot("AI")]);
    read.loadSlots.mockRejectedValue(new Error("do not leak customer URLs"));
    await expect(service.renderConversationResponse(input)).rejects.toThrow("do not leak customer URLs");
    expect(logger.error).toHaveBeenCalledWith("conversation_wrapper.render_exception", expect.objectContaining({
      errorType: "Error", conversationId: "conversation",
    }));
    expect(JSON.stringify((logger.error as ReturnType<typeof vi.fn>).mock.calls)).not.toContain("do not leak customer URLs");
  });
});

const presentation = (text: string): CommercePresentationInput => ({
  envelope: { ...exampleFinal, replyText: text },
  verified: { schemaVersion: 1, brandName: null, locale: "fr", disposition: "STANDARD",
    storeUrl: "https://shop.example", products: [], optionFacts: [], productFacts: [],
    requiresShipping: null, policyUrl: null, includeNoVerifiedOffer: false },
});
describe("ARCH-066 single Shared composition boundary", () => {
  it("normalizes explicit unwrapped AI text while leaving HUMAN behavior unchanged", async () => {
    const { service } = harness([]);
    const value = await service.renderConversationResponse({ ...input, responseBody: "**Hello**",
      commercePresentation: presentation("**Hello**") });
    expect(value).toMatchObject({ kind: "no-wrapper", body: "Hello" });
    expect(await service.renderConversationResponse({ ...input, source: "HUMAN" }))
      .toEqual({ kind: "unavailable", reason: "NOT_CONFIGURED" });
  });
  it("wraps exactly once and replays saved composition without revision reads", async () => {
    const { service, read } = harness([slot("AI")]);
    const typed = { ...input, commercePresentation: presentation(response) };
    const first = await service.renderConversationResponse(typed);
    expect(first).toMatchObject({ kind: "rendered", body: `Header\n${response}\nFooter` });
    if (first.kind !== "rendered") throw new Error("expected rendered");
    read.loadContext.mockRejectedValue(new Error("no reread"));
    read.loadSlots.mockRejectedValue(new Error("no revision reread"));
    expect(await service.renderConversationResponse({ ...typed, previousApplication: first }))
      .toEqual({ ...first, replayed: true });
    expect(await service.renderConversationResponse({ ...typed,
      commercePresentation: presentation("changed"), previousApplication: first }))
      .toEqual({ kind: "rejected", reason: "REPLAY_MISMATCH" });
  });
  it("reuses a validated frozen plan across operational deadline/signal changes and rejects plan tampering", async () => {
    const {service, read} = harness([slot("AI")]);
    const request = {...input, commercePresentation:{...presentation(response), deadlineAt:Date.now()+5000, signal:new AbortController().signal}};
    const first = await service.renderConversationResponse(request);
    if(first.kind !== "rendered") throw new Error("expected rendered");
    expect(first.deliveryPlan).toEqual({schemaVersion:1,kind:"TEXT",body:first.body});
    read.loadContext.mockRejectedValue(new Error("no media/config/context retry"));
    expect(await service.renderConversationResponse({...request, commercePresentation:{...request.commercePresentation,deadlineAt:Date.now()+10000,signal:new AbortController().signal},previousApplication:first})).toEqual({...first,replayed:true});
    expect(await service.renderConversationResponse({...request,previousApplication:{...first,deliveryPlan:{schemaVersion:1,kind:"TEXT",body:"tampered"}}})).toEqual({kind:"rejected",reason:"REPLAY_MISMATCH"});
  });
  it("refuses configured invalid projection, missing locale and untrusted brand", async () => {
    const typed = { ...input, commercePresentation: presentation(response) };
    expect(await harness([slot("AI", { preparedMissing: true })]).service.renderConversationResponse(typed))
      .toEqual({ kind: "rejected", reason: "PREPARED_MISSING" });
    const missing = slot("AI");
    expect(await harness([{ ...missing, definition: { ...missing.definition, locales: [] } }]).service.renderConversationResponse(typed))
      .toEqual({ kind: "rejected", reason: "LOCALE_UNAVAILABLE" });
    expect(await harness([]).service.renderConversationResponse({ ...typed,
      commercePresentation: { ...typed.commercePresentation, verified: { ...typed.commercePresentation.verified, brandName: "fabricated" } } }))
      .toEqual({ kind: "rejected", reason: "INVALID_INPUT" });
  });
  it("checks final total wrapper size at 4096 and refuses 4097", async () => {
    const { service } = harness([slot("AI")]);
    const overhead = "Header\n\nFooter".length;
    for (const length of [4096, 4097]) {
      const text = "x".repeat(length - overhead);
      const result = await service.renderConversationResponse({ ...input, responseBody: text, commercePresentation: presentation(text) });
      if (length === 4096) { expect(result.kind).toBe("rendered"); if (result.kind === "rendered") expect(result.body.length).toBe(4096); }
      else expect(result).toEqual({ kind: "rejected", reason: "OUTPUT_TOO_LONG" });
    }
  });
});

// AGENT style retains the complete answer and all verified pair order, never a shortened fact dump.
describe('ARCH067 rendered presentation receipts', () => {
 it.each([0, 3900, 4050])('retains complete agent content or refuses oversized wrapper with header length %s', async headerLength => {
  const { CommerceProductSchema } = await import('@modainteract/moda-interact-shared/commerce');
  const { verifyCommerceProductFacts } = await import('@modainteract/moda-interact-shared/commerce/presentation');
  const pairs = ['30','10','20'].map(id => ({ productId: id, variantId: null }));
  const products = pairs.map((pair, index) => CommerceProductSchema.parse({ ...pair, title: `Tree ${index}`, url: null, available: true, unitPrice: null, currency: null, productType: null, vendor: null, observedAt: '2026-11-09T12:00:00Z', stock: { status:'KNOWN', quantity:2, scope:'PRODUCT' }, description: { status:'AVAILABLE', text:'d'.repeat(80) } }));
  const facts = verifyCommerceProductFacts(pairs, products);
  if(facts.kind !== 'verified') throw Error('invalid fixture');
  const presentation: CommercePresentationInput = { envelope: { ...exampleFinal, answerKind:'ANSWER', referralReason:null, details:{productDetailSelections:pairs} }, verified:{ schemaVersion:1, brandName:null, locale:'en', disposition:'PRODUCT_DETAILS', storeUrl:'https://shop.example', products:[], productFacts:facts.productFacts, optionFacts:[], requiresShipping:null,policyUrl:null,includeNoVerifiedOffer:false } };
  const wrapperSlot = slot('AI');
  const preparedValue = { ...prepared, header: [{kind:'text',value:'h'.repeat(Math.min(1500, headerLength))}], body: [{kind:'text',value:'h'.repeat(Math.max(0,headerLength-1500))}, {kind:'responseSlot',name:'response.body'}] };
  wrapperSlot.definition.locales[0]!.localeAst = {schemaVersion:1,prepared:preparedValue};
  wrapperSlot.definition.locales[0]!.contentHash = digest(stableJson(preparedValue));
  const test = harness(headerLength ? [wrapperSlot] : [], { ...context, conversationLanguageTag:'en' });
  const result = await test.service.renderConversationResponse({...input,commercePresentation:presentation});
  if(headerLength === 4050) {expect(result).toEqual({kind:'rejected',reason:'OUTPUT_TOO_LONG'});return;}
  expect(['rendered','no-wrapper']).toContain(result.kind);
  if(result.kind === 'rendered' || result.kind === 'no-wrapper') {
   expect(result.presentedPairs).toEqual(pairs);
   expect(result.body).toContain(presentation.envelope.replyText);
   expect(result.body.length).toBeLessThanOrEqual(4096);
  }
 });
});

it('records composition outcome without reply content and tolerates a failed diagnostic sink', async () => {
  const {service,logger}=harness([]);
  const request={...input,responseBody:'**Hello**',commercePresentation:presentation('**Hello**')};
  expect(await service.renderConversationResponse(request)).toMatchObject({kind:'no-wrapper',body:'Hello'});
  expect(logger.info).toHaveBeenCalledWith('commerce.response.composition',expect.objectContaining({stage:'RESULT',outcome:'ready',conversationId:'conversation',productCount:0}));
  expect(JSON.stringify((logger.info as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('Hello');
  (logger.info as ReturnType<typeof vi.fn>).mockImplementation(()=>{throw new Error('sink unavailable');});
  expect(await service.renderConversationResponse(request)).toMatchObject({kind:'no-wrapper',body:'Hello'});
});

describe('ARCH068 complete wrapper product image plans',()=>{
 it.each(['SHOPIFY','WOOCOMMERCE'] as const)('preserves agent prose and first selected pair for %s',async platform=>{
  const {CommerceProductSchema}=await import('@modainteract/moda-interact-shared/commerce');
  const {verifyCommerceProductFacts,buildConversationDeliveryPlan}=await import('@modainteract/moda-interact-shared/commerce/presentation');
  const pairs=[{productId:'second-search-result',variantId:platform==='SHOPIFY'?'exact-variant':null},{productId:'first-search-result',variantId:null}];
  const products=pairs.map(pair=>CommerceProductSchema.parse({...pair,title:'Tree',observedAt:'2026-11-09T12:00:00Z',imageUrl:'https://merchant.example/tree.jpg',url:null,available:true,unitPrice:null,currency:null,productType:null,vendor:null}));
  const facts=verifyCommerceProductFacts(pairs,products);if(facts.kind!=='verified')throw Error('fixture');
  const projection={...prepared,productImage:{variable:'response.productImage',placement:'BEFORE_BODY',optional:true}};
  const active=slot('AI');for(const locale of active.definition.locales){locale.localeAst={schemaVersion:1,prepared:projection};locale.contentHash=digest(stableJson(projection));}
  const image={schemaVersion:1,shopId:'shop',...pairs[0]!,publicUrl:'https://media.example/tree.jpg',objectKey:`conversation-products/v1/${'a'.repeat(64)}/${'b'.repeat(64)}/${'c'.repeat(64)}.jpg`,contentSha256:'c'.repeat(64),contentType:'image/jpeg',byteLength:100,width:1125,height:600} as const;
  const prepareConversationProductImage=vi.fn(async()=>({kind:'READY',image,stage:'READY',durationMs:1} as const));
  const mediaDependencies={readShopBrandPublicMediaConfiguration:vi.fn(async()=>({publicOrigin:'https://media.example',bucketName:'media-bucket'})),readR2Configuration:vi.fn(async()=>({endpoint:'https://fixture.r2.cloudflarestorage.com',accessKeyId:'fixture',secretAccessKey:'fixture'})),prepareConversationProductImage};
  const recoveryShopHeader={schemaVersion:1 as const,shopId:'shop',name:'Fixture Store',websiteUrl:'https://shop.example'};
  const headerPrefix='Fixture Store\nhttps://shop.example\n──────────\n\n';
  const service=new ConversationWrapperService({repository:{loadContext:async()=>({...context,conversationLanguageTag:'en',recoveryShopHeader}),loadSlots:async()=>[active]},mediaDependencies:mediaDependencies as never});
  const request={...input,responseBody:'My grounded, natural answer.',commercePresentation:{envelope:{...exampleFinal,answerKind:'ANSWER' as const,referralReason:null,replyText:'My grounded, natural answer.',details:{productDetailSelections:pairs}},verified:{...presentation('').verified,locale:'en' as const,disposition:'PRODUCT_DETAILS' as const,productFacts:facts.productFacts},verifiedProducts:{shopId:'shop',platform,products},deadlineAt:Date.now()+10000}};
  const result=await service.renderConversationResponse(request);expect(result.kind).toBe('rendered');if(result.kind!=='rendered')return;
  expect(result.body).toBe(headerPrefix+'Header\nMy grounded, natural answer.\nFooter');expect(result.presentedPairs).toEqual(pairs);
  expect(prepareConversationProductImage).toHaveBeenCalledTimes(1);expect(prepareConversationProductImage.mock.calls[0]?.[0]).toMatchObject({source:{shopId:'shop',...pairs[0]}});
  expect(result.deliveryPlan).toEqual(buildConversationDeliveryPlan({body:result.body,binding:projection.productImage as never,image,shopId:'shop',displayedPairs:pairs}).plan);
  await service.renderConversationResponse({...request,previousApplication:result});expect(prepareConversationProductImage).toHaveBeenCalledTimes(1);
  const missing={...request,commercePresentation:{...request.commercePresentation,verifiedProducts:{...request.commercePresentation.verifiedProducts,products:products.map((product,index)=>index===0?{...product,imageUrl:null}:product)}}};
  expect((await service.renderConversationResponse(missing))).toMatchObject({deliveryPlan:{kind:'TEXT',body:result.body}});expect(prepareConversationProductImage).toHaveBeenCalledTimes(1);
  const longReply='Grounded description. '.repeat(55);
  const longResult=await service.renderConversationResponse({...request,responseBody:longReply,commercePresentation:{...request.commercePresentation,envelope:{...request.commercePresentation.envelope,replyText:longReply}}});
  expect(longResult).toMatchObject({kind:'rendered',recoveryShopHeader,deliveryPlan:{kind:'TEXT'}});
  if(longResult.kind==='rendered')expect(longResult.deliveryPlan?.body).toBe(longResult.body);

 });
});

it('retains the exact shared composition refusal with a non-null failure code',async()=>{
 const {service,logger}=harness([]);
 const rejected=presentation('Hello');rejected.envelope.answerKind='ANSWER';rejected.envelope.referralReason=null;rejected.envelope.details={productDetailSelections:[{productId:'unverified',variantId:null}]};
 expect(await service.renderConversationResponse({...input,commercePresentation:rejected})).toMatchObject({kind:'rejected',reason:'UNOBSERVED_SELECTION'});
 expect(logger.info).toHaveBeenCalledWith('commerce.response.composition',expect.objectContaining({failureCode:'INVALID_FINAL',failureStage:'response.compose',reasonCode:'UNOBSERVED_SELECTION'}));
});

describe("ARCH-073 configured recovery identity",()=>{
 const receipt={schemaVersion:1 as const,shopId:"shop",name:"Eugene Fixture",websiteUrl:"https://shop.example"};
 const current={...context,conversationLanguageTag:"en",variables:{"shop.name":receipt.name},recoveryShopHeader:receipt};
 const prefix="Eugene Fixture\nhttps://shop.example\n──────────\n\n";
 function identitySlot(custom:boolean) {
  const chosen=slot("SHARED");
  const projection={...prepared,header:custom?[{kind:"text" as const,value:"Welcome to "},{kind:"variable" as const,name:"shop.name" as const}]:[{kind:"variable" as const,name:"shop.name" as const}]};
  const hash=digest(stableJson(projection));
  return {...chosen,definition:{...chosen.definition,locales:chosen.definition.locales.map(locale=>({...locale,localeAst:{schemaVersion:1,prepared:projection},contentHash:hash}))}};
 }
 it.each(["AI","HUMAN"] as const)("deduplicates only a proven pure-identity configured header for %s",async source=>{
  const service=harness([identitySlot(false)],current).service;
  const rendered=await service.renderConversationResponse({...input,source});
  expect(rendered).toMatchObject({kind:"rendered",recoveryShopHeader:receipt});
  if(rendered.kind!=="rendered")throw new Error("render failed");
  expect(rendered.body).toBe(prefix+response+"\nFooter");
  const replay=await service.renderConversationResponse({...input,source,previousApplication:rendered});
  expect(replay).toMatchObject({kind:"rendered",body:rendered.body,replayed:true,recoveryShopHeader:receipt});
  const {recoveryShopHeader:_receipt,...lost}=rendered;
  expect(await service.renderConversationResponse({...input,source,previousApplication:lost})).toEqual({kind:"rejected",reason:"REPLAY_MISMATCH"});
 });
 it("preserves custom merchant header prose and authored body identity",async()=>{
  const service=harness([identitySlot(true)],current).service;
  const rendered=await service.renderConversationResponse({...input,source:"HUMAN",responseBody:"Eugene Fixture\nStaff words"});
  expect(rendered).toMatchObject({kind:"rendered",body:prefix+"Welcome to Eugene Fixture\nEugene Fixture\nStaff words\nFooter"});
 });
 it("renders safe domain-only identity for a second tenant without copying another name",async()=>{
  const second={...current,shopId:"other",recoveryShopHeader:{...receipt,shopId:"other",name:null,websiteUrl:"https://other.example"},variables:{}};
  const rendered=await harness([slot("SHARED")],second).service.renderConversationResponse(input);
  expect(rendered).toMatchObject({kind:"rendered",body:"https://other.example\n──────────\n\nHeader\n"+response+"\nFooter"});
 });
});
