import { z } from 'zod';
import { canonicalJson, commerceStoreHostname } from '@modainteract/moda-interact-shared/commerce';
import { ConversationPreparedBrandImageSchema, ConversationPreparedProductImageSchema, ConversationVerifiedProductsSchema, chooseConversationProductImageSource, buildRecoveryCompositeImagePlan, buildRecoveryCompositeMultipartDeliveryPlan, type RecoveryCompositeTrustedContext, type RecoveryCompositeMultipartDeliveryPlan } from '@modainteract/moda-interact-shared/commerce/presentation';
import { prepareRecoveryCompositeImage, RECOVERY_COMPOSITE_FONT_MANIFEST_SHA256 } from '@modainteract/moda-interact-shared/commerce/presentation/node';
import { readR2Configuration, readShopBrandPublicMediaConfiguration } from '../platform-configuration/consumers.js';
import { loadShopBrandR2Credentials } from '../shop-brand-media/r2-config.js';
import { resolveConversationLogo, readBrandMediaPolicyRef, currentBrandPlanMatches, type ConversationLogoResolver, type BrandMediaPolicyRef } from '../conversation-brand-media.js';
import { prepareConversationDelivery } from '../conversation-product-media.js';
import { digest } from '../conversation-wrappers/projection.js';
import { commonLayoutBody, type CommonLayoutReceipt } from './common-layout.js';
import type { BrandPreparationReceipt } from '../conversation-delivery-plan.js';
import type { SqlTransaction } from '../recovery-conversation/recovery-conversation.sql.js';
import type { CommercePresentationInput } from '../conversation-wrappers/contracts.js';

/** Host-owned immutable source/output attestation, separate from stored plan provenance. */
const Receipt = z.strictObject({schemaVersion:z.literal(1),logo:ConversationPreparedBrandImageSchema,
 product:ConversationPreparedProductImageSchema.nullable(), verifiedProducts:ConversationVerifiedProductsSchema.nullable(),
 factsSha256:z.string().regex(/^[a-f0-9]{64}$/),fontAssetSha256:z.string().regex(/^[a-f0-9]{64}$/),
 output:z.strictObject({contentSha256:z.string().regex(/^[a-f0-9]{64}$/),byteLength:z.number().int().positive().max(5*1024*1024-1)})});
export type CompositeReceipt=z.infer<typeof Receipt>;
export const compositeReplyEnabled=()=>process.env.RECOVERY_COMPOSITE_REPLY_ENABLED==='true';
export function readCompositeReceipt(raw:unknown):CompositeReceipt|null{const p=Receipt.safeParse(raw);return p.success?p.data:null;}
export function compositeTrustedContext(raw:unknown,common:CommonLayoutReceipt,policy:BrandMediaPolicyRef|null,firstPair:BrandPreparationReceipt['firstPair']):RecoveryCompositeTrustedContext|null{
 const r=readCompositeReceipt(raw);if(!r||!policy||policy.publicOrigin!==r.logo.publicOrigin||r.logo.origin.shopId!==common.shopId||r.logo.origin.shopDomain!==commerceStoreHostname(common.variables['shop.websiteUrl'])||!['LOGO','SQUARE_LOGO'].includes(r.logo.origin.role)||r.factsSha256!==digest(canonicalJson(r.verifiedProducts)))return null;
 if(r.product){
  if(!r.verifiedProducts||r.verifiedProducts.shopId!==common.shopId||!firstPair||r.product.shopId!==common.shopId||r.product.productId!==firstPair.productId||r.product.variantId!==firstPair.variantId)return null;
  const selected=chooseConversationProductImageSource({shopId:common.shopId,platform:r.verifiedProducts.platform,displayedPairs:[firstPair],verifiedProducts:r.verifiedProducts});
  if(selected.kind==='OMITTED')return null;
 }else if(r.verifiedProducts!==null)return null;
 return {provenance:{schemaVersion:1,shopId:common.shopId,logo:{origin:r.logo.origin,contentSha256:r.logo.contentSha256},product:r.product?{shopId:common.shopId,platform:r.verifiedProducts!.platform,productId:r.product.productId,variantId:r.product.variantId,contentSha256:r.product.contentSha256}:null,
 headerText:common.boundaries.header,commonReferenceHash:digest(canonicalJson(common.commonRef)),layoutVersion:'RECOVERY_COMPOSITE_V1',rendererVersion:'RECOVERY_COMPOSITE_V1',fontAssetSha256:r.fontAssetSha256},publicOrigin:policy.publicOrigin,answerText:common.boundaries.body,footerText:common.boundaries.footer,logicalBody:commonLayoutBody(common),checkoutUrl:common.variables['checkout.url'],output:r.output};
}
export async function currentCompositeMatches(tx:SqlTransaction,raw:unknown,common:CommonLayoutReceipt,policy:BrandMediaPolicyRef|null,firstPair:BrandPreparationReceipt['firstPair']):Promise<boolean>{
 const r=readCompositeReceipt(raw);return !!r&&!!compositeTrustedContext(r,common,policy,firstPair)&&await currentBrandPlanMatches(tx,{schemaVersion:1,kind:'BRAND_IMAGE',body:commonLayoutBody(common),image:r.logo},common.shopId,policy??undefined);
}
export type CompositeDependencies={logoResolver?:ConversationLogoResolver;product?:typeof prepareConversationDelivery;prepare?:typeof prepareRecoveryCompositeImage;settings?:typeof readShopBrandPublicMediaConfiguration;credentials?:typeof readR2Configuration;now?:()=>number};
/** ONE original optional-media child deadline, shared across logo/product/render/R2/probe. */
export async function prepareCompositeReply(input:{common:CommonLayoutReceipt;presentedPairs:{productId:string;variantId:string|null}[];presentation?:CommercePresentationInput;deadlineAt:number;signal?:AbortSignal|undefined},deps:CompositeDependencies={}):Promise<{plan:RecoveryCompositeMultipartDeliveryPlan;receipt:CompositeReceipt;policy:BrandMediaPolicyRef}|null>{
 const now=deps.now??Date.now,start=now();if(!Number.isFinite(start)||!Number.isFinite(input.deadlineAt))return null;
 const budget=Math.floor(Math.min(5000,input.deadlineAt-start-1000));if(!Number.isFinite(budget)||budget<=0||input.signal?.aborted||Array.from(input.common.boundaries.body+input.common.boundaries.footer).length>1024)return null;
 const deadlineAt=start+budget,signal=input.signal?AbortSignal.any([input.signal,AbortSignal.timeout(budget)]):AbortSignal.timeout(budget);
 const work=async()=>{
 const resolved=await(deps.logoResolver??resolveConversationLogo)(input.common.shopId);const policy=readBrandMediaPolicyRef(resolved?.policyRef);if(!resolved||!policy||signal.aborted||now()>=deadlineAt)return null;
 const product=input.presentation&&input.presentedPairs.length?await(deps.product??prepareConversationDelivery)({body:input.common.boundaries.footer,binding:{variable:'response.productImage',placement:'BEFORE_BODY',optional:true},shopId:input.common.shopId,displayedPairs:input.presentedPairs,verifiedProducts:input.presentation.verifiedProducts,deadlineAt,signal}):null;
 // A requested product image that cannot be proved does not silently become a logo-only product reply.
 if(input.presentation&&input.presentedPairs.length&&product?.plan.kind!=='IMAGE')return null;
 if(signal.aborted||now()>=deadlineAt)return null;
 const proof=product?.plan.kind==='IMAGE'?input.presentation!.verifiedProducts??null:null;
 const receipt:CompositeReceipt={schemaVersion:1,logo:resolved.image,product:product?.plan.kind==='IMAGE'?product.plan.image:null,verifiedProducts:proof,factsSha256:digest(canonicalJson(proof)),fontAssetSha256:RECOVERY_COMPOSITE_FONT_MANIFEST_SHA256,output:{contentSha256:'0'.repeat(64),byteLength:1}};
 const trusted=compositeTrustedContext(receipt,input.common,policy,input.presentedPairs[0]??null);if(!trusted)return null;
 const [settings,credentials]=await Promise.all([(deps.settings??readShopBrandPublicMediaConfiguration)(),(deps.credentials??readR2Configuration)()]);
 if(settings.publicOrigin!==policy.publicOrigin||signal.aborted||now()>=deadlineAt)return null;
 const result=await(deps.prepare??prepareRecoveryCompositeImage)({provenance:trusted.provenance,logo:receipt.logo,product:receipt.product?{image:receipt.product,platform:proof!.platform}:null,publicOrigin:settings.publicOrigin,bucketName:settings.bucketName,r2:loadShopBrandR2Credentials(credentials),signal,deadlineAt});
 if(result.kind!=='READY'||signal.aborted||now()>=deadlineAt)return null;
 receipt.output={contentSha256:result.image.contentSha256,byteLength:result.image.byteLength};
 const finalTrusted=compositeTrustedContext(receipt,input.common,policy,input.presentedPairs[0]??null)!;
 const plan=buildRecoveryCompositeImagePlan({image:result.image,trusted:finalTrusted},digest);
 return {plan:buildRecoveryCompositeMultipartDeliveryPlan({plan,trusted:finalTrusted},digest),receipt,policy};
 };
 let listener:(()=>void)|undefined;
 try{return await Promise.race([work(),new Promise<null>(resolve=>{listener=()=>resolve(null);signal.addEventListener('abort',listener,{once:true});if(signal.aborted)listener();})]);}catch{return null;}finally{if(listener)signal.removeEventListener('abort',listener);}
}
