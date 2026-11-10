import {presentedProductContext} from '../../src/commerce/product-context-write.js';
import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {describe,it,expect,vi} from 'vitest';
import {OutboundMessageDeliveryService} from '../../src/services/outbound-whatsapp-admission/outbound-message-delivery.service.js';
import {OutboundSendFenceService} from '../../src/services/recovery-conversation/outbound-send-fence.service.js';
import {GeneralOutboundSendFenceService} from '../../src/services/outbound-whatsapp-admission/general-outbound-send-fence.service.js';
const url=process.env.TEST_DATABASE_URL;
const suite=url && process.env.MODA_DISPOSABLE_INTEGRATION==='1'?describe:describe.skip;
suite('ARCH068 durable image dispatch',()=>{
 it.each(['success','unknown','closed-window','wrong-receipt','wrong-scope','legacy-downgrade','plan-mismatch','schema-mismatch','concurrent'] as const)('freezes one plan with %s',async mode=>{
  const db=new PrismaClient({datasourceUrl:url!}); const shopId=randomUUID();
  try {
   await db.shop.create({data:{id:shopId,domain:`${shopId}.example`,status:'ACTIVE'}});
   const conversation=await db.conversation.create({data:{shopId,type:'PRODUCT_SUPPORT',inboundVersion:2,controlRevision:3,controlChangedAt:new Date(),lastInboundAt:new Date(Date.now()-(mode==='closed-window'?25*3600000:1000))}});
   const message=await db.conversationMessage.create({data:{conversationId:conversation.id,direction:'OUTBOUND',senderType:'AGENT',status:'PENDING',content:'pending'}});
   const pair={productId:'tree',variantId:null};
   const plan={schemaVersion:1,kind:'IMAGE',body:'The tree is 30cm.',image:{schemaVersion:1,shopId,...pair,publicUrl:'https://media.example/tree.jpg',objectKey:`conversation-products/v1/${'a'.repeat(64)}/${'b'.repeat(64)}/${'c'.repeat(64)}.jpg`,contentSha256:'c'.repeat(64),contentType:'image/jpeg',byteLength:100,width:1125,height:600}} as const;
   const provider={sendWhatsAppText:vi.fn(),sendWhatsAppImage:vi.fn(async()=>{if(mode==='unknown')throw new Error('transport timeout');return {providerMessageId:'one-image'};})};
   const delivery=new OutboundMessageDeliveryService(db,provider as never,{evaluate:vi.fn(async()=>({allowed:true,shopId}))} as never,{readTurnOwnership:vi.fn(async()=>null)} as never,undefined,{assessText:vi.fn(async()=>({kind:'allow'})),requireCurrentAllowance:vi.fn(async()=>true)} as never,undefined,new GeneralOutboundSendFenceService(db));
   const input={kind:'admitted',shopId:mode==='wrong-scope'?'foreign-shop':shopId,conversationId:conversation.id,messageId:message.id,terminal:false,executionScope:'general',to:'447700900001',text:plan.body,deliveryPlan:plan,expectedControlRevision:3,expectedInboundVersion:2,presentationReceipt:{shopId:mode==='wrong-scope'?'foreign-shop':shopId,conversationId:conversation.id,messageId:mode==='wrong-receipt'?'other':message.id,inboundVersion:2,controlRevision:3,firstPair:pair}} as const;
   if(mode==='legacy-downgrade'||mode==='plan-mismatch'||mode==='schema-mismatch') {
    await db.conversationMessage.update({where:{id:message.id},data:{content:plan.body,outboundPresentation:mode==='schema-mismatch'?{...plan,schemaVersion:2}:plan}});
    if(mode==='legacy-downgrade') await delivery.sendPreparedText({...input,text:'legacy overwrite'});
    else await delivery.sendPreparedConversation({...input,deliveryPlan:mode==='plan-mismatch'?{...plan,body:'changed'}:plan,text:mode==='plan-mismatch'?'changed':plan.body});
    expect(provider.sendWhatsAppImage).not.toHaveBeenCalled();expect(provider.sendWhatsAppText).not.toHaveBeenCalled();
    expect((await db.conversationMessage.findUniqueOrThrow({where:{id:message.id}})).content).toBe(plan.body);
    return;
   }
   if(mode==='unknown')await expect(delivery.sendPreparedConversation(input)).rejects.toThrow();
   else if(mode==='concurrent') await Promise.all([delivery.sendPreparedConversation(input),delivery.sendPreparedConversation(input)]);
   else await delivery.sendPreparedConversation(input);
   const stored=await db.conversationMessage.findUniqueOrThrow({where:{id:message.id}});
   expect(provider.sendWhatsAppText).not.toHaveBeenCalled();
   if(mode==='success'||mode==='unknown'||mode==='concurrent'){
    expect(stored.content).toBe(plan.body);expect(stored.outboundPresentation).toEqual(plan);expect(stored.providerDispatchKey).not.toBeNull();
    expect(provider.sendWhatsAppImage).toHaveBeenCalledTimes(1);
    await delivery.sendPreparedConversation(input);expect(provider.sendWhatsAppImage).toHaveBeenCalledTimes(1);
    expect((await db.conversationMessage.findUniqueOrThrow({where:{id:message.id}})).outboundPresentation).toEqual(plan);
   }else{expect(provider.sendWhatsAppImage).not.toHaveBeenCalled();expect(stored.providerDispatchKey).toBeNull();}
   if(mode==='wrong-scope'||mode==='wrong-receipt'){expect(stored.content).toBe('pending');expect(stored.outboundPresentation).toBeNull();}
  }finally{await db.shop.deleteMany({where:{id:shopId}});await db.$disconnect();}
 });
});

suite('ARCH068 recovery image final permit',()=>{
 it.each(['open','closed','control','inbound','tamper','schema','pair'] as const)('checks locked recovery plan and %s evidence',async mode=>{
  const db=new PrismaClient({datasourceUrl:url!});const shopId=randomUUID();const now=new Date();
  try{
   await db.shop.create({data:{id:shopId,domain:`${shopId}.example`,status:'ACTIVE'}});
   const recovery=await db.checkoutRecovery.create({data:{shopId,checkoutToken:randomUUID(),status:'ENGAGED',lastExternalActivityAt:now}});
   await db.recoveryOutreachAttempt.create({data:{checkoutRecoveryId:recovery.id,sequence:1,trigger:'INITIAL',configuredOfferMode:'NONE',recipient:'447700900001',sentAt:new Date(+now-26*3600000)}});
   const conversation=await db.conversation.create({data:{shopId,checkoutRecoveryId:recovery.id,type:'RECOVERY',inboundVersion:2}});
   await db.conversationMessage.create({data:{conversationId:conversation.id,direction:'INBOUND',senderType:'CUSTOMER',status:'SENT',content:'question',providerMessageId:randomUUID(),createdAt:new Date(+now-(mode==='closed'?25*3600000:1000))}});
   const pair={productId:'gid://shopify/Product/1',variantId:null};
   const plan={schemaVersion:1,kind:'IMAGE',body:'The tree is 30cm.',image:{schemaVersion:1,shopId,...pair,publicUrl:'https://media.example/tree.jpg',objectKey:`conversation-products/v1/${'a'.repeat(64)}/${'b'.repeat(64)}/${'c'.repeat(64)}.jpg`,contentSha256:'c'.repeat(64),contentType:'image/jpeg',byteLength:100,width:1125,height:600}} as const;
   const message=await db.conversationMessage.create({data:{conversationId:conversation.id,direction:'OUTBOUND',senderType:'AGENT',status:'PENDING',content:plan.body,outboundPresentation:mode==='schema'?{...plan,schemaVersion:2}:mode==='tamper'?{...plan,body:'tamper'}:plan}});
   const eligibility = vi.fn(async()=>null);
   const fence=new OutboundSendFenceService(db,eligibility,()=>now);
   const context = presentedProductContext({schemaVersion:1,shopId,conversationId:conversation.id,platform:'SHOPIFY',updatedAt:now.toISOString(),references:[{...pair,title:'Tree',observedAt:now.toISOString()}]},[pair],now);

   const input={productContextUpdate:context,senderType:'AGENT',conversationId:conversation.id,shopId,recoveryId:recovery.id,expectedControlRevision:mode==='control'?1:0,expectedInboundVersion:mode==='inbound'?1:2,messageId:message.id,recipient:'447700900001',now,deliveryKind:'IMAGE',expectedContent:plan.body,deliveryPlan:plan,presentationReceipt:{shopId,conversationId:conversation.id,messageId:message.id,inboundVersion:mode==='inbound'?1:2,controlRevision:mode==='control'?1:0,firstPair:mode==='pair'?{productId:'other',variantId:null}:pair}} as const;
   const result=await fence.admitFinalSend(input);
   expect(result.kind).toBe(mode==='open'?'admitted':'suppressed');
   const stored=await db.conversationMessage.findUniqueOrThrow({where:{id:message.id}});
   expect(!!stored.providerDispatchKey).toBe(mode==='open');
   if(mode==='open'){
    expect(eligibility).toHaveBeenCalled();
    const storedContext=await db.commerceConversationProductContext.findUniqueOrThrow({where:{conversationId:conversation.id}});
    expect(storedContext.revision).toBe(1);
    expect((await fence.admitFinalSend(input)).kind).toBe('suppressed');
    expect(await db.commerceConversationProductContext.findUniqueOrThrow({where:{conversationId:conversation.id}})).toEqual(storedContext);
   }else expect(await db.commerceConversationProductContext.findUnique({where:{conversationId:conversation.id}})).toBeNull();
  }finally{await db.shop.deleteMany({where:{id:shopId}});await db.$disconnect();}
 });
});
