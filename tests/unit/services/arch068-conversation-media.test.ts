import {OutboundSendFenceService} from "../../../src/services/recovery-conversation/outbound-send-fence.service.js";
import {describe, it, expect, vi} from 'vitest';
import {prepareConversationDelivery} from '../../../src/services/conversation-product-media.js';
import {sameConversationPlan, validConversationPlan} from '../../../src/services/conversation-delivery-plan.js';
const binding = {variable:'response.productImage', placement:'BEFORE_BODY', optional:true} as const;
const pair = {productId:'tree',variantId:null};
const image = {schemaVersion:1,shopId:'shop',...pair,publicUrl:'https://media.example/tree.jpg',objectKey:`conversation-products/v1/${'a'.repeat(64)}/${'b'.repeat(64)}/${'c'.repeat(64)}.jpg`,contentSha256:'c'.repeat(64),contentType:'image/jpeg',byteLength:100,width:1125,height:600} as const;
describe('frozen conversation plans',()=>{
 it('requires independent exact tenant and first pair receipt',()=>{
  const plan={schemaVersion:1,kind:'IMAGE',body:'The tree is 30cm.',image} as const;
  expect(validConversationPlan(plan,plan.body,'shop',{shopId:'shop',conversationId:'conversation',messageId:'message',inboundVersion:1,controlRevision:2,firstPair:pair})).toBe(true);
  expect(validConversationPlan(plan,plan.body,'foreign',{shopId:'shop',conversationId:'conversation',messageId:'message',inboundVersion:1,controlRevision:2,firstPair:pair})).toBe(false);
  expect(validConversationPlan(plan,plan.body,'shop',{shopId:'shop',conversationId:'conversation',messageId:'message',inboundVersion:1,controlRevision:2,firstPair:{...pair,variantId:'other'}})).toBe(false);
  expect(validConversationPlan(plan,plan.body,'shop')).toBe(false);
  expect(sameConversationPlan({...plan,body:'different'},plan)).toBe(false);
  expect(sameConversationPlan({...plan,schemaVersion:2},plan)).toBe(false);
 });
 it.each([{binding:undefined,pairs:[pair],body:'A tree'},{binding,pairs:[],body:'Returns are accepted.'},{binding,pairs:[pair],body:'🌳'.repeat(1025)}])('skips config and all media work on deterministic text omissions',async input=>{
  const readR2Configuration=vi.fn(),readShopBrandPublicMediaConfiguration=vi.fn(),prepareConversationProductImage=vi.fn();
  const result=await prepareConversationDelivery({body:input.body,binding:input.binding,displayedPairs:input.pairs,shopId:'shop',deadlineAt:Date.now()+5000},{readR2Configuration,readShopBrandPublicMediaConfiguration,prepareConversationProductImage});
  expect(result.plan).toEqual({schemaVersion:1,kind:'TEXT',body:input.body});
  expect(readR2Configuration).not.toHaveBeenCalled(); expect(prepareConversationProductImage).not.toHaveBeenCalled();
 });
});

it('refuses IMAGE without frozen plan and cannot promote image into TEMPLATE privileges',async()=>{
 const db={$transaction:vi.fn()};const fence=new OutboundSendFenceService(db as never,async()=>null);
 const input={senderType:'AGENT',conversationId:'conversation',shopId:'shop',recoveryId:'recovery',expectedControlRevision:0,recipient:'447700900001',now:new Date(),messageId:'message'} as const;
 expect(await fence.admitFinalSend({...input,deliveryKind:'IMAGE'})).toMatchObject({kind:'suppressed',reason:'invalid-presentation'});
 expect(await fence.admitFinalSend({...input,deliveryKind:'TEMPLATE',deliveryPlan:{schemaVersion:1,kind:'IMAGE',body:'A tree',image}})).toMatchObject({kind:'suppressed',reason:'invalid-presentation'});
 expect(db.$transaction).not.toHaveBeenCalled();
});
