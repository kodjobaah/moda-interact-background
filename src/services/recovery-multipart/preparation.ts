import { compositeTrustedContextV2, readCompositeReceipt, type CompositeReceipt } from './composite.js';
import { exactCommonDecomposition } from './common-decomposition.js';
import { canonicalJson } from '@modainteract/moda-interact-shared/commerce';
import { parseRecoveryCompositeMultipartDeliveryPlanV2,digestRecoveryCompositeMultipartDeliveryPlanV2,type RecoveryCompositeMultipartDeliveryPlanV2 } from '@modainteract/moda-interact-shared/commerce/presentation';
import { readBrandPreparationReceipt,type BrandPreparationReceipt,validConversationPlan } from '../conversation-delivery-plan.js';
import { readBrandMediaPolicyRef,type BrandMediaPolicyRef } from '../conversation-brand-media.js';
import { canonicalWhatsAppSender } from '../whatsapp-contact-opt-out/phone.js';
import { commonLayoutBody,type CommonLayoutReceipt } from './common-layout.js';
import { requireFrozenMultipart,deliveryDeadline,sha256,type FrozenMultipart } from './frozen.js';
/** Persisted on HUMAN before transport/root creation, so crash recovery never
 * resolves a replacement logo, source, control or customer-inbound snapshot. */
export type CommonMultipartPreparation={compositeReceipt?:CompositeReceipt;plan:RecoveryCompositeMultipartDeliveryPlanV2;policyRef:BrandMediaPolicyRef|null;receipt:BrandPreparationReceipt};
export function readCommonMultipartPreparation(raw:unknown,common:CommonLayoutReceipt):CommonMultipartPreparation|null{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;const r=raw as Record<string,unknown>;
 if(Object.keys(r).length!==(r.compositeReceipt===undefined?3:4)||!['plan','policyRef','receipt'].every(k=>Object.hasOwn(r,k)))return null;
 const receipt=readBrandPreparationReceipt(r.receipt),policyRef=r.policyRef===null?null:readBrandMediaPolicyRef(r.policyRef);if(!receipt||receipt.shopId!==common.shopId||r.policyRef!==null&&!policyRef)return null;
 const compositeReceipt=r.compositeReceipt===undefined?undefined:readCompositeReceipt(r.compositeReceipt);if(r.compositeReceipt!==undefined&&!compositeReceipt)return null;
 const trustedV2=compositeReceipt?compositeTrustedContextV2(compositeReceipt,common,policyRef,receipt.firstPair):null;if(compositeReceipt&&!trustedV2)return null;
 let plan:RecoveryCompositeMultipartDeliveryPlanV2;try{plan=parseRecoveryCompositeMultipartDeliveryPlanV2(r.plan,{checkoutUrl:common.variables['checkout.url'],compositeV2:trustedV2},sha256);}catch{return null;}
 if(!!compositeReceipt!==plan.parts.some(p=>p.plan.kind==='COMPOSITE_IMAGE'))return null;
 if(!exactCommonDecomposition(plan,common))return null;
 for(const p of plan.parts){if(p.plan.kind==='COMPOSITE_IMAGE'?!trustedV2:!validConversationPlan(p.plan,p.plan.body,receipt.shopId,{...receipt,messageId:receipt.sourceId}))return null;if(p.plan.kind==='BRAND_IMAGE'&&(!policyRef||policyRef.publicOrigin!==p.plan.image.publicOrigin))return null;}
 return {plan,policyRef,receipt,...(compositeReceipt?{compositeReceipt}:{})};
}
export function prepareFrozenCommonReply(input:{preparation:CommonMultipartPreparation;common:CommonLayoutReceipt;messageId:string;recoveryId:string;recipient:string;sender:FrozenMultipart['sender'];command:FrozenMultipart['command'];now:Date;productContextUpdate?:FrozenMultipart['productContextUpdate']}):FrozenMultipart{
 const prepared=readCommonMultipartPreparation(input.preparation,input.common);const recipient=canonicalWhatsAppSender(input.recipient);if(!prepared||!recipient)throw new Error('INVALID_COMMON_MULTIPART_PREPARATION');
 return requireFrozenMultipart({schemaVersion:1,kind:'RECOVERY_MULTIPART_PREPARATION',messageId:input.messageId,body:commonLayoutBody(input.common),checkoutUrl:input.common.variables['checkout.url'],recipient,recoveryId:input.recoveryId,actor:prepared.receipt.sourceKind==='HUMAN_COMMAND'?'HUMAN':'AGENT',receipt:prepared.receipt,recoveryShopHeader:input.common,policyRef:prepared.policyRef,command:input.command,sender:input.sender,...(prepared.compositeReceipt?{compositeReceipt:prepared.compositeReceipt}:{}),plan:prepared.plan,planDigest:digestRecoveryCompositeMultipartDeliveryPlanV2(prepared.plan,sha256),frozenAt:input.now.toISOString(),deadlineAt:deliveryDeadline(input.now).toISOString(),...(input.productContextUpdate?{productContextUpdate:input.productContextUpdate}:{})});
}
export const sameCommonPreparation=(a:CommonMultipartPreparation,b:CommonMultipartPreparation)=>canonicalJson(a)===canonicalJson(b);
