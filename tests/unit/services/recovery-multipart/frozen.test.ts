import { describe,it,expect } from 'vitest';
import { buildRecoveryMultipartDeliveryPlan,digestRecoveryMultipartDeliveryPlan } from '@modainteract/moda-interact-shared/commerce/presentation';
import { readFrozenMultipart,requireFrozenMultipart,deliveryDeadline,sha256,humanMultipartMessageId,type FrozenMultipart } from '../../../../src/services/recovery-multipart/frozen.js';
import { verifiedRecoveryShopHeader,withRecoveryShopHeader } from '../../../../src/services/conversation-wrappers/recovery-shop-header.js';
import { withHumanRecoveryCheckoutFooter } from '../../../../src/services/conversation-wrappers/recovery-checkout-footer.js';
const url='https://store.example/checkouts/trusted';const header=verifiedRecoveryShopHeader('shop','store.example','Store')!;
function fixture():FrozenMultipart{
 const body=withRecoveryShopHeader(withHumanRecoveryCheckoutFooter('Your complete answer.',url),header);
 const headerBody=withRecoveryShopHeader(withHumanRecoveryCheckoutFooter('',url),header);
 const answer=withHumanRecoveryCheckoutFooter('Your complete answer.',url);
 const plan=buildRecoveryMultipartDeliveryPlan({checkoutUrl:url,parts:[{role:'HEADER',plan:{schemaVersion:1,kind:'TEXT',body:headerBody}},{role:'ANSWER',plan:{schemaVersion:1,kind:'TEXT',body:answer}}]});
 return {schemaVersion:1,kind:'RECOVERY_MULTIPART_PREPARATION',messageId:'message',body,checkoutUrl:url,recipient:'447400123456',recoveryId:'recovery',actor:'AGENT',receipt:{sourceKind:'MESSAGE',sourceId:'message',shopId:'shop',conversationId:'conversation',controlRevision:2,inboundVersion:5,firstPair:null},recoveryShopHeader:header,policyRef:null,command:null,sender:{providerAccountId:'account',providerPhoneNumberId:'phone'},plan,planDigest:digestRecoveryMultipartDeliveryPlan(plan,sha256),frozenAt:'2026-11-13T00:00:00.000Z',deadlineAt:'2026-11-13T00:02:00.000Z'};
}
describe('ARCH075 frozen original-authority multipart boundary',()=>{
 it('consumes actual published ordered contract with complete logical response and each exact footer',()=>{const source=fixture();expect(requireFrozenMultipart(source)).toEqual(source);expect(source.plan.parts.every(p=>p.plan.body.endsWith(url))).toBe(true);});
 it.each([29,301,NaN,30.5])('rejects unbounded deadline %s',seconds=>{expect(()=>deliveryDeadline(new Date(),seconds)).toThrow('INVALID_MULTIPART_DEADLINE');});
 it('uses120s default and both inclusive boundaries',()=>{const now=new Date();expect(+deliveryDeadline(now)-+now).toBe(120000);expect(+deliveryDeadline(now,30)-+now).toBe(30000);expect(+deliveryDeadline(now,300)-+now).toBe(300000);});
 it.each(['foreign-source','foreign-header','missing-policy','digest','new-prose','sender','extra-field','wrong-footer','actor-array','deadline'] as const)('refuses %s without guessing authority',variant=>{
  const raw=structuredClone(fixture()) as unknown as Record<string,unknown>;
  if(variant==='foreign-source')raw.receipt={...(raw.receipt as object),sourceId:'other-message'};
  if(variant==='foreign-header')raw.recoveryShopHeader={...header,shopId:'other-shop'};
  if(variant==='missing-policy')raw.policyRef={};
  if(variant==='digest')raw.planDigest='0'.repeat(64);
  if(variant==='sender')raw.sender={providerAccountId:'bad sender',providerPhoneNumberId:'phone'};
  if(variant==='extra-field')raw.ownership='model-controlled';
  if(variant==='wrong-footer')raw.checkoutUrl='https://other.example/checkout';
  if(variant==='actor-array')raw.actor=['AGENT'];
  if(variant==='deadline')raw.deadlineAt='2026-11-13T00:06:00.000Z';
  if(variant==='new-prose'){
   const plan=buildRecoveryMultipartDeliveryPlan({checkoutUrl:url,parts:[{role:'ANSWER',plan:{schemaVersion:1,kind:'TEXT',body:withHumanRecoveryCheckoutFooter('Unmoderated new text.',url)}}]});
   raw.plan=plan;raw.planDigest=digestRecoveryMultipartDeliveryPlan(plan,sha256);
  }
  expect(readFrozenMultipart(raw)).toBeNull();
 });
 it.each(['omitted','truncated','reordered'] as const)('refuses %s complete answer despite structurally valid Shared parts',variant=>{
  const source=fixture();const text=variant==='omitted'?'':variant==='truncated'?'Your complete':'answer. Your complete';
  const plan=buildRecoveryMultipartDeliveryPlan({checkoutUrl:url,parts:[source.plan.parts[0]!,{role:'ANSWER',plan:{schemaVersion:1,kind:'TEXT',body:withHumanRecoveryCheckoutFooter(text,url)}}]});
  expect(readFrozenMultipart({...source,plan,planDigest:digestRecoveryMultipartDeliveryPlan(plan,sha256)})).toBeNull();
 });
 it('HUMAN binds original command/lease but does not compare future inbound version',()=>{const source=fixture();const human={...source,messageId:humanMultipartMessageId('command'),actor:'HUMAN' as const,receipt:{...source.receipt,sourceKind:'HUMAN_COMMAND' as const,sourceId:'command'},command:{id:'command',leaseToken:'lease'}};expect(requireFrozenMultipart(human)).toEqual(human);expect(readFrozenMultipart({...human,command:{id:'other-command',leaseToken:'lease'}})).toBeNull();});
});
