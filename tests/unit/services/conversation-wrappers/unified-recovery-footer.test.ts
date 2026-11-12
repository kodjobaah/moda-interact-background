import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ConversationWrapperService } from "../../../../src/services/conversation-wrappers/service.js";
import { HumanWrapperPreparationService } from "../../../../src/services/recovery-conversation/human-wrapper-preparation.service.js";
import { HumanPreparedCommandService, currentHumanWrapperMatches } from "../../../../src/services/recovery-conversation/human-prepared-command.service.js";
import { RECOVERY_CHECKOUT_SEPARATOR, withHumanRecoveryCheckoutFooter, withRecoveryCheckoutFooter } from "../../../../src/services/conversation-wrappers/recovery-checkout-footer.js";
import { digest, stableJson } from "../../../../src/services/conversation-wrappers/projection.js";
import type { PreparedWrapper, WrapperSlot } from "../../../../src/services/conversation-wrappers/contracts.js";

const url = "https://shop.example/checkouts/recover?key=synthetic";
const context = { conversationId:"conversation",shopId:"shop",conversationLanguageTag:"en",merchantLanguageTag:"en",variables:{"checkout.url":url},checkoutAvailable:true };
const claim = {id:"command",conversationId:"conversation",shopId:"shop",kind:"HUMAN_TEXT" as const,textBody:"  Staff text with formatting *unchanged*.\n"};
const sha = (value:string) => createHash("sha256").update(value).digest("hex");
const prepared: PreparedWrapper = {schemaVersion:1,family:"MODA_CONVERSATION_WRAPPER",responseSlot:"response.body",header:[],body:[{kind:"responseSlot",name:"response.body"}],footer:[],conditionals:[]};
function slot():WrapperSlot {
 return {audience:"HUMAN",definitionId:"definition",editVersion:1,definition:{id:"definition",kind:"MODA_CONVERSATION_WRAPPER",audience:"HUMAN",status:"PUBLISHED",sourceLanguageTag:"en",astSchemaVersion:1,sourceHash:"a".repeat(64),publishedAt:new Date(),retiredAt:null,createdByAdminId:"admin",locales:[{id:"locale",languageTag:"en",status:"SOURCE_SAVED",providerLanguageCode:null,localeAst:{schemaVersion:1,prepared},contentHash:digest(stableJson(prepared)),reviewedAt:null,reviewedByAdminId:null}]}};
}
function renderer(configured=false) {return new ConversationWrapperService({repository:{loadContext:async()=>context,loadSlots:async()=>configured?[slot()]:[]},onMissingSlot:"passthrough"});}

describe("unified recovery checkout footer",()=>{
 it.each([false,true])("prepares a HUMAN footer before freezing with configured=%s",async configured=>{
  const body="Staff text with formatting *unchanged*.";
  const command={...claim,textBody:body};
  const result=await new HumanWrapperPreparationService(renderer(configured)).prepare(command);
  expect(["passthrough","prepared"]).toContain(result.kind);
  if(result.kind!=="passthrough"&&result.kind!=="prepared")throw new Error("expected prepared human body");
  expect(result.body).toBe(body+RECOVERY_CHECKOUT_SEPARATOR+url);
  expect(result.body.startsWith(body)).toBe(true);
 });
 it("preserves authored whitespace and embedded checkout URLs without rewriting staff content",()=>{
  const authored=claim.textBody+`An existing link: ${url}`;
  const body=withHumanRecoveryCheckoutFooter(authored,url);
  expect(body).toBe(authored+RECOVERY_CHECKOUT_SEPARATOR+url);
  expect(withHumanRecoveryCheckoutFooter(body,url)).toBe(body);
  expect(withRecoveryCheckoutFooter("Answer.\nVotre panier: "+url,url)).toBe("Answer."+RECOVERY_CHECKOUT_SEPARATOR+"Votre panier: "+url);
 });
 it("freezes trusted no-slot augmentation once and validates the exact transform at final admission",async()=>{
  const state:any={kind:"HUMAN_TEXT",conversationId:claim.conversationId,textBody:claim.textBody,preparedTextBody:null,preparedWrapperEvidence:null,preparedAt:null};
  const query=vi.fn(async(sql:string,...values:any[])=>{
   if(sql.includes('UPDATE "whatsapp"')){state.preparedTextBody=values[3];state.preparedWrapperEvidence=JSON.parse(values[4]);state.preparedAt=new Date();}
   return[{...state}];
  });
  const preparer=new HumanWrapperPreparationService(renderer());const spy=vi.spyOn(preparer,"prepare");
  const service=new HumanPreparedCommandService({$queryRawUnsafe:query} as never,preparer);
  const first=await service.freeze(claim,"lease");
  expect(first).toMatchObject({kind:"frozen",body:claim.textBody+RECOVERY_CHECKOUT_SEPARATOR+url,evidence:{outcome:"PASSTHROUGH",recoveryCheckoutUrl:url}});
  expect(await service.freeze(claim,"lease")).toEqual(first);expect(spy).toHaveBeenCalledTimes(1);
  const noSlots={$queryRawUnsafe:vi.fn(async()=>[])};
  const identity={conversationId:claim.conversationId,commandId:claim.id,textBody:claim.textBody};
  expect(await currentHumanWrapperMatches(noSlots as never,state.preparedTextBody,state.preparedWrapperEvidence,state.preparedAt,identity)).toBe(true);
  expect(await currentHumanWrapperMatches(noSlots as never,state.preparedTextBody,state.preparedWrapperEvidence,state.preparedAt)).toBe(false);
  expect(await currentHumanWrapperMatches(noSlots as never,state.preparedTextBody,state.preparedWrapperEvidence,state.preparedAt,{...identity,textBody:"Different author text"})).toBe(false);
  state.preparedWrapperEvidence={...state.preparedWrapperEvidence,recoveryCheckoutUrl:"https://other.example/checkouts/recover"};
  expect(await service.freeze(claim,"lease")).toEqual({kind:"refused",reason:"prepared_invalid"});
 });
 it("does not accept an arbitrary modified no-wrapper body merely because a URL receipt exists",async()=>{
  const preparer=new HumanWrapperPreparationService({renderConversationResponse:async()=>({kind:"no-wrapper",reason:"NOT_CONFIGURED",body:"Changed author content"+RECOVERY_CHECKOUT_SEPARATOR+url,recoveryCheckoutUrl:url})});
  expect(await preparer.prepare(claim)).toEqual({kind:"refused",reason:"CONTENT_MISMATCH"});
 });
 it("keeps legacy frozen no-footer commands byte-identical without invoking new rendering",async()=>{
  const body=claim.textBody,evidence={schemaVersion:1,outcome:"PASSTHROUGH",reason:"NOT_CONFIGURED",bodySha256:sha(body)};
  const db={$queryRawUnsafe:vi.fn(async()=>[{kind:"HUMAN_TEXT",conversationId:claim.conversationId,textBody:body,preparedTextBody:body,preparedWrapperEvidence:evidence,preparedAt:new Date()}])};
  const prepare=vi.fn();const result=await new HumanPreparedCommandService(db as never,{prepare} as never).freeze(claim,"lease");
  expect(result).toEqual({kind:"frozen",body,evidence});expect(prepare).not.toHaveBeenCalled();
 });
 it("binds configured HUMAN footer URL into final permit evidence while preserving legacy key construction",async()=>{
  const command={...claim,textBody:"Staff answer."};
  const result=await renderer(true).renderConversationResponse({conversationId:claim.conversationId,messageIdentity:claim.id,source:"HUMAN",responseBody:command.textBody});
  if(result.kind!=="rendered")throw new Error("expected configured body");
  const active={audience:"HUMAN",definitionId:"definition",editVersion:1,kind:"MODA_CONVERSATION_WRAPPER",status:"PUBLISHED",definitionAudience:"HUMAN",publishedAt:new Date(),retiredAt:null,sourceLanguageTag:"en",astSchemaVersion:1,sourceHash:"a".repeat(64),createdByAdminId:"admin"};
  const locale={definitionId:"definition",status:"SOURCE_SAVED",contentHash:result.contentHash,languageTag:"en",providerLanguageCode:null,localeAst:{schemaVersion:1,prepared},reviewedAt:null,reviewedByAdminId:null};
  const db={$queryRawUnsafe:vi.fn(async(sql:string)=>sql.includes("WhatsAppConversationWrapperActiveSlot")?[active]:[locale])};
  const evidence={schemaVersion:1,outcome:"RENDERED",wrapperDefinitionId:result.wrapperDefinitionId,localeId:result.localeId,audience:"HUMAN",slotEditVersion:result.slotEditVersion,applicationKey:result.applicationKey,contentHash:result.contentHash,bodySha256:sha(result.body),recoveryCheckoutUrl:url};
  const identity={conversationId:claim.conversationId,commandId:claim.id,textBody:command.textBody};
  expect(await currentHumanWrapperMatches(db as never,result.body,evidence,new Date(),identity)).toBe(true);
  expect(await currentHumanWrapperMatches(db as never,result.body,{...evidence,recoveryCheckoutUrl:"https://other.example/checkout"},new Date(),identity)).toBe(false);
 });
});
