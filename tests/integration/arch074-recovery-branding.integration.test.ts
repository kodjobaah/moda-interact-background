import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { describe,expect,it,vi } from 'vitest';
import { createLogger } from '@modainteract/moda-interact-shared/logging';
import { humanDispatchFixture } from './fixtures/recovery-human-dispatch.fixture.js';
import { ConversationTurnProcessor } from '../../src/services/conversation-turn-processor.service.js';
import { ConversationService } from '../../src/services/conversation.service.js';
import { ConversationWrapperService } from '../../src/services/conversation-wrappers/service.js';
import { composeAiOutbound } from '../../src/services/conversation-wrappers/compose-ai-outbound.js';
import { PrismaConversationWrapperReadRepository } from '../../src/services/conversation-wrappers/repository.js';
import { OutboundAdmissionReservationService } from '../../src/services/outbound-whatsapp-admission/outbound-admission-reservation.service.js';
import { OutboundMessageDeliveryService } from '../../src/services/outbound-whatsapp-admission/outbound-message-delivery.service.js';
import { OutboundProviderFailureService } from '../../src/services/outbound-whatsapp-admission/outbound-provider-failure.service.js';
import { AiTurnOwnershipService } from '../../src/services/recovery-conversation/ai-turn-ownership.service.js';
import { OutboundSendFenceService } from '../../src/services/recovery-conversation/outbound-send-fence.service.js';
import { verifiedReadyConversationBrandImage } from '../../src/services/shop-brand-media-runtime/resolver.js';
import { readFrozenBrandMedia } from '../../src/services/conversation-delivery-plan.js';
import { moderationConfig } from '../../src/services/conversation-moderation/moderation-policy.js';
import { sha256Text } from '../../src/services/conversation-moderation/moderation-assessment.service.js';
const suite=process.env.TEST_DATABASE_URL&&process.env.REDIS_URL&&process.env.MODA_DISPOSABLE_INTEGRATION==='1'?describe:describe.skip;
const hash='a'.repeat(64),fingerprint=`sha256:${'b'.repeat(64)}`,ANSWER='Here are the accessories available from our store.';
function media(domain:string){return {schemaVersion:1,roles:{LOGO:{source:{url:'https://source.example/logo.png',reference:null,generation:3,fingerprint,observedAt:'2026-11-12T09:00:00Z'},work:{status:'READY',attempts:1,retryAfter:null,leaseOwner:null,leaseUntil:null,failureCode:null,lastCheckedAt:'2026-11-12T09:02:00Z'},ready:{sourceGeneration:3,sourceFingerprint:fingerprint,objectKey:`shop-brands/${domain}/logo/sha256-${hash}.jpg`,contentType:'image/jpeg',width:1125,height:600,sizeBytes:42000,contentSha256:hash,verifiedAt:'2026-11-12T09:02:00Z'}}}};}
async function fixture(label:string){
 const f=await humanDispatchFixture(`arch074-${label}`,{checkoutLifetimeDays:7});const domain=`${f.shopId}.example.test`;
 await f.db.shopBrand.create({data:{shopId:f.shopId,brandName:'Free Store',whatsAppMedia:media(domain)}});
 const checkoutUrl=`https://${domain}/checkouts/trusted`;
 await f.db.checkoutRecovery.update({where:{id:f.recoveryId},data:{checkoutUrl}});
 const config=await f.db.platformConfiguration.create({data:{environment:'test',key:'shopBrand.publicMedia',version:1,value:{publicOrigin:'https://brands.example',bucketName:'brand-images'}}});
 const policy={environment:'test',key:'shopBrand.publicMedia' as const,id:config.id,version:1,publicOrigin:'https://brands.example'};
 const resolver=async()=>{const row=await f.db.shopBrand.findUniqueOrThrow({where:{shopId:f.shopId},include:{shop:true}});const image=verifiedReadyConversationBrandImage({shopId:f.shopId,domain:row.shop.domain,role:'LOGO',whatsAppMedia:row.whatsAppMedia,publicOrigin:new URL(policy.publicOrigin)});return image?{image,policyRef:policy}:null;};
 const plan=await f.db.billingPlan.create({data:{shopifyPlanHandle:`free-${randomUUID()}`,name:'Free integration plan',kind:'FREE'}});
 await f.db.subscription.create({data:{shopId:f.shopId,planId:plan.id,status:'ACTIVE',observedShopifyPlanHandle:plan.shopifyPlanHandle}});
 await f.db.shopEntitlementCounter.create({data:{shopId:f.shopId,counter:'LIFETIME_FREE_RECOVERY_CREDITS',grantedQuantity:5,committedQuantity:0,reservedQuantity:0}});
 await f.db.platformBillingPolicy.upsert({where:{id:'default'},create:{absoluteOutboundHardLimit:20,defaultWarningPercent:80,defaultOutboundSoftLimit:10,defaultOutboundHardLimit:20,terminalMessageReservedSlots:1},update:{absoluteOutboundHardLimit:20,defaultWarningPercent:80,defaultOutboundSoftLimit:10,defaultOutboundHardLimit:20,terminalMessageReservedSlots:1,globalPauseAutomatedWhatsapp:false}});
 await f.addCommand({textBody:'Seed verified service window'});await f.changeOwner('HUMAN','AI',1);
 const pendingAt=new Date(Date.now()-30000);
 await f.db.conversation.update({where:{id:f.conversationId},data:{inboundVersion:1,lastProcessedVersion:0,pendingTurnStartedAt:pendingAt,pendingAiNotBeforeAt:pendingAt,pendingAiDelayMinutes:0,pendingAiControlRevision:2}});
 const records:unknown[]=[];const logger=createLogger({serviceName:'arch074-test',environment:'test',sink:record=>{records.push(record);}});
 const wrapper=new ConversationWrapperService({repository:new PrismaConversationWrapperReadRepository(f.db,undefined,{read:async()=>7}),onMissingSlot:'passthrough',logoResolver:resolver,logger});
 const provider={...f.provider,sendWhatsAppImage:vi.fn(async()=>({providerMessageId:`arch074-${randomUUID()}`}))};
 const ownership=new AiTurnOwnershipService(f.db);
 const delivery=new OutboundMessageDeliveryService(f.db,provider,f.execution,ownership,new OutboundSendFenceService(f.db,f.durableEligibility),f.persistedAllowModeration(),undefined,undefined,undefined,undefined,new PrismaConversationWrapperReadRepository(f.db,undefined,{read:async()=>7}),resolver);
 const reservation=new OutboundAdmissionReservationService(f.db);
 const reserve=async(conversationId=f.conversationId)=>{const result=await reservation.reserve({shopId:f.shopId,conversationId,idempotencyKey:`arch074-${randomUUID()}`,senderType:'AGENT'});if(result.kind!=='admitted')throw new Error(`reservation ${result.reason}`);expect(result.executionScope).toBe('general');return result;};
 return {...f,checkoutUrl,provider,delivery,wrapper,reserve,ownership,records,logger,close:async()=>{await f.db.platformConfiguration.delete({where:{id:config.id}});await f.db.subscription.deleteMany({where:{shopId:f.shopId}});await f.db.billingPlan.delete({where:{id:plan.id}});await f.close();}};
}
async function composed(f:Awaited<ReturnType<typeof fixture>>,messageId:string){const result=await composeAiOutbound(f.wrapper,{conversationId:f.conversationId,messageId,generatedResponse:ANSWER});if(result.kind!=='ready'||result.deliveryPlan?.kind!=='BRAND_IMAGE')throw new Error('verified brand composition missing');return result;}
suite('ARCH074 real normal Free contract recovery branding',()=>{
 it('runs actual Free billing policy→processor→delivery→PostgreSQL final fence→one image without relabeling billing',async()=>{
  const f=await fixture('processor');try{
   let reserved:Awaited<ReturnType<typeof f.reserve>>|undefined;
   const send=vi.fn(input=>f.delivery.sendPreparedConversation(input));
   const processor=new ConversationTurnProcessor({queue:{add:async()=>{}},conversation:new ConversationService(),ownership:f.ownership,logger:f.logger,
    admission:{reserve:async()=>{reserved=await f.reserve();return reserved;},sendPreparedText:input=>f.delivery.sendPreparedText(input),sendPreparedConversation:send,failPrepared:id=>f.delivery.failPrepared(id)},
    abuseAdmission:{admitSettledTurn:async()=>({kind:'allowed'})},
    loadTurn:async()=>({shopId:f.shopId,to:f.recipient,customerPhone:f.recipient,conversationType:'RECOVERY',checkoutRecoveryId:f.recoveryId,hasReplyContext:true,context:{conversation:{messages:[{role:'user',content:'What accessories do you have?'}]}},languageMessage:'What accessories do you have?'}),
    aiWrapper:f.wrapper,runAgent:async()=>({replyText:ANSWER,detectedLanguageTag:null,detectedLanguageConfidence:null}),getResult:result=>result,
    runtimeConfig:{current:()=>({conversationQuietWindowMs:0,conversationMaxSettleWindowMs:0})} as never});
   await processor.process({conversationId:f.conversationId,observedVersion:1});
   expect(reserved?.executionScope).toBe('general');expect(send).toHaveBeenCalledOnce();
   const message=await f.db.conversationMessage.findUniqueOrThrow({where:{id:reserved!.messageId}});
   expect(f.provider.sendWhatsAppImage).toHaveBeenCalledOnce();expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();
   expect(message.status).toBe('SENT');expect(message.contentType).toBe('TEXT');expect(message.content).toContain(ANSWER);expect(message.content.startsWith(`Free Store\nhttps://${f.shopId}.example.test\n──────────\n\n`)).toBe(true);expect(message.content.endsWith(f.checkoutUrl)).toBe(true);
   const envelope=readFrozenBrandMedia(message.outboundPresentation);expect(envelope?.receipt).toMatchObject({sourceKind:'MESSAGE',sourceId:message.id,shopId:f.shopId,inboundVersion:1,controlRevision:2});
   expect(f.provider.sendWhatsAppImage).toHaveBeenCalledWith(expect.objectContaining({caption:message.content,link:envelope!.plan.image.publicUrl}));
   expect((await f.db.conversationModerationAssessment.findFirstOrThrow({where:{conversationMessageId:message.id}})).contentSha256).toBe(sha256Text(message.content));
   expect(await f.db.usageEvent.count({where:{sourceId:message.id}})).toBe(1);
   expect((await f.db.conversation.findUniqueOrThrow({where:{id:f.conversationId}})).lastProcessedVersion).toBe(1);
   expect(f.records).toContainEqual(expect.objectContaining({event:'whatsapp.turn.completed',data:expect.objectContaining({outcome:'agent-response-sent'})}));
  }finally{await f.close();}
 },120000);
 for(const variant of ['unbound','foreign-plan','stale-control','stale-inbound'] as const)it(`refuses ${variant} with zero sends and finalizes the owned unused placeholder`,async()=>{
  const f=await fixture(variant);try{
   const target=variant==='unbound'?await f.db.conversation.create({data:{shopId:f.shopId,type:'PRODUCT_SUPPORT'}}):{id:f.conversationId};
   const admission=await f.reserve(target.id),value=await composed(f,admission.messageId);
   const revision=variant==='stale-control'?1:variant==='unbound'?0:2,version=variant==='stale-inbound'?0:variant==='unbound'?0:1;
   const deliveryPlan=variant==='foreign-plan'?{...value.deliveryPlan,image:{...value.deliveryPlan.image,origin:{...value.deliveryPlan.image.origin,shopId:'foreign-shop'}}}:value.deliveryPlan;
   const result=await f.delivery.sendPreparedConversation({...admission,to:f.recipient,text:value.text,recoveryShopHeader:value.recoveryShopHeader,brandMediaPolicy:value.brandMediaPolicy,deliveryPlan,presentationReceipt:{shopId:f.shopId,conversationId:target.id,messageId:admission.messageId,controlRevision:revision,inboundVersion:version,firstPair:null},expectedControlRevision:revision,expectedInboundVersion:version});
   expect(result.kind).toBe('suppressed');expect(f.provider.sendWhatsAppImage).not.toHaveBeenCalled();expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();
   expect((await f.db.conversationMessage.findUniqueOrThrow({where:{id:admission.messageId}})).status).toBe('FAILED');expect(await f.db.usageEvent.count({where:{sourceId:admission.messageId}})).toBe(0);
  }finally{await f.close();}
 },120000);
 for(const variant of ['untouched','foreign','frozen','modified','assessed','permit'] as const)it(`cleanup preserves ${variant} authority and provider boundaries`,async()=>{
  const f=await fixture(`cleanup-${variant}`);try{const admitted=await f.reserve();
   if(variant==='frozen')await f.db.conversationMessage.update({where:{id:admitted.messageId},data:{content:'Concurrent prepared caption',outboundPresentation:{schemaVersion:1,kind:'TEXT',body:'Concurrent prepared caption'}}});
   if(variant==='modified')await f.db.conversationMessage.update({where:{id:admitted.messageId},data:{content:'Concurrent prepared plain text'}});
   if(variant==='permit')await f.db.conversationMessage.update({where:{id:admitted.messageId},data:{providerDispatchKey:`unknown-${randomUUID()}`,providerDispatchAdmittedAt:new Date(),providerDispatchControlRevision:2}});
   const before=await f.db.conversationMessage.findUniqueOrThrow({where:{id:admitted.messageId}});
   if(variant==='assessed')expect((await f.persistedAllowModeration().assessText({subject:{kind:'AGENT_MESSAGE',messageId:admitted.messageId},shopId:f.shopId,conversationId:f.conversationId,effectiveText:before.content,inputKind:'TEXT',policyVersion:moderationConfig().policyVersion,now:new Date()})).kind).toBe('allow');
   const service=new OutboundProviderFailureService(f.db);const fail=service.failPrepared.bind(service) as (id:string,scope:{shopId:string;conversationId:string;unpreparedOnly:true})=>Promise<void>;
   await fail(admitted.messageId,{shopId:variant==='foreign'?'foreign-shop':f.shopId,conversationId:f.conversationId,unpreparedOnly:true});
   const after=await f.db.conversationMessage.findUniqueOrThrow({where:{id:admitted.messageId}});
   expect(after.status).toBe(variant==='untouched'?'FAILED':before.status);expect(after.content).toBe(before.content);expect(after.outboundPresentation).toEqual(before.outboundPresentation);expect(after.providerDispatchKey).toBe(before.providerDispatchKey);
   expect(await f.db.usageEvent.count({where:{sourceId:admitted.messageId}})).toBe(variant==='untouched'?0:1);
  }finally{await f.close();}
 },120000);
 it('does not fail a competing body that commits between cleanup read and guarded UPDATE',async()=>{
  const f=await fixture('cleanup-race');try{const admitted=await f.reserve();let raced=false;
   const database={...f.db,$transaction:async(operation:(tx:import("@prisma/client").Prisma.TransactionClient)=>Promise<unknown>)=>f.db.$transaction(async tx=>operation({...tx,conversationMessage:{...tx.conversationMessage,updateMany:async(args:Parameters<typeof tx.conversationMessage.updateMany>[0])=>{
    if(!raced){raced=true;await f.db.conversationMessage.update({where:{id:admitted.messageId},data:{content:'Competing prepared winner'}});}return tx.conversationMessage.updateMany(args);
   }}}))};
   const service=new OutboundProviderFailureService(database as never);const fail=service.failPrepared.bind(service) as (id:string,scope:{shopId:string;conversationId:string;unpreparedOnly:true})=>Promise<void>;
   await fail(admitted.messageId,{shopId:f.shopId,conversationId:f.conversationId,unpreparedOnly:true});
   expect(raced).toBe(true);const message=await f.db.conversationMessage.findUniqueOrThrow({where:{id:admitted.messageId}});expect(message.status).toBe('PENDING');expect(message.content).toBe('Competing prepared winner');expect(await f.db.usageEvent.count({where:{sourceId:message.id}})).toBe(1);
  }finally{await f.close();}
 },120000);
});
