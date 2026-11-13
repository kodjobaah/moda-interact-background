import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { describe,it,expect,vi } from 'vitest';
import { buildRecoveryMultipartDeliveryPlan,digestRecoveryMultipartDeliveryPlan,type PreparedWrapper,type CommonRecoveryLayoutReference } from '@modainteract/moda-interact-shared/commerce/presentation';
import { humanDispatchFixture } from './fixtures/recovery-human-dispatch.fixture.js';
import { RecoveryMultipartDeliveryEngine } from '../../src/services/recovery-multipart/engine.js';
import { deliveryDeadline,sha256,humanMultipartMessageId,type FrozenMultipart } from '../../src/services/recovery-multipart/frozen.js';
import { commonLayoutVariables,renderCommonLayoutBoundaries,commonLayoutBody,humanCommonLayoutApplicationKey,type CommonLayoutReceipt } from '../../src/services/recovery-multipart/common-layout.js';
import { digest,stableJson } from '../../src/services/conversation-wrappers/projection.js';
import { OutboundSendFenceService } from '../../src/services/recovery-conversation/outbound-send-fence.service.js';
import { recoveryRuntimeEligibility } from '../../src/services/recovery-conversation/recovery-runtime-eligibility.service.js';
import { OutboundAdmissionReservationService } from '../../src/services/outbound-whatsapp-admission/outbound-admission-reservation.service.js';
import { moderationConfig } from '../../src/services/conversation-moderation/moderation-policy.js';
const suite=process.env.TEST_DATABASE_URL&&process.env.REDIS_URL&&process.env.MODA_DISPOSABLE_INTEGRATION==='1'?describe:describe.skip;
const answer='  Original authored body\nhttps://other.example/product\nUnchanged trailing spaces.  ';
const prepared:PreparedWrapper={schemaVersion:1,family:'MODA_CONVERSATION_WRAPPER',responseSlot:'response.body',header:[{kind:'text',value:'Our custom welcome: '},{kind:'variable',name:'shop.name'},{kind:'text',value:'\nVisit the store: '},{kind:'variable',name:'shop.websiteUrl'}],body:[{kind:'responseSlot',name:'response.body'}],footer:[],conditionals:[{when:'checkout.available',tokens:[{kind:'text',value:'\nCustom checkout footer\n'},{kind:'variable',name:'checkout.url'}]}]};
async function fixture(label:string,actor:'AGENT'|'HUMAN'='AGENT',freezeGroup=true,assess=true){
 const f=await humanDispatchFixture(`arch075v2-${label}`,{checkoutLifetimeDays:7,recipient:'447400123456'});
 let billingPlanId:string|undefined;let adminId:string|undefined;const definitionIds:string[]=[];
 const cleanup=async()=>{await f.db.whatsAppConversationWrapperActiveSlot.deleteMany({where:{definitionId:{in:definitionIds}}});await f.db.whatsAppTemplateLocale.deleteMany({where:{definitionId:{in:definitionIds}}});await f.db.whatsAppTemplateDefinition.deleteMany({where:{id:{in:definitionIds}}});if(adminId)await f.db.platformAdmin.delete({where:{id:adminId}});await f.db.subscription.deleteMany({where:{shopId:f.shopId}});if(billingPlanId)await f.db.billingPlan.delete({where:{id:billingPlanId}});await f.close();};
 try{
  const domain=`${f.shopId}.example.test`.toLowerCase(),url=`https://${domain}/checkouts/trusted`;
  await f.db.shop.update({where:{id:f.shopId},data:{onboardingCompleted:true}});await f.db.shopBrand.create({data:{shopId:f.shopId,brandName:'  Common Shop Name  '}});
  const customer=await f.db.customer.create({data:{shopId:f.shopId,phone:`+${f.recipient}`}});const observed=new Date();
  const phone=await f.db.customerPhone.create({data:{customerId:customer.id,phone:`+${f.recipient}`,whatsappCanonicalPhone:f.recipient,whatsappPhoneVerifiedAt:observed,whatsappConsentDecision:'GRANTED',whatsappConsentSource:'SHOPIFY_NATIVE',whatsappConsentVerifiedAt:observed,whatsappConsentProviderObservedAt:observed,whatsappConsentRevision:1n,whatsappConsentDecisionSequence:1n}});
  await f.db.checkoutRecovery.update({where:{id:f.recoveryId},data:{checkoutUrl:url,customerId:customer.id}});
  const billingPlan=await f.db.billingPlan.create({data:{shopifyPlanHandle:`free-${randomUUID()}`,name:'Free common plan',kind:'FREE'}});billingPlanId=billingPlan.id;
  await f.db.subscription.create({data:{shopId:f.shopId,planId:billingPlan.id,status:'ACTIVE',observedShopifyPlanHandle:billingPlan.shopifyPlanHandle}});await f.db.shopEntitlementCounter.create({data:{shopId:f.shopId,counter:'LIFETIME_FREE_RECOVERY_CREDITS',grantedQuantity:5,committedQuantity:0,reservedQuantity:0}});
  await f.db.backgroundRuntimeConfig.upsert({where:{id:'default'},create:{id:'default',checkoutRecoveryLifetimeDays:7},update:{checkoutRecoveryLifetimeDays:7}});
  await f.db.platformBillingPolicy.upsert({where:{id:'default'},create:{absoluteOutboundHardLimit:20,defaultWarningPercent:80,defaultOutboundSoftLimit:10,defaultOutboundHardLimit:20,terminalMessageReservedSlots:1},update:{absoluteOutboundHardLimit:20,defaultWarningPercent:80,defaultOutboundSoftLimit:10,defaultOutboundHardLimit:20,terminalMessageReservedSlots:1,globalPauseAutomatedWhatsapp:false}});
  adminId=randomUUID();await f.db.platformAdmin.create({data:{id:adminId,email:`common-${adminId}@example.test`,role:'SUPER_ADMIN'}});
  const publish=async()=>{
   const definition=await f.db.whatsAppTemplateDefinition.create({data:{kind:'MODA_CONVERSATION_WRAPPER',audience:'SHARED',sourceLanguageTag:'en',astSchemaVersion:1,sourceHash:digest(`source-${randomUUID()}`),status:'PUBLISHED',publishedAt:new Date(),createdByAdminId:adminId!}});definitionIds.push(definition.id);
   const contentHash=digest(stableJson(prepared));const locale=await f.db.whatsAppTemplateLocale.create({data:{definitionId:definition.id,languageTag:'en',status:'SOURCE_SAVED',contentHash,localeAst:{schemaVersion:1,prepared}}});
   return {definition,locale};
  };
  const published=await publish();await f.db.whatsAppConversationWrapperActiveSlot.create({data:{audience:'SHARED',definitionId:published.definition.id,editVersion:1,updatedByAdminId:adminId}});
  const commonRef:CommonRecoveryLayoutReference={schemaVersion:1,definitionId:published.definition.id,sourceHash:published.definition.sourceHash,localeId:published.locale.id,languageTag:'en',contentHash:published.locale.contentHash!,prepared};
  const variables=commonLayoutVariables(f.shopId,domain,'  Common Shop Name  ',url)!;const boundaries=renderCommonLayoutBoundaries(commonRef,variables,answer,f.shopId,f.conversationId)!;
  const common:CommonLayoutReceipt={schemaVersion:2,kind:'RECOVERY_COMMON_LAYOUT',shopId:f.shopId,commonRef,variables,boundaries};const body=commonLayoutBody(common);
  const commandId=await f.addCommand({textBody:answer});const initial=await f.db.recoveryOutreachAttempt.findFirstOrThrow({where:{checkoutRecoveryId:f.recoveryId,sequence:1}});await f.db.conversationMessage.update({where:{id:initial.outboundMessageId!},data:{providerMessageId:`initial-${randomUUID()}`}});
  let command:FrozenMultipart['command']=null,messageId:string,revision:number;
  if(actor==='HUMAN'){
   const claim=(await f.commands.claimDueHumanCommands({limit:100,now:new Date()})).find(x=>x.id===commandId)!;command={id:commandId,leaseToken:claim.leaseToken};messageId=humanMultipartMessageId(commandId);revision=1;
   const evidence={schemaVersion:1,outcome:'RENDERED',audience:'SHARED',wrapperDefinitionId:commonRef.definitionId,localeId:commonRef.localeId,contentHash:commonRef.contentHash,slotEditVersion:1,applicationKey:humanCommonLayoutApplicationKey({commandId,conversationId:f.conversationId,shopId:f.shopId,slotEditVersion:1,textBody:answer,body,receipt:common}),bodySha256:digest(body),recoveryCheckoutUrl:url,recoveryShopHeader:common};
   await f.db.merchantConversationSendCommand.update({where:{id:commandId},data:{preparedTextBody:body,preparedWrapperEvidence:evidence,preparedAt:new Date()}});
  }else{
   await f.db.merchantConversationSendCommand.delete({where:{id:commandId}});await f.changeOwner('HUMAN','AI',1);revision=2;await f.db.conversation.update({where:{id:f.conversationId},data:{inboundVersion:1}});
   const reserved=await new OutboundAdmissionReservationService(f.db).reserve({shopId:f.shopId,conversationId:f.conversationId,idempotencyKey:`v2-${randomUUID()}`,senderType:'AGENT'});if(reserved.kind!=='admitted')throw new Error('normal admission refused');expect(reserved.executionScope).toBe('general');messageId=reserved.messageId;await f.db.conversationMessage.update({where:{id:messageId},data:{content:body}});
  }
  const plan=buildRecoveryMultipartDeliveryPlan({checkoutUrl:url,parts:[{role:'HEADER',plan:{schemaVersion:1,kind:'TEXT',body:boundaries.header+boundaries.footer}},{role:'ANSWER',plan:{schemaVersion:1,kind:'TEXT',body:boundaries.body+boundaries.footer}}]});const now=new Date();
  const source:FrozenMultipart={schemaVersion:1,kind:'RECOVERY_MULTIPART_PREPARATION',messageId,body,checkoutUrl:url,recipient:f.recipient,recoveryId:f.recoveryId,actor,receipt:{sourceKind:actor==='HUMAN'?'HUMAN_COMMAND':'MESSAGE',sourceId:command?.id??messageId,shopId:f.shopId,conversationId:f.conversationId,controlRevision:revision,inboundVersion:actor==='HUMAN'?0:1,firstPair:null},recoveryShopHeader:common,policyRef:null,command,sender:{providerAccountId:'account',providerPhoneNumberId:'phone'},plan,planDigest:digestRecoveryMultipartDeliveryPlan(plan,sha256),frozenAt:now.toISOString(),deadlineAt:deliveryDeadline(now).toISOString()};
  const provider={sendWhatsAppText:vi.fn(async()=>({providerMessageId:`v2-${randomUUID()}`})),sendWhatsAppImage:vi.fn(async()=>({providerMessageId:`image-${randomUUID()}`}))};
  const engine=new RecoveryMultipartDeliveryEngine(f.db,provider,new OutboundSendFenceService(f.db,recoveryRuntimeEligibility),async()=>{},undefined,{preflight:async()=>({kind:'allowed',snapshot:{customerPhoneId:phone.id,canonicalRecipient:f.recipient,consentRevision:1n,noContactRevision:0n}})});
  if(freezeGroup)await engine.freeze(source);
  const approve=()=>f.persistedAllowModeration().assessText({subject:actor==='HUMAN'?{kind:'HUMAN_COMMAND',commandId}:{kind:'AGENT_MESSAGE',messageId},shopId:f.shopId,conversationId:f.conversationId,effectiveText:body,inputKind:'TEXT',policyVersion:moderationConfig().policyVersion,now});
  if(assess)await approve();
  const list=()=>f.db.conversationDeliveryPart.findMany({where:{messageId},orderBy:{ordinal:'asc'}});
  const delivered=async(i:number)=>{const part=(await list())[i]!;await engine.observe({schemaVersion:2,...source.sender,providerMessageId:part.providerMessageId!,status:'DELIVERED',occurredAt:new Date().toISOString()});};
  return {...f,engine,source,common,provider,list,delivered,publish,approve,close:cleanup};
 }catch(error){await cleanup();throw error;}
}
suite('ARCH075 real v2 common source reader and HUMAN frozen compatibility',()=>{
 it.each(['AGENT','HUMAN'] as const)('sends %s exact custom common frame while retaining complete body and original HUMAN policy',async actor=>{const f=await fixture(actor,actor);try{
  expect(await f.engine.continue(f.source.messageId)).toBe('acknowledged');if(actor==='HUMAN')expect((await f.commandState(f.source.command!.id))!.state).toBe('DISPATCH_ADMITTED');
  await f.delivered(0);if(actor==='HUMAN')await f.db.conversation.update({where:{id:f.conversationId},data:{inboundVersion:7}});await f.engine.continue(f.source.messageId);
  expect(f.provider.sendWhatsAppText.mock.calls.map(x=>(x[0] as {text:string}).text)).toEqual([f.common.boundaries.header+f.common.boundaries.footer,answer+f.common.boundaries.footer]);
  const root=await f.db.conversationMessage.findUniqueOrThrow({where:{id:f.source.messageId}});expect(root.content).toBe(f.source.body);expect(root.content).not.toContain('──────────');expect(root.content).toContain('Our custom welcome: Common Shop Name');expect(root.status).toBe('SENT');if(actor==='HUMAN')expect((await f.commandState(f.source.command!.id))!.state).toBe('SENT');
 }finally{await f.close();}},120000);
 it.each(['active-source','name','website','checkout'] as const)('refuses stale current %s after header without re-rendering the tail',async variant=>{const f=await fixture(variant);try{
  await f.engine.continue(f.source.messageId);await f.delivered(0);
  if(variant==='active-source'){const next=await f.publish();await f.db.whatsAppConversationWrapperActiveSlot.update({where:{audience:'SHARED'},data:{definitionId:next.definition.id,editVersion:{increment:1}}});}
  if(variant==='name')await f.db.shopBrand.update({where:{shopId:f.shopId},data:{brandName:'New saved name'}});
  if(variant==='website')await f.db.shop.update({where:{id:f.shopId},data:{domain:`changed-${f.shopId}.example.test`.toLowerCase()}});
  if(variant==='checkout')await f.db.checkoutRecovery.update({where:{id:f.recoveryId},data:{checkoutUrl:`${f.common.variables['shop.websiteUrl']}/checkouts/changed`}});
  expect(await f.engine.continue(f.source.messageId)).toBe('cancelled');expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(1);expect((await f.list()).map(p=>p.state)).toEqual(['DELIVERED','CANCELLED']);expect(await f.db.usageEvent.count({where:{sourceId:f.source.messageId}})).toBe(1);
 }finally{await f.close();}},120000);
 it('repair waits for the exact current moderation allowance after freeze, then resumes without resetting authority/deadline',async()=>{const f=await fixture('moderation-gap','AGENT',true,false);try{
  const original=(await f.list()).map(p=>({sourceIdentity:p.sourceIdentity,deadlineAt:p.deadlineAt,payload:p.payload}));
  expect(await f.engine.continue(f.source.messageId)).toBe('waiting');expect((await f.list()).map(p=>p.state)).toEqual(['PREPARED','PREPARED']);expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();
  expect((await f.approve()).kind).toBe('allow');expect(await f.engine.continue(f.source.messageId)).toBe('acknowledged');expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(1);expect((await f.list()).map(p=>({sourceIdentity:p.sourceIdentity,deadlineAt:p.deadlineAt,payload:p.payload}))).toEqual(original);
 }finally{await f.close();}},120000);
 it('the v2 HUMAN reader resumes a frozen root before assessment through existing moderation before ordered dispatch',async()=>{const f=await fixture('human-moderation-gap','HUMAN',true,false);try{
  expect(await f.db.conversationModerationAssessment.count({where:{merchantSendCommandId:f.source.command!.id}})).toBe(0);
  await f.dispatcher(undefined,undefined,undefined,undefined,{multipart:f.engine}).processClaim(f.source.command!.id,f.source.command!.leaseToken);
  const assessment=await f.db.conversationModerationAssessment.findFirstOrThrow({where:{merchantSendCommandId:f.source.command!.id}});expect(assessment.decision).toBe('ALLOW');expect(assessment.contentSha256).toBe(digest(f.source.body));
  expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(1);expect(f.provider.sendWhatsAppText.mock.calls[0]?.[0]).toMatchObject({text:f.common.boundaries.header+f.common.boundaries.footer});expect(f.providerHttpRequests).toHaveLength(0);expect((await f.commandState(f.source.command!.id))!.state).toBe('DISPATCH_ADMITTED');expect((await f.list()).map(p=>p.state)).toEqual(['ACKNOWLEDGED','PREPARED']);
 }finally{await f.close();}},120000);
 it('an old reader preserves a v2 HUMAN producer crash gap, then a valid prepermit reclaim can complete the frozen group',async()=>{const f=await fixture('human-crash-gap','HUMAN',false);try{
  const id=f.source.command!.id;const before=await f.db.merchantConversationSendCommand.findUniqueOrThrow({where:{id}});
  await f.dispatcher(undefined,undefined,undefined,undefined,{multipart:f.engine}).processClaim(id,f.source.command!.leaseToken);
  const deferred=await f.db.merchantConversationSendCommand.findUniqueOrThrow({where:{id}});expect(deferred.state).toBe('FAILED');expect(deferred.failureCode).toBe('multipart_root_not_prepared');expect(deferred.preparedTextBody).toBe(before.preparedTextBody);expect(deferred.preparedWrapperEvidence).toEqual(before.preparedWrapperEvidence);expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();expect(f.provider.sendWhatsAppImage).not.toHaveBeenCalled();
  const claim=(await f.commands.claimDueHumanCommands({limit:100,now:new Date(Date.now()+6000)})).find(x=>x.id===id)!;
  await f.engine.freeze({...f.source,command:{id,leaseToken:claim.leaseToken}});await f.engine.continue(f.source.messageId);await f.delivered(0);await f.engine.continue(f.source.messageId);expect((await f.commandState(id))!.state).toBe('SENT');expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(2);
 }finally{await f.close();}},120000);
});
