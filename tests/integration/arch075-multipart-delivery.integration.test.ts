import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { describe,it,expect,vi } from 'vitest';
import { buildRecoveryMultipartDeliveryPlan,digestRecoveryMultipartDeliveryPlan,type RecoveryMultipartDeliveryPart } from '@modainteract/moda-interact-shared/commerce/presentation';
import { humanDispatchFixture } from './fixtures/recovery-human-dispatch.fixture.js';
import { RecoveryMultipartDeliveryEngine } from '../../src/services/recovery-multipart/engine.js';
import { deliveryDeadline,sha256,humanMultipartMessageId,type FrozenMultipart } from '../../src/services/recovery-multipart/frozen.js';
import { OutboundSendFenceService } from '../../src/services/recovery-conversation/outbound-send-fence.service.js';
import { recoveryRuntimeEligibility } from '../../src/services/recovery-conversation/recovery-runtime-eligibility.service.js';
import { OutboundAdmissionReservationService } from '../../src/services/outbound-whatsapp-admission/outbound-admission-reservation.service.js';
import { verifiedRecoveryShopHeader,withRecoveryShopHeader } from '../../src/services/conversation-wrappers/recovery-shop-header.js';
import { withHumanRecoveryCheckoutFooter } from '../../src/services/conversation-wrappers/recovery-checkout-footer.js';
import { moderationConfig } from '../../src/services/conversation-moderation/moderation-policy.js';
import { RecoveryRoutingService } from '../../src/services/recovery-routing.service.js';
import { resolveMultipartQuote } from '../../src/services/recovery-multipart/quote.js';
import { verifiedReadyConversationBrandImage } from '../../src/services/shop-brand-media-runtime/resolver.js';
import { WhatsAppServiceError } from '../../src/services/whatsapp.service.js';
const suite=process.env.TEST_DATABASE_URL&&process.env.REDIS_URL&&process.env.MODA_DISPOSABLE_INTEGRATION==='1'?describe:describe.skip;
const answer='Here is your complete product answer. Nothing is truncated.';
async function fixture(label:string,actor:'AGENT'|'HUMAN'='AGENT',three=false,logo=false){
 const f=await humanDispatchFixture(`arch075-${label}`,{checkoutLifetimeDays:7,recipient:'447400123456'});
 let planId:string|undefined;let configId:string|undefined;
 try {
 const domain=`${f.shopId}.example.test`.toLowerCase();const url=`https://${domain}/checkouts/trusted`;
 await f.db.shop.update({where:{id:f.shopId},data:{onboardingCompleted:true}});
 await f.db.shopBrand.create({data:{shopId:f.shopId,brandName:'Recovery Store'}});
 await f.db.checkoutRecovery.update({where:{id:f.recoveryId},data:{checkoutUrl:url}});
 const customer=await f.db.customer.create({data:{shopId:f.shopId,phone:`+${f.recipient}`}});
 const consentAt=new Date();
 const phone=await f.db.customerPhone.create({data:{customerId:customer.id,phone:`+${f.recipient}`,whatsappCanonicalPhone:f.recipient,
  whatsappPhoneVerifiedAt:consentAt,whatsappConsentDecision:'GRANTED',whatsappConsentSource:'SHOPIFY_NATIVE',whatsappConsentVerifiedAt:consentAt,whatsappConsentProviderObservedAt:consentAt,whatsappConsentRevision:1n,whatsappConsentDecisionSequence:1n}});
 await f.db.checkoutRecovery.update({where:{id:f.recoveryId},data:{customerId:customer.id}});
 const billingPlan=await f.db.billingPlan.create({data:{shopifyPlanHandle:`free-${randomUUID()}`,name:'Free multipart plan',kind:'FREE'}});
 planId=billingPlan.id;
 await f.db.subscription.create({data:{shopId:f.shopId,planId:billingPlan.id,status:'ACTIVE',observedShopifyPlanHandle:billingPlan.shopifyPlanHandle}});
 await f.db.shopEntitlementCounter.create({data:{shopId:f.shopId,counter:'LIFETIME_FREE_RECOVERY_CREDITS',grantedQuantity:5,committedQuantity:0,reservedQuantity:0}});
 await f.db.platformBillingPolicy.upsert({where:{id:'default'},create:{absoluteOutboundHardLimit:20,defaultWarningPercent:80,defaultOutboundSoftLimit:10,defaultOutboundHardLimit:20,terminalMessageReservedSlots:1},update:{absoluteOutboundHardLimit:20,defaultWarningPercent:80,defaultOutboundSoftLimit:10,defaultOutboundHardLimit:20,terminalMessageReservedSlots:1,globalPauseAutomatedWhatsapp:false}});
 const commandId=await f.addCommand({textBody:answer});
 const initial=await f.db.recoveryOutreachAttempt.findFirstOrThrow({where:{checkoutRecoveryId:f.recoveryId,sequence:1}});
 await f.db.conversationMessage.update({where:{id:initial.outboundMessageId!},data:{providerMessageId:`initial-${randomUUID()}`}});
let command:FrozenMultipart['command']=null;let revision=2;let body:string;let messageId:string;
 const header=verifiedRecoveryShopHeader(f.shopId,domain,'Recovery Store')!;
 if(actor==='HUMAN'){
  const claimed=(await f.commands.claimDueHumanCommands({limit:100,now:new Date()})).find(x=>x.id===commandId)!;
  const loaded=await f.commands.loadClaimedCommand(commandId,claimed.leaseToken);if(loaded.kind!=='claimed')throw new Error('command unavailable');
  const prepared=await f.preparation.freeze(loaded.command,claimed.leaseToken);if(prepared.kind!=='frozen')throw new Error(`prepare ${prepared.reason}`);
  body=prepared.body;messageId=humanMultipartMessageId(commandId);revision=1;command={id:commandId,leaseToken:claimed.leaseToken};
 }else{
  await f.db.merchantConversationSendCommand.delete({where:{id:commandId}});
  await f.changeOwner('HUMAN','AI',1);
  await f.db.conversation.update({where:{id:f.conversationId},data:{inboundVersion:1}});
  const reserved=await new OutboundAdmissionReservationService(f.db).reserve({shopId:f.shopId,conversationId:f.conversationId,idempotencyKey:`arch075-${randomUUID()}`,senderType:'AGENT'});
  if(reserved.kind!=='admitted')throw new Error(`reservation ${reserved.reason}`);expect(reserved.executionScope).toBe('general');messageId=reserved.messageId;
  body=withRecoveryShopHeader(withHumanRecoveryCheckoutFooter(answer,url),header);
  await f.db.conversationMessage.update({where:{id:messageId},data:{content:body}});
 }
 const footer=withHumanRecoveryCheckoutFooter('',url);let head:RecoveryMultipartDeliveryPart={role:'HEADER' as const,plan:{schemaVersion:1 as const,kind:'TEXT' as const,body:withRecoveryShopHeader(footer,header)}};
 let policyRef:FrozenMultipart['policyRef']=null;
 if(logo){
  const hash='d'.repeat(64),fingerprint=`sha256:${'e'.repeat(64)}`;
  const whatsAppMedia={schemaVersion:1,roles:{LOGO:{source:{url:'https://source.example/logo.png',reference:null,generation:3,fingerprint,observedAt:'2026-11-12T09:00:00Z'},work:{status:'READY',attempts:1,retryAfter:null,leaseOwner:null,leaseUntil:null,failureCode:null,lastCheckedAt:'2026-11-12T09:02:00Z'},ready:{sourceGeneration:3,sourceFingerprint:fingerprint,objectKey:`shop-brands/${domain}/logo/sha256-${hash}.jpg`,contentType:'image/jpeg',width:1125,height:600,sizeBytes:42000,contentSha256:hash,verifiedAt:'2026-11-12T09:02:00Z'}}}};
  await f.db.shopBrand.update({where:{shopId:f.shopId},data:{whatsAppMedia}});
  const config=await f.db.platformConfiguration.create({data:{environment:'test',key:'shopBrand.publicMedia',version:1,value:{publicOrigin:'https://brands.example',bucketName:'brand-images'}}});configId=config.id;
  policyRef={environment:'test',key:'shopBrand.publicMedia',id:config.id,version:1,publicOrigin:'https://brands.example'};
  const brand=verifiedReadyConversationBrandImage({shopId:f.shopId,domain,role:'LOGO',whatsAppMedia,publicOrigin:new URL(policyRef.publicOrigin)});if(!brand)throw new Error('brand fixture not READY');
  head={role:'HEADER',plan:{schemaVersion:1,kind:'BRAND_IMAGE',body:head.plan.body,image:brand}};
 }
 const tail={role:'ANSWER' as const,plan:{schemaVersion:1 as const,kind:'TEXT' as const,body:withHumanRecoveryCheckoutFooter(answer,url)}};
 const productId='gid://shopify/Product/1';
 const image={schemaVersion:1 as const,shopId:f.shopId,productId,variantId:null,publicUrl:'https://media.example/product.jpg',objectKey:`conversation-products/v1/${'a'.repeat(64)}/${'b'.repeat(64)}/${'c'.repeat(64)}.jpg`,contentSha256:'c'.repeat(64),contentType:'image/jpeg' as const,byteLength:100,width:1125 as const,height:600 as const};
 const parts=three?[head,{role:'PRODUCT' as const,plan:{schemaVersion:1 as const,kind:'IMAGE' as const,image,body:footer}},tail]:[head,tail];
 const plan=buildRecoveryMultipartDeliveryPlan({parts,checkoutUrl:url});const now=new Date();let clock=now;
 const source:FrozenMultipart={schemaVersion:1,kind:'RECOVERY_MULTIPART_PREPARATION',messageId,body,checkoutUrl:url,recipient:f.recipient,recoveryId:f.recoveryId,actor,
  receipt:{sourceKind:actor==='HUMAN'?'HUMAN_COMMAND':'MESSAGE',sourceId:command?.id??messageId,shopId:f.shopId,conversationId:f.conversationId,controlRevision:revision,inboundVersion:actor==='HUMAN'?0:1,firstPair:three?{productId,variantId:null}:null},
  recoveryShopHeader:header,policyRef,command,sender:{providerAccountId:'account',providerPhoneNumberId:'phone'},plan,planDigest:digestRecoveryMultipartDeliveryPlan(plan,sha256),frozenAt:now.toISOString(),deadlineAt:deliveryDeadline(now).toISOString()};
 const provider={sendWhatsAppText:vi.fn(async()=>({providerMessageId:`arch075-meta-${randomUUID()}`})),sendWhatsAppImage:vi.fn(async()=>({providerMessageId:`arch075-meta-${randomUUID()}`}))};
 const schedule=vi.fn(async()=>{});
 const consent={preflight:vi.fn(async()=>({kind:'allowed' as const,snapshot:{customerPhoneId:phone.id,canonicalRecipient:f.recipient,consentRevision:1n,noContactRevision:0n}}))};
 const engine=new RecoveryMultipartDeliveryEngine(f.db,provider,new OutboundSendFenceService(f.db,recoveryRuntimeEligibility,()=>clock),schedule,()=>clock,consent);
 await engine.freeze(source);
 await f.persistedAllowModeration().assessText({subject:actor==='HUMAN'?{kind:'HUMAN_COMMAND',commandId:command!.id}:{kind:'AGENT_MESSAGE',messageId},shopId:f.shopId,conversationId:f.conversationId,effectiveText:body,inputKind:'TEXT',policyVersion:moderationConfig().policyVersion,now});
 const list=()=>f.db.conversationDeliveryPart.findMany({where:{messageId},orderBy:{ordinal:'asc'}});
 const root=()=>f.db.conversationMessage.findUniqueOrThrow({where:{id:messageId}});
 const status=async(ordinal:number,state:'SENT'|'DELIVERED'|'READ'|'FAILED'='DELIVERED',sender=source.sender)=>{
  const part=(await list())[ordinal]!;if(!part.providerMessageId)throw new Error('part not ACK');return engine.observe({schemaVersion:2,providerAccountId:sender.providerAccountId,providerPhoneNumberId:sender.providerPhoneNumberId,providerMessageId:part.providerMessageId,status:state,occurredAt:new Date().toISOString()});
 };
 return {...f,engine,source,provider,schedule,list,root,status,phoneId:phone.id,advance:(ms:number)=>{clock=new Date(now.getTime()+ms);},close:async()=>{if(configId)await f.db.platformConfiguration.deleteMany({where:{id:configId}});await f.db.subscription.deleteMany({where:{shopId:f.shopId}});await f.db.billingPlan.delete({where:{id:billingPlan.id}});await f.close();}};
 } catch(error) {if(configId)await f.db.platformConfiguration.deleteMany({where:{id:configId}});await f.db.subscription.deleteMany({where:{shopId:f.shopId}});if(planId)await f.db.billingPlan.delete({where:{id:planId}});await f.close();throw error;}
}
suite('ARCH075 real PostgreSQL ordered delivery engine',()=>{
 it('concurrent freeze/continuation spends one logical normal Free admission and waits for DELIVERED, not ACK',async()=>{const f=await fixture('ordered');try{
  await Promise.all([f.engine.freeze(f.source),f.engine.freeze(f.source)]);expect(await f.list()).toHaveLength(2);
  await Promise.all([f.engine.continue(f.source.messageId),f.engine.continue(f.source.messageId)]);expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(1);
  expect((await f.root()).status).toBe('PENDING');await f.status(0,'SENT');await f.engine.continue(f.source.messageId);expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(1);
  await f.status(0);await f.engine.continue(f.source.messageId);expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(2);expect((await f.root()).status).toBe('SENT');
  expect((await f.root()).providerMessageId).toBeNull();expect((await f.root()).contentType).toBe('TEXT');expect((await f.root()).content).toBe(f.source.body);
  await f.status(1,'READ');await f.status(0,'READ');await f.status(0,'DELIVERED');expect((await f.root()).status).toBe('READ');
  expect(await f.db.usageEvent.count({where:{sourceId:f.source.messageId,metric:'OUTBOUND_AUTOMATED_MESSAGE'}})).toBe(1);
  expect(await f.db.usageEvent.count({where:{sourceId:f.source.messageId,metric:'DELIVERED_WHATSAPP_MESSAGE'}})).toBe(1);
 }finally{await f.close();}},120000);
 it('reconciles READ before ACK with exact sender while foreign sender cannot attach or quote',async()=>{const f=await fixture('early-read');try{
  const id=`meta-${randomUUID()}`;f.provider.sendWhatsAppText.mockImplementationOnce(async()=>{await f.engine.observe({schemaVersion:2,...f.source.sender,providerMessageId:id,status:'READ',occurredAt:new Date().toISOString()});return {providerMessageId:id};});
  await f.engine.continue(f.source.messageId);expect((await f.list())[0]!.state).toBe('READ');
  expect(await f.status(0,'FAILED',{providerAccountId:'foreign',providerPhoneNumberId:'phone'})).toBe(false);expect((await f.list())[0]!.state).toBe('READ');
  expect(await resolveMultipartQuote(f.db,{...f.source.sender,providerMessageId:id})).toMatchObject({kind:'matched',conversationId:f.conversationId,recipient:f.recipient});
  expect(await resolveMultipartQuote(f.db,{providerAccountId:'foreign',providerPhoneNumberId:'phone',providerMessageId:id})).toEqual({kind:'invalid'});
  const router=new RecoveryRoutingService(f.db,{isShopExecutionActive:async()=>true},{resolveSender:async()=>f.source.sender});
  const event={schemaVersion:1 as const,provider:'whatsapp' as const,...f.source.sender,providerMessageId:`incoming-${randomUUID()}`,customerPhone:f.recipient,contextMessageId:id,occurredAt:new Date().toISOString(),content:{type:'text' as const,text:'More details please'}};
  expect(await router.resolveInboundMessage(event)).toMatchObject({kind:'resolved',conversationId:f.conversationId,shopId:f.shopId});
  expect(await router.resolveInboundMessage({...event,providerAccountId:'foreign-account'})).toEqual({kind:'ignored'});
  expect(await router.resolveInboundMessage({...event,customerPhone:'14155550123'})).toMatchObject({kind:'guidance',reason:'INVALID_REFERENCE'});
  const rotated=new RecoveryRoutingService(f.db,{isShopExecutionActive:async()=>true},{resolveSender:async()=>({providerAccountId:'new-account',providerPhoneNumberId:'new-phone'})});
  expect(await rotated.resolveInboundMessage(event)).toEqual({kind:'ignored'});
  expect((await f.root()).sentAt).toBeNull();
 }finally{await f.close();}},120000);
 it('a duplicate header callback during next image HTTP does not cancel third answer',async()=>{const f=await fixture('in-flight', 'AGENT',true);try{
  await f.engine.continue(f.source.messageId);await f.status(0);
  f.provider.sendWhatsAppImage.mockImplementationOnce(async()=>{await f.status(0);expect((await f.list()).map(p=>p.state)).toEqual(['DELIVERED','ADMITTED','PREPARED']);return {providerMessageId:`image-${randomUUID()}`};});
  await f.engine.continue(f.source.messageId);expect((await f.list())[2]!.state).toBe('PREPARED');await f.status(1);await f.engine.continue(f.source.messageId);
  expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(2);expect(f.provider.sendWhatsAppImage).toHaveBeenCalledOnce();expect((await f.root()).status).toBe('SENT');
 }finally{await f.close();}},120000);
 it.each(['control','inbound','consent','STOP','name'] as const)('original %s change cancels unsent tail and retains accepted prefix usage',async variant=>{const f=await fixture(variant);try{
  await f.engine.continue(f.source.messageId);await f.status(0);
  if(variant==='control')await f.changeOwner('AI','HUMAN',2);
  if(variant==='inbound')await f.db.conversation.update({where:{id:f.conversationId},data:{inboundVersion:2}});
  if(variant==='consent'){const observedAt=new Date();await f.db.customerPhone.update({where:{id:f.phoneId},data:{whatsappConsentDecision:'REVOKED',whatsappConsentRevision:2n,whatsappConsentDecisionSequence:2n,whatsappConsentProviderObservedAt:observedAt,whatsappConsentVerifiedAt:observedAt}});}
  if(variant==='STOP')await f.db.customerPhone.update({where:{id:f.phoneId},data:{whatsappNoContact:true,whatsappNoContactReason:'CUSTOMER_STOP',whatsappNoContactAt:new Date(),whatsappNoContactRevision:{increment:1}}});
  if(variant==='name')await f.db.shopBrand.update({where:{shopId:f.shopId},data:{brandName:'Renamed'}});
  expect(await f.engine.continue(f.source.messageId)).toBe('cancelled');expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(1);expect((await f.list())[0]!.state).toBe('DELIVERED');expect((await f.list())[1]!.state).toBe('CANCELLED');expect((await f.root()).status).toBe('FAILED');
  expect(await f.db.usageEvent.count({where:{sourceId:f.source.messageId,metric:'OUTBOUND_AUTOMATED_MESSAGE'}})).toBe(1);
 }finally{await f.close();}},120000);
 it('network unknown never retries or releases usage, including after restart/deadline',async()=>{const f=await fixture('unknown');try{
  f.provider.sendWhatsAppText.mockRejectedValueOnce(new Error('transport timeout'));expect(await f.engine.continue(f.source.messageId)).toBe('unknown');
  await f.engine.continue(f.source.messageId);f.advance(121000);await f.engine.continue(f.source.messageId);expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(1);
  expect((await f.list()).map(p=>p.state)).toEqual(['UNKNOWN','CANCELLED']);expect((await f.root()).status).toBe('PENDING');expect(await f.db.usageEvent.count({where:{sourceId:f.source.messageId}})).toBe(1);
 }finally{await f.close();}},120000);
 it('deadline after ACK cancels only unadmitted tail, preserves prefix and late receipts',async()=>{const f=await fixture('deadline');try{
  await f.engine.continue(f.source.messageId);f.advance(121000);expect(await f.engine.continue(f.source.messageId)).toBe('cancelled');expect((await f.list()).map(p=>p.state)).toEqual(['ACKNOWLEDGED','CANCELLED']);await f.status(0,'READ');await f.engine.continue(f.source.messageId);expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(1);expect((await f.list())[0]!.state).toBe('READ');
 }finally{await f.close();}},120000);
 it('known zero-send rejection releases only unused logical usage and never retries',async()=>{const f=await fixture('known-failure');try{
  f.provider.sendWhatsAppText.mockRejectedValueOnce(new WhatsAppServiceError('sender-mismatch','Sender changed'));expect(await f.engine.continue(f.source.messageId)).toBe('failed');await f.engine.continue(f.source.messageId);expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(1);expect((await f.root()).status).toBe('FAILED');expect(await f.db.usageEvent.count({where:{sourceId:f.source.messageId}})).toBe(0);
 }finally{await f.close();}},120000);
 it('post-ACK scheduler failure preserves actual ACK and never invents UNKNOWN or repeat HTTP',async()=>{const f=await fixture('scheduler');try{
  f.schedule.mockRejectedValueOnce(new Error('queue unavailable'));await expect(f.engine.continue(f.source.messageId)).rejects.toThrow('queue unavailable');expect((await f.list()).map(p=>p.state)).toEqual(['ACKNOWLEDGED','PREPARED']);await f.engine.continue(f.source.messageId);expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(1);
 }finally{await f.close();}},120000);
 it('HUMAN command stays admitted after header, accepts later customer inbound, and completes only all ACK',async()=>{const f=await fixture('human','HUMAN');try{
  await f.engine.continue(f.source.messageId);expect((await f.commandState(f.source.command!.id))!.state).toBe('DISPATCH_ADMITTED');
  await f.db.merchantConversationSendCommand.update({where:{id:f.source.command!.id},data:{leaseExpiresAt:new Date(Date.now()-1000)}});
  await f.dispatcher().reconcileExpiredPermits();expect((await f.commandState(f.source.command!.id))!.state).toBe('DISPATCH_ADMITTED');
  await f.db.conversation.update({where:{id:f.conversationId},data:{inboundVersion:8}});await f.status(0);await f.engine.continue(f.source.messageId);
  expect((await f.commandState(f.source.command!.id))!.state).toBe('SENT');expect((await f.root()).providerMessageId).toBeNull();expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(2);
 }finally{await f.close();}},120000);
 it('genuine READY logo then distinct product image then full answer use separate frozen provider payloads',async()=>{const f=await fixture('logo-product','AGENT',true,true);try{
  await f.engine.continue(f.source.messageId);expect(f.provider.sendWhatsAppImage).toHaveBeenCalledTimes(1);expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();
  expect(f.provider.sendWhatsAppImage.mock.calls[0]?.[0]).toMatchObject({caption:f.source.plan.parts[0]!.plan.body,expectedSender:f.source.sender});
  await f.engine.continue(f.source.messageId);expect(f.provider.sendWhatsAppImage).toHaveBeenCalledTimes(1);
  await f.status(0);await f.engine.continue(f.source.messageId);expect(f.provider.sendWhatsAppImage).toHaveBeenCalledTimes(2);
  await f.status(1);await f.engine.continue(f.source.messageId);expect(f.provider.sendWhatsAppText).toHaveBeenCalledOnce();
  expect((await f.root()).status).toBe('SENT');expect((await f.root()).contentType).toBe('TEXT');expect((await f.root()).content).toBe(f.source.body);
 }finally{await f.close();}},120000);
 it('policy row replacement after accepted logo refuses unsent tail without rewriting accepted prefix',async()=>{const f=await fixture('policy-recreated','AGENT',true,true);try{
  await f.engine.continue(f.source.messageId);await f.status(0);
  await f.db.platformConfiguration.delete({where:{id:f.source.policyRef!.id}});
  const replacement=await f.db.platformConfiguration.create({data:{environment:'test',key:'shopBrand.publicMedia',version:1,value:{publicOrigin:'https://brands.example',bucketName:'brand-images'}}});
  try{expect(await f.engine.continue(f.source.messageId)).toBe('cancelled');expect(f.provider.sendWhatsAppImage).toHaveBeenCalledTimes(1);expect((await f.list()).map(p=>p.state)).toEqual(['DELIVERED','CANCELLED','CANCELLED']);expect(await f.db.usageEvent.count({where:{sourceId:f.source.messageId}})).toBe(1);}finally{await f.db.platformConfiguration.delete({where:{id:replacement.id}});}
 }finally{await f.close();}},120000);
 it('late original HTTP ACK after expiry persists exact MetaID and early READ but never revives cancelled tail',async()=>{const f=await fixture('late-ack');try{
  let release!:(value:{providerMessageId:string})=>void;let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  f.provider.sendWhatsAppText.mockImplementationOnce(async()=>{entered();return new Promise(resolve=>{release=resolve;});});
  const pending=f.engine.continue(f.source.messageId);await started;f.advance(121000);await f.engine.continue(f.source.messageId);
  expect((await f.list()).map(p=>p.state)).toEqual(['UNKNOWN','CANCELLED']);
  const meta=`late-${randomUUID()}`;await f.engine.observe({schemaVersion:2,...f.source.sender,providerMessageId:meta,status:'READ',occurredAt:new Date().toISOString()});
  release({providerMessageId:meta});expect(await pending).toBe('acknowledged');expect((await f.list()).map(p=>p.state)).toEqual(['READ','CANCELLED']);expect((await f.list())[0]!.providerMessageId).toBe(meta);
  expect((await f.root()).status).toBe('FAILED');expect((await f.root()).sentAt).toBeNull();await f.engine.continue(f.source.messageId);expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(1);expect(await f.db.usageEvent.count({where:{sourceId:f.source.messageId}})).toBe(1);
 }finally{await f.close();}},120000);
 it('prepermit HUMAN refusal terminally cancels original unadmitted claim rather than allowing a later legacy retry',async()=>{const f=await fixture('human-refused','HUMAN');try{
  await f.db.shopBrand.update({where:{shopId:f.shopId},data:{brandName:'Changed before permit'}});expect(await f.engine.continue(f.source.messageId)).toBe('cancelled');
  expect((await f.commandState(f.source.command!.id))!.state).toBe('CANCELLED');expect(await f.commands.claimDueHumanCommands({limit:100,now:new Date(Date.now()+90000)})).not.toContainEqual(expect.objectContaining({id:f.source.command!.id}));expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();
 }finally{await f.close();}},120000);
 it('repair retains matched evidence and recent receipts while deleting at most100 unmatched older than7days',async()=>{const f=await fixture('retention');try{
  await f.engine.continue(f.source.messageId);const part=(await f.list())[0]!;const old=new Date(Date.now()-8*86400000);
  await f.db.conversationDeliveryStatusReceipt.createMany({data:Array.from({length:102},(_,i)=>({id:`old-${randomUUID()}`,providerAccountId:'unmatched',providerPhoneNumberId:'phone',providerMessageId:`unknown-${i}-${randomUUID()}`,status:'SENT' as const,providerTimestamp:old,receivedAt:old}))});
  const recent=await f.db.conversationDeliveryStatusReceipt.create({data:{...f.source.sender,providerMessageId:`recent-${randomUUID()}`,status:'SENT',providerTimestamp:new Date()}});
  const matched=await f.db.conversationDeliveryStatusReceipt.create({data:{...f.source.sender,providerMessageId:part.providerMessageId!,status:'SENT',providerTimestamp:old,receivedAt:old,partId:part.id}});
  await f.engine.repair();expect(await f.db.conversationDeliveryStatusReceipt.count({where:{partId:null,receivedAt:{lt:new Date(Date.now()-7*86400000)}}})).toBe(2);
  expect(await f.db.conversationDeliveryStatusReceipt.findUnique({where:{id:recent.id}})).not.toBeNull();expect(await f.db.conversationDeliveryStatusReceipt.findUnique({where:{id:matched.id}})).not.toBeNull();expect(f.schedule).toHaveBeenCalledWith(f.source.messageId);
 }finally{await f.db.conversationDeliveryStatusReceipt.deleteMany({where:{providerAccountId:'unmatched'}});await f.close();}},120000);
 it('a later verified READ outranks FAILED for the same accepted part without resending or duplicating logical delivery usage',async()=>{const f=await fixture('failure-read');try{
  await f.engine.continue(f.source.messageId);await f.status(0);await f.engine.continue(f.source.messageId);await f.status(1,'FAILED');expect((await f.root()).status).toBe('FAILED');
  expect(await resolveMultipartQuote(f.db,{...f.source.sender,providerMessageId:(await f.list())[1]!.providerMessageId!})).toMatchObject({kind:'matched',conversationId:f.conversationId});
  await f.status(1,'READ');expect((await f.root()).status).toBe('DELIVERED');await f.status(0,'READ');await f.status(1,'FAILED');expect((await f.root()).status).toBe('READ');
  expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(2);expect(await f.db.usageEvent.count({where:{sourceId:f.source.messageId,metric:'DELIVERED_WHATSAPP_MESSAGE'}})).toBe(1);
 }finally{await f.close();}},120000);
 it('two logical groups cannot interleave their physical parts while an earlier group awaits delivery',async()=>{const f=await fixture('group-order');try{
  const second=await new OutboundAdmissionReservationService(f.db).reserve({shopId:f.shopId,conversationId:f.conversationId,idempotencyKey:`second-${randomUUID()}`,senderType:'AGENT'});if(second.kind!=='admitted')throw new Error('second admission refused');
  const source={...f.source,messageId:second.messageId,receipt:{...f.source.receipt,sourceId:second.messageId}};
  await f.db.conversationMessage.update({where:{id:second.messageId},data:{content:source.body}});await f.engine.freeze(source);
  await f.persistedAllowModeration().assessText({subject:{kind:'AGENT_MESSAGE',messageId:second.messageId},shopId:f.shopId,conversationId:f.conversationId,effectiveText:source.body,inputKind:'TEXT',policyVersion:moderationConfig().policyVersion,now:new Date()});
  expect(await f.engine.continue(second.messageId)).toBe('waiting');expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();
  await f.engine.continue(f.source.messageId);await f.status(0);await f.engine.continue(f.source.messageId);
  expect(await f.engine.continue(second.messageId)).toBe('waiting');expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(2);
  await f.status(1);expect(await f.engine.continue(second.messageId)).toBe('acknowledged');expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(3);
  expect(f.provider.sendWhatsAppText.mock.calls.map(call=>(call[0] as {text:string}).text)).toEqual([source.plan.parts[0]!.plan.body,source.plan.parts[1]!.plan.body,source.plan.parts[0]!.plan.body]);
 }finally{await f.close();}},120000);
 it('repair closes unmatched-receipt/ACK transaction commit-order race without repeating the accepted request',async()=>{const f=await fixture('receipt-commit-race');try{
  const meta=`commit-race-${randomUUID()}`;let release!:()=>void;let inserted!:()=>void;
  const hold=new Promise<void>(resolve=>{release=resolve;});const ready=new Promise<void>(resolve=>{inserted=resolve;});
  const transaction=f.db.$transaction(async tx=>{await tx.conversationDeliveryStatusReceipt.create({data:{...f.source.sender,providerMessageId:meta,status:'READ',providerTimestamp:new Date()}});inserted();await hold;},{timeout:15000});
  await ready;f.provider.sendWhatsAppText.mockResolvedValueOnce({providerMessageId:meta});
  try{await f.engine.continue(f.source.messageId);expect((await f.list())[0]!.state).toBe('ACKNOWLEDGED');}finally{release();await transaction;}
  await f.engine.continue(f.source.messageId);expect((await f.list())[0]!.state).toBe('READ');expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(2);expect((await f.root()).status).toBe('SENT');
 }finally{await f.close();}},120000);
 it.each(['source','recovery-closed','source-and-recovery-closed','takeover'] as const)('actual provider ACK/status survives %s change during HTTP without authorizing the tail',async variant=>{const f=await fixture(`outcome-${variant}`);try{
  const meta=`outcome-${randomUUID()}`;
  f.provider.sendWhatsAppText.mockImplementationOnce(async()=>{
   if(variant==='source'||variant==='source-and-recovery-closed')await f.db.conversationMessage.update({where:{id:f.source.messageId},data:{outboundPresentation:{...f.source,planDigest:'0'.repeat(64)}}});
   if(variant==='recovery-closed'||variant==='source-and-recovery-closed')await f.db.checkoutRecovery.update({where:{id:f.recoveryId},data:{status:'COMPLETED',completedAt:new Date()}});
   if(variant==='takeover')await f.changeOwner('AI','HUMAN',2);
   return {providerMessageId:meta};
  });
  expect(await f.engine.continue(f.source.messageId)).toBe('acknowledged');expect((await f.list())[0]!.providerMessageId).toBe(meta);
  expect(await f.status(0,'READ')).toBe(true);expect((await f.list())[0]!.state).toBe('READ');
  expect(await f.engine.continue(f.source.messageId)).toBe('cancelled');expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(1);expect((await f.list()).map(p=>p.state)).toEqual(['READ','CANCELLED']);
 }finally{await f.close();}},120000);
 it('duplicate same-lease HUMAN freeze has one deterministic root and rejects conflicting frozen content',async()=>{const f=await fixture('human-dedupe','HUMAN');try{
  await Promise.all([f.engine.freeze(f.source),f.engine.freeze(f.source)]);expect(await f.db.conversationMessage.count({where:{conversationId:f.conversationId,senderType:'HUMAN'}})).toBe(1);expect(await f.list()).toHaveLength(2);
  const alteredBody='Conflicting staff body';const plan=buildRecoveryMultipartDeliveryPlan({checkoutUrl:f.source.checkoutUrl,parts:[f.source.plan.parts[0]!,{role:'ANSWER',plan:{schemaVersion:1,kind:'TEXT',body:withHumanRecoveryCheckoutFooter(alteredBody,f.source.checkoutUrl)}}]});
  const changed={...f.source,body:withRecoveryShopHeader(withHumanRecoveryCheckoutFooter(alteredBody,f.source.checkoutUrl),f.source.recoveryShopHeader),plan,planDigest:digestRecoveryMultipartDeliveryPlan(plan,sha256)};
  await expect(f.engine.freeze(changed)).rejects.toThrow('MULTIPART_COMMAND_STALE');expect((await f.root()).content).toBe(f.source.body);expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();
 }finally{await f.close();}},120000);
 it('a copied foreign root envelope cannot cancel or send the other legitimate group',async()=>{const f=await fixture('root-binding');try{
  const second=await new OutboundAdmissionReservationService(f.db).reserve({shopId:f.shopId,conversationId:f.conversationId,idempotencyKey:`foreign-root-${randomUUID()}`,senderType:'AGENT'});if(second.kind!=='admitted')throw new Error('second admission refused');
  const other={...f.source,messageId:second.messageId,receipt:{...f.source.receipt,sourceId:second.messageId}};
  await f.db.conversationMessage.update({where:{id:second.messageId},data:{content:other.body}});await f.engine.freeze(other);
  await f.db.conversationMessage.update({where:{id:f.source.messageId},data:{outboundPresentation:other}});
  expect(await f.engine.continue(f.source.messageId)).toBe('cancelled');expect((await f.list()).map(p=>p.state)).toEqual(['CANCELLED','CANCELLED']);
  expect((await f.db.conversationDeliveryPart.findMany({where:{messageId:second.messageId}})).map(p=>p.state)).toEqual(['PREPARED','PREPARED']);expect((await f.db.conversationMessage.findUniqueOrThrow({where:{id:second.messageId}})).status).toBe('PENDING');expect(await f.db.usageEvent.count({where:{sourceId:second.messageId}})).toBe(1);expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();
 }finally{await f.close();}},120000);
 it('an admitted crash reaches UNKNOWN on deadline and never becomes a fresh attempt',async()=>{const f=await fixture('admitted-crash');try{
  const part=(await f.list())[0]!;const fence=new OutboundSendFenceService(f.db,recoveryRuntimeEligibility);
  const permit=await fence.admitProviderDispatch({senderType:'AGENT',conversationId:f.conversationId,shopId:f.shopId,recoveryId:f.recoveryId,expectedControlRevision:2,expectedInboundVersion:1,messageId:f.source.messageId,recipient:f.recipient,expectedContent:f.source.body,deliveryKind:'TEXT',now:new Date(),multipartPartId:part.id,multipartConsent:{customerPhoneId:f.phoneId,canonicalRecipient:f.recipient,consentRevision:1n,noContactRevision:0n},recoveryShopHeader:f.source.recoveryShopHeader});
  expect(permit.kind).toBe('admitted');await f.engine.continue(f.source.messageId);expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();f.advance(121000);await f.engine.continue(f.source.messageId);expect((await f.list()).map(p=>p.state)).toEqual(['UNKNOWN','CANCELLED']);expect((await f.root()).status).toBe('PENDING');
 }finally{await f.close();}},120000);
});
