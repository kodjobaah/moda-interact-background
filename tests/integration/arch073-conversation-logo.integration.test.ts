import 'dotenv/config';
import { describe, expect, it, vi } from 'vitest';
import { humanDispatchFixture } from './fixtures/recovery-human-dispatch.fixture.js';
import { AiTurnOwnershipService } from '../../src/services/recovery-conversation/ai-turn-ownership.service.js';
import { OutboundSendFenceService } from '../../src/services/recovery-conversation/outbound-send-fence.service.js';
import { HumanPreparedCommandService } from '../../src/services/recovery-conversation/human-prepared-command.service.js';
import { HumanWrapperPreparationService } from '../../src/services/recovery-conversation/human-wrapper-preparation.service.js';
import { ConversationWrapperService } from '../../src/services/conversation-wrappers/service.js';
import { PrismaConversationWrapperReadRepository } from '../../src/services/conversation-wrappers/repository.js';
import { verifiedReadyConversationBrandImage } from '../../src/services/shop-brand-media-runtime/resolver.js';
import { currentBrandPlanMatches } from '../../src/services/conversation-brand-media.js';
import { OutboundMessageDeliveryService } from '../../src/services/outbound-whatsapp-admission/outbound-message-delivery.service.js';
import { currentRecoveryShopHeaderMatches } from '../../src/services/recovery-conversation/recovery-shop-header-verification.js';
import { freezeBrandMedia, readFrozenBrandMedia } from '../../src/services/conversation-delivery-plan.js';
import { sha256Text } from '../../src/services/conversation-moderation/moderation-assessment.service.js';
const suite=process.env.TEST_DATABASE_URL&&process.env.REDIS_URL&&process.env.MODA_DISPOSABLE_INTEGRATION==='1'?describe:describe.skip;
const hash='a'.repeat(64),fingerprint=`sha256:${'b'.repeat(64)}`;
function media(domain:string){return {schemaVersion:1,roles:{LOGO:{source:{url:'https://source.example/logo.png',reference:null,generation:3,fingerprint,observedAt:'2026-11-12T09:00:00Z'},work:{status:'READY',attempts:1,retryAfter:null,leaseOwner:null,leaseUntil:null,failureCode:null,lastCheckedAt:'2026-11-12T09:02:00Z'},ready:{sourceGeneration:3,sourceFingerprint:fingerprint,objectKey:`shop-brands/${domain}/logo/sha256-${hash}.jpg`,contentType:'image/jpeg',width:1125,height:600,sizeBytes:42000,contentSha256:hash,verifiedAt:'2026-11-12T09:02:00Z'}}}};}
async function fixture(label:string){
 const f=await humanDispatchFixture(label,{checkoutLifetimeDays:7}); const domain=`${f.shopId}.example.test`;
 await f.db.shopBrand.create({data:{shopId:f.shopId,brandName:'Logo Fixture',whatsAppMedia:media(domain)}});
 await f.db.checkoutRecovery.update({where:{id:f.recoveryId},data:{checkoutUrl:`https://${domain}/checkouts/trusted`}});
 const policyRow=await f.db.platformConfiguration.create({data:{environment:'test',key:'shopBrand.publicMedia',version:1,value:{publicOrigin:'https://brands.example/'}}});
 const policy={environment:'test',key:'shopBrand.publicMedia' as const,id:policyRow.id,version:1,publicOrigin:'https://brands.example'};
 const resolver=async()=>{const row=await f.db.shopBrand.findUniqueOrThrow({where:{shopId:f.shopId},include:{shop:true}});const image=verifiedReadyConversationBrandImage({shopId:f.shopId,domain:row.shop.domain,role:'LOGO',whatsAppMedia:row.whatsAppMedia,publicOrigin:new URL('https://brands.example/')});return image?{image,policyRef:policy}:null;};
 const preparation=new HumanPreparedCommandService(f.db,new HumanWrapperPreparationService(new ConversationWrapperService({repository:new PrismaConversationWrapperReadRepository(f.db,undefined,{read:async()=>7}),onMissingSlot:'passthrough',logoResolver:resolver})));
 const provider={...f.provider,sendWhatsAppImage:vi.fn(async()=>({providerMessageId:`logo-${label}`}))};
 const dispatcher=f.dispatcher(undefined,undefined,undefined,undefined,{preparation,provider,mediaCurrent:async plan=>plan.kind!=='BRAND_IMAGE'||JSON.stringify((await resolver())?.image)===JSON.stringify(plan.image)});
 async function freeze(){const id=await f.addCommand({textBody:'Merchant answer retained verbatim'});const claim=(await f.commands.claimDueHumanCommands({limit:1,now:new Date()}))[0]!;const loaded=await f.commands.loadClaimedCommand(id,claim.leaseToken);if(loaded.kind!=='claimed')throw new Error('claim');const frozen=await preparation.freeze(loaded.command,claim.leaseToken);if(frozen.kind!=='frozen'||!frozen.evidence.mediaPreparation)throw new Error('logo missing');return {id,claim,frozen};}
 return {...f,resolver,policyRow,close:async()=>{await f.db.platformConfiguration.deleteMany({where:{environment:'test',key:'shopBrand.publicMedia'}});await f.close();},preparation,provider,dispatcher,freeze};
}
suite('ARCH073 logo frozen preparation and final PostgreSQL identity',()=>{
 it('preserves HUMAN admission after a new customer inbound; sends one image with exact moderated persisted TEXT caption',async()=>{
  const f=await fixture('logo-human');try{const {id,claim,frozen}=await f.freeze();const original=frozen.evidence.mediaPreparation!;
   await f.db.conversation.update({where:{id:f.conversationId},data:{inboundVersion:{increment:1},lastInboundAt:new Date()}});
   await f.dispatcher.processClaim(id,claim.leaseToken);
   const command=await f.db.merchantConversationSendCommand.findUniqueOrThrow({where:{id}});
   expect(command.outboundMessageId).not.toBeNull();
   const message=await f.db.conversationMessage.findUniqueOrThrow({where:{id:command.outboundMessageId!}});
   expect(message.contentType).toBe('TEXT'); expect(message.content).toBe(frozen.body);
   expect(readFrozenBrandMedia(message.outboundPresentation)).toEqual(original);
   expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();expect(f.provider.sendWhatsAppImage).toHaveBeenCalledOnce();
   expect(f.provider.sendWhatsAppImage).toHaveBeenCalledWith(expect.objectContaining({caption:message.content,link:original.plan.image.publicUrl}));
   const assessment=await f.db.conversationModerationAssessment.findFirstOrThrow({where:{merchantSendCommandId:id}});expect(assessment.contentSha256).toBe(sha256Text(message.content!));
  }finally{await f.dispatcher.close();await f.close();}
 },120000);
 for(const mutation of ['asset','domain','name','policy','policy-recreate','control','lease','tamper'] as const)it(`refuses frozen ${mutation} changes without text downgrade`,async()=>{
  const f=await fixture(`logo-${mutation}`);try{const {id,claim,frozen}=await f.freeze();const policyRow=f.policyRow;
   if(mutation==='asset')await f.db.shopBrand.update({where:{shopId:f.shopId},data:{whatsAppMedia:{schemaVersion:1,roles:{}}}});
   if(mutation==='domain')await f.db.shop.update({where:{id:f.shopId},data:{domain:'changed.example.test'}});
   if(mutation==='policy-recreate'){await f.db.platformConfiguration.delete({where:{id:policyRow.id}});await f.db.platformConfiguration.create({data:{environment:'test',key:'shopBrand.publicMedia',version:1,value:{publicOrigin:'https://brands.example/'}}});}
   if(mutation==='policy')await f.db.platformConfiguration.update({where:{environment_key:{environment:'test',key:'shopBrand.publicMedia'}},data:{version:{increment:1},value:{publicOrigin:'https://changed.example/'}}});
   if(mutation==='name')await f.db.shopBrand.update({where:{shopId:f.shopId},data:{brandName:'Renamed'}});
   if(mutation==='control')await f.changeOwner('HUMAN','AI',1);
   if(mutation==='lease'){await f.dispatcher.processClaim(id,'stale-lease-token');expect(f.provider.sendWhatsAppImage).not.toHaveBeenCalled();expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();return;}
   if(mutation==='tamper'){await expect(f.db.merchantConversationSendCommand.update({where:{id},data:{preparedWrapperEvidence:{...frozen.evidence,mediaPreparation:{...frozen.evidence.mediaPreparation!,planDigest:'tampered'}}}})).rejects.toThrow('immutable');return;}
   await f.dispatcher.processClaim(id,claim.leaseToken);expect(f.provider.sendWhatsAppImage).not.toHaveBeenCalled();expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();
   expect((await f.db.merchantConversationSendCommand.findUniqueOrThrow({where:{id}})).providerDispatchKey).toBeNull();
  }finally{await f.dispatcher.close();await f.close();}
 },120000);
 for(const path of ['text','template'] as const)it(`sends a ${path} terminal notice through one frozen image with the complete moderated caption`,async()=>{
  const f=await fixture(`logo-notice-${path}`);try{
   await f.addCommand({textBody:'seed authorized customer window'});await f.changeOwner('HUMAN','AI',1);
   const message=await f.db.conversationMessage.create({data:{conversationId:f.conversationId,direction:'OUTBOUND',senderType:'AGENT',status:'PENDING',content:'reserved'}});
   const service=new OutboundMessageDeliveryService(f.db,f.provider,f.execution,new AiTurnOwnershipService(f.db),new OutboundSendFenceService(f.db,async()=>null),f.persistedAllowModeration(),undefined,undefined,undefined,undefined,new PrismaConversationWrapperReadRepository(f.db,undefined,{read:async()=>7}),f.resolver);
   const admission={kind:'admitted' as const,shopId:f.shopId,conversationId:f.conversationId,messageId:message.id,terminal:true,executionScope:'recovery' as const};
   const result=path==='text'?await service.sendPreparedText({...admission,to:'15551234567',text:'ignored terminal raw'}):await service.sendPreparedTemplate(admission,{to:'15551234567',templateName:'unused',languageCode:'en',bodyParameters:[]});
   expect(result.kind).toBe('admitted');const persisted=await f.db.conversationMessage.findUniqueOrThrow({where:{id:message.id}});const envelope=readFrozenBrandMedia(persisted.outboundPresentation);expect(envelope).not.toBeNull();expect(persisted.contentType).toBe('TEXT');
   expect(f.provider.sendWhatsAppImage).toHaveBeenCalledOnce();expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();expect(f.provider.sendWhatsAppTemplate).not.toHaveBeenCalled();
   expect(f.provider.sendWhatsAppImage).toHaveBeenCalledWith(expect.objectContaining({caption:persisted.content,link:envelope!.plan.image.publicUrl}));
   const assessment=await f.db.conversationModerationAssessment.findFirstOrThrow({where:{conversationMessageId:message.id}});expect(assessment.contentSha256).toBe(sha256Text(persisted.content!));
  }finally{await f.dispatcher.close();await f.close();}
 },120000);
 it('restarts a pending automated logo with original header/control receipt and refuses renamed shop identity',async()=>{
  const f=await fixture('logo-notice-restart');try{const {frozen}=await f.freeze();const original=frozen.evidence.mediaPreparation!;
   const message=await f.db.conversationMessage.create({data:{conversationId:f.conversationId,direction:'OUTBOUND',senderType:'AUTOMATION',status:'PENDING',content:frozen.body}});
   const envelope=freezeBrandMedia(original.plan,{...original.receipt,sourceKind:'MESSAGE',sourceId:message.id},original.recoveryShopHeader,original.policyRef);
   await f.db.conversationMessage.update({where:{id:message.id},data:{outboundPresentation:JSON.parse(JSON.stringify(envelope))}});
   const service=new OutboundMessageDeliveryService(f.db);
   const read=Reflect.get(service,'frozenPending') as (input:{shopId:string;conversationId:string;messageId:string})=>Promise<{body:string;header:typeof original.recoveryShopHeader;receipt:{controlRevision:number;inboundVersion:number};plan:typeof original.plan}>;
   await f.db.conversation.update({where:{id:f.conversationId},data:{inboundVersion:{increment:1}}});
   const restarted=await read.call(service,{shopId:f.shopId,conversationId:f.conversationId,messageId:message.id});
   expect(restarted.body).toBe(frozen.body);expect(restarted.header).toEqual(original.recoveryShopHeader);
   expect(restarted.receipt.inboundVersion).toBe(original.receipt.inboundVersion);expect(restarted.receipt.controlRevision).toBe(original.receipt.controlRevision);
   await f.db.shopBrand.update({where:{shopId:f.shopId},data:{brandName:'Renamed'}});
   expect(await f.db.$transaction(tx=>currentRecoveryShopHeaderMatches(tx,restarted.header,restarted.body,f.shopId))).toBe(false);
  }finally{await f.dispatcher.close();await f.close();}
 },120000);
 for(const kind of ['TEXT','IMAGE'] as const)it(`restarts a legacy pending ${kind} without selecting a newly available logo`,async()=>{
  const f=await fixture(`logo-legacy-${kind}`);try{
   const body='Immutable legacy caption';const message=await f.db.conversationMessage.create({data:{conversationId:f.conversationId,direction:'OUTBOUND',senderType:'AGENT',status:'PENDING',content:body}});
   const image={schemaVersion:1,shopId:f.shopId,productId:'gid://shopify/Product/1',variantId:null,publicUrl:'https://media.example/tree.jpg',objectKey:`conversation-products/v1/${'a'.repeat(64)}/${'b'.repeat(64)}/${'c'.repeat(64)}.jpg`,contentSha256:'c'.repeat(64),contentType:'image/jpeg',byteLength:100,width:1125,height:600};
   const plan=kind==='TEXT'?{schemaVersion:1,kind,body}:{schemaVersion:1,kind,body,image};
   await f.db.conversationMessage.update({where:{id:message.id},data:{outboundPresentation:plan}});
   const service=new OutboundMessageDeliveryService(f.db);const read=Reflect.get(service,'frozenPending') as (input:unknown)=>Promise<unknown>;
   expect(await read.call(service,{shopId:f.shopId,conversationId:f.conversationId,messageId:message.id})).toEqual({body,plan});
  }finally{await f.dispatcher.close();await f.close();}
 },120000);
 it('final Shop→Brand check waits for asset mutation and rejects stale READY provenance',async()=>{
  const f=await fixture('logo-lock');try{const {frozen}=await f.freeze();const plan=frozen.evidence.mediaPreparation!.plan;
   expect(await f.db.$transaction(tx=>currentBrandPlanMatches(tx,plan,f.shopId,frozen.evidence.mediaPreparation!.policyRef))).toBe(true);
   let unlock!:()=>void,acquired!:()=>void;const gate=new Promise<void>(r=>unlock=r),ready=new Promise<void>(r=>acquired=r);
   const mutation=f.db.$transaction(async tx=>{await tx.$queryRawUnsafe(`SELECT "id" FROM "commerce"."Shop" WHERE "id"=$1 FOR UPDATE`,f.shopId);await tx.shopBrand.update({where:{shopId:f.shopId},data:{whatsAppMedia:{schemaVersion:1,roles:{}}}});acquired();await gate;});
   await ready;const pending=f.db.$transaction(tx=>currentBrandPlanMatches(tx,plan,f.shopId,frozen.evidence.mediaPreparation!.policyRef));await new Promise(r=>setTimeout(r,30));unlock();await mutation;expect(await pending).toBe(false);
  }finally{await f.dispatcher.close();await f.close();}
 },120000);
});
