import { describe, expect, it } from "vitest";
import { ConversationWrapperService } from "../../../../src/services/conversation-wrappers/service.js";
import { RECOVERY_CHECKOUT_DIVIDER, RECOVERY_CHECKOUT_SEPARATOR } from "../../../../src/services/conversation-wrappers/recovery-checkout-footer.js";

const url = "https://shop.example/checkouts/recover?key=fixture";
const header = {schemaVersion: 1 as const, shopId: "shop", name: "Fixture Store", websiteUrl: "https://shop.example"};
const context = {conversationId: "conversation", shopId: "shop", conversationLanguageTag: "en", merchantLanguageTag: "en", variables: {"shop.name": header.name, "checkout.url": url}, checkoutAvailable: true, recoveryShopHeader: header};
const input = {conversationId: "conversation", messageIdentity: "message", source: "AI" as const, responseBody: "Grounded answer."};
const prefix = `${header.name}\n${header.websiteUrl}\n${RECOVERY_CHECKOUT_DIVIDER}\n\n`;

describe("ARCH-073 verified recovery shop headers", () => {
 it("adds the same-shop name and website before the body and existing recovery footer", async () => {
  const service = new ConversationWrapperService({repository: {loadContext: async () => context, loadSlots: async () => []}, onMissingSlot: "passthrough"});
  expect(await service.renderConversationResponse(input)).toMatchObject({kind: "no-wrapper", body: prefix + input.responseBody + RECOVERY_CHECKOUT_SEPARATOR + url});
 });
});

import { readRecoveryShopHeader, verifiedRecoveryShopHeader, prepareRecoveryReplyBody, recoveryShopHeaderPrefix } from "../../../../src/services/conversation-wrappers/recovery-shop-header.js";
import { HumanWrapperPreparationService } from "../../../../src/services/recovery-conversation/human-wrapper-preparation.service.js";
import { composeAiOutbound } from "../../../../src/services/conversation-wrappers/compose-ai-outbound.js";
import { wrapperApplicationKey } from "../../../../src/services/conversation-wrappers/application-key.js";
import { parsePreparedEvidence } from "../../../../src/services/recovery-conversation/human-prepared-command.service.js";
import { digest } from "../../../../src/services/conversation-wrappers/projection.js";

describe("trusted header boundaries", () => {
 it.each([null, "", "bad\nname", "<markup>", "x".repeat(513), "bad\u202ename", "bad\u200fname", "bad\u009fname"])("uses verified domain only for unsafe/missing name %j", name => {
  expect(verifiedRecoveryShopHeader("shop", "SHOP.example", name)).toEqual({...header, name: null});
 });
 it("preserves legitimate punctuation and names within the existing Shared bound",()=>{expect(verifiedRecoveryShopHeader("shop","shop.example","A_Boutique & Co.")).toEqual({...header,name:"A_Boutique & Co."});expect(verifiedRecoveryShopHeader("shop","shop.example","x".repeat(512))?.name).toHaveLength(512);});
 it.each(["https://shop.example/path", "https://shop.example?query=1", "https://user@shop.example", "http://shop.example", "shop.example:443", "shop.example\\bad"])("does not promote unsafe website %s", domain => {
  expect(verifiedRecoveryShopHeader("shop", domain, "Store")).toBeNull();
 });
 it("rejects malformed or cross-tenant identity without modifying content", () => {
  expect(readRecoveryShopHeader({...header, extra: true})).toBeNull();
  expect(prepareRecoveryReplyBody({body: "Hello", source: "AI", context: {...context, recoveryShopHeader: {...header, shopId: "other"}}})).toEqual({kind:"rejected", reason:"TENANT_MISMATCH"});
 });
 it("preserves unbound replies and authored staff bytes", async () => {
  const staff = "  Thanks!\nFixture Store\nThis is my authored explanation.  ";
  const service = new ConversationWrapperService({repository: {loadContext: async () => context, loadSlots: async () => []}, onMissingSlot:"passthrough"});
  const result = await new HumanWrapperPreparationService(service).prepare({id:"command", conversationId:"conversation", kind:"HUMAN_TEXT", textBody:staff});
  expect(result).toMatchObject({kind:"passthrough", recoveryShopHeader:header});
  if(result.kind !== "passthrough") throw new Error("preparation refused");
  expect(result.body.startsWith(prefix + staff)).toBe(true);
  const {recoveryShopHeader: _header, ...unbound} = context;
  const {checkoutAvailable: _checkout, ...base} = unbound;
  expect(prepareRecoveryReplyBody({body:staff, source:"HUMAN", context:{...base,checkoutAvailable:false}})).toEqual({kind:"ready",body:staff});
 });
 it("includes header in the final text limit", () => {
  expect(prepareRecoveryReplyBody({body:"x".repeat(4000), source:"AI", context})).toEqual({kind:"rejected",reason:"OUTPUT_TOO_LONG"});
 });
 it("binds header into rendered provenance and rejects receipt loss/mutation", async () => {
  const body = prefix + input.responseBody;
  const application = {kind:"rendered" as const, body, wrapperDefinitionId:"definition",localeId:"locale",audience:"AI" as const,slotEditVersion:1,languageTag:"en",contentHash:"hash",messageIdentity:"message",source:"AI" as const,responseDigest:digest(input.responseBody),replayed:false,recoveryShopHeader:header};
  const key = wrapperApplicationKey({conversationId:"conversation",...application,editVersion:1});
  const wrapped = {...application,applicationKey:key};
  expect(await composeAiOutbound({renderConversationResponse:async()=>wrapped},{conversationId:"conversation",messageId:"message",generatedResponse:input.responseBody})).toMatchObject({kind:"ready",recoveryShopHeader:header});
  const {recoveryShopHeader:_receipt,...lost} = wrapped;
  await expect(composeAiOutbound({renderConversationResponse:async()=>lost},{conversationId:"conversation",messageId:"message",generatedResponse:input.responseBody})).rejects.toThrow("PROVENANCE_MISMATCH");
  await expect(composeAiOutbound({renderConversationResponse:async()=>({...wrapped,recoveryShopHeader:{...header,name:"Other"}})},{conversationId:"conversation",messageId:"message",generatedResponse:input.responseBody})).rejects.toThrow("PROVENANCE_MISMATCH");
 });
 it("retains the receipt in durable human evidence and rejects malformed prefix", () => {
  const body = prefix + "Staff response";
  const evidence = {schemaVersion:1,outcome:"PASSTHROUGH",reason:"NOT_CONFIGURED",bodySha256:digest(body),recoveryShopHeader:header};
  expect(parsePreparedEvidence(body,JSON.parse(JSON.stringify(evidence)),new Date())).toEqual(evidence);
  expect(parsePreparedEvidence(body,{...evidence,recoveryShopHeader:{...header,name:"Other"}},new Date())).toBeNull();
  expect(recoveryShopHeaderPrefix({...header,name:null})).toBe(header.websiteUrl+"\n"+RECOVERY_CHECKOUT_DIVIDER+"\n\n");
 });
});
