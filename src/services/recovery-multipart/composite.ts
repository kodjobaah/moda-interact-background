import { hasCanonicalCompositeFooter } from './common-decomposition.js';
import { readTemplateCompositeProfile } from './composite-profile.js';
import { z } from 'zod';
import { canonicalJson, commerceStoreHostname } from '@modainteract/moda-interact-shared/commerce';
import { ConversationPreparedBrandImageSchema, ConversationPreparedProductImageSchema, ConversationVerifiedProductsSchema, chooseConversationProductImageSource, buildRecoveryCompositeImagePlanV2, buildRecoveryCompositeMultipartDeliveryPlanV2, type RecoveryCompositeTrustedContextV2, type RecoveryCompositeMultipartDeliveryPlanV2 } from '@modainteract/moda-interact-shared/commerce/presentation';
import { prepareRecoveryCompositeImageV2, getRecoveryCompositeRuntimeIdentityV2 } from '@modainteract/moda-interact-shared/commerce/presentation/node';
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
const Receipt=z.strictObject({schemaVersion:z.literal(2),logo:ConversationPreparedBrandImageSchema,
 product:ConversationPreparedProductImageSchema.nullable(),verifiedProducts:ConversationVerifiedProductsSchema.nullable(),factsSha256:z.string().regex(/^[a-f0-9]{64}$/),templateReferenceHash:z.string().regex(/^[a-f0-9]{64}$/),
 fontResourceSha256:z.string().regex(/^[a-f0-9]{64}$/),runtimeSha256:z.string().regex(/^[a-f0-9]{64}$/),
 output:z.strictObject({contentSha256:z.string().regex(/^[a-f0-9]{64}$/),byteLength:z.number().int().positive().max(5*1024*1024-1),width:z.number().int().positive(),height:z.number().int().positive(),profileSha256:z.string().regex(/^[a-f0-9]{64}$/),renderIdentitySha256:z.string().regex(/^[a-f0-9]{64}$/)})});
export type CompositeReceipt=z.infer<typeof Receipt>;
type SourceProof=Pick<CompositeReceipt,'logo'|'product'|'verifiedProducts'|'factsSha256'>;
export const compositeReplyEnabled=()=>process.env.RECOVERY_COMPOSITE_REPLY_ENABLED==='true';
export function readCompositeReceipt(raw:unknown):CompositeReceipt|null{const p=Receipt.safeParse(raw);return p.success?p.data:null;}
function trustedSources(r:SourceProof,common:CommonLayoutReceipt,policy:BrandMediaPolicyRef|null,firstPair:BrandPreparationReceipt['firstPair']):boolean{
 if(!policy||policy.publicOrigin!==r.logo.publicOrigin||r.logo.origin.shopId!==common.shopId||r.logo.origin.shopDomain!==commerceStoreHostname(common.variables['shop.websiteUrl'])||!['LOGO','SQUARE_LOGO'].includes(r.logo.origin.role)||r.factsSha256!==digest(canonicalJson(r.verifiedProducts)))return false;
 if(r.product){
  if(!r.verifiedProducts||r.verifiedProducts.shopId!==common.shopId||!firstPair||r.product.shopId!==common.shopId||r.product.productId!==firstPair.productId||r.product.variantId!==firstPair.variantId)return false;
  const selected=chooseConversationProductImageSource({shopId:common.shopId,platform:r.verifiedProducts.platform,displayedPairs:[firstPair],verifiedProducts:r.verifiedProducts});if(selected.kind==='OMITTED')return false;
 }else if(r.verifiedProducts!==null)return false;
 return true;
}
function sourceProvenance(r:SourceProof,common:CommonLayoutReceipt){return {shopId:common.shopId,logo:{origin:r.logo.origin,contentSha256:r.logo.contentSha256},product:r.product?{shopId:common.shopId,platform:r.verifiedProducts!.platform,productId:r.product.productId,variantId:r.product.variantId,contentSha256:r.product.contentSha256}:null,headerText:common.boundaries.header,commonReferenceHash:digest(canonicalJson(common.commonRef))};}
function boundaries(common:CommonLayoutReceipt,policy:BrandMediaPolicyRef){return {publicOrigin:policy.publicOrigin,answerText:common.boundaries.body,footerText:common.boundaries.footer,logicalBody:commonLayoutBody(common),checkoutUrl:common.variables['checkout.url']};}
export function compositeTrustedContextV2(raw:unknown,common:CommonLayoutReceipt,policy:BrandMediaPolicyRef|null,firstPair:BrandPreparationReceipt['firstPair']):RecoveryCompositeTrustedContextV2|null{
 const r=readCompositeReceipt(raw);if(!r||r.schemaVersion!==2||!policy||!hasCanonicalCompositeFooter(common)||!trustedSources(r,common,policy,firstPair))return null;
 const selected=readTemplateCompositeProfile(common);if(!selected||r.templateReferenceHash!==digest(canonicalJson(common.commonRef)))return null;
 return {provenance:{schemaVersion:2,...sourceProvenance(r,common),layoutVersion:'RECOVERY_COMPOSITE_V2',rendererVersion:'RECOVERY_COMPOSITE_V2',profile:selected.profile,profileSha256:selected.profileSha256,fontResourceSha256:r.fontResourceSha256,runtimeSha256:r.runtimeSha256},...boundaries(common,policy),body:common.boundaries.body+common.boundaries.footer,output:r.output};
}
export async function currentCompositeMatches(tx:SqlTransaction,raw:unknown,common:CommonLayoutReceipt,policy:BrandMediaPolicyRef|null,firstPair:BrandPreparationReceipt['firstPair']):Promise<boolean>{
 const r=readCompositeReceipt(raw);return !!r&&(!!compositeTrustedContextV2(r,common,policy,firstPair))&&await currentBrandPlanMatches(tx,{schemaVersion:1,kind:'BRAND_IMAGE',body:commonLayoutBody(common),image:r.logo},common.shopId,policy??undefined);
}
export type CompositeDependencies={logoResolver?:ConversationLogoResolver;product?:typeof prepareConversationDelivery;prepare?:typeof prepareRecoveryCompositeImageV2;settings?:typeof readShopBrandPublicMediaConfiguration;credentials?:typeof readR2Configuration;now?:()=>number};
/** ONE original optional-media child deadline, shared across logo/product/render/R2/probe. */
export async function prepareCompositeReply(input:{common:CommonLayoutReceipt;presentedPairs:{productId:string;variantId:string|null}[];presentation?:CommercePresentationInput;deadlineAt:number;signal?:AbortSignal|undefined},deps:CompositeDependencies={}):Promise<{plan:RecoveryCompositeMultipartDeliveryPlanV2;receipt:CompositeReceipt;policy:BrandMediaPolicyRef}|null>{
 const now=deps.now??Date.now,start=now();if(!hasCanonicalCompositeFooter(input.common)||!Number.isFinite(start)||!Number.isFinite(input.deadlineAt))return null;
 const budget=Math.floor(Math.min(5000,input.deadlineAt-start-1000));if(!Number.isFinite(budget)||budget<=0||input.signal?.aborted||Array.from(input.common.boundaries.body+input.common.boundaries.footer).length>1024)return null;
 const deadlineAt=start+budget,signal=input.signal?AbortSignal.any([input.signal,AbortSignal.timeout(budget)]):AbortSignal.timeout(budget);
 const work=async()=>{
 const selected=readTemplateCompositeProfile(input.common);if(!selected||signal.aborted||now()>=deadlineAt)return null;
 const resolved=await(deps.logoResolver??resolveConversationLogo)(input.common.shopId);const policy=readBrandMediaPolicyRef(resolved?.policyRef);if(!resolved||!policy||signal.aborted||now()>=deadlineAt)return null;
 const product=input.presentation&&input.presentedPairs.length?await(deps.product??prepareConversationDelivery)({body:input.common.boundaries.footer,binding:{variable:'response.productImage',placement:'BEFORE_BODY',optional:true},shopId:input.common.shopId,displayedPairs:input.presentedPairs,verifiedProducts:input.presentation.verifiedProducts,deadlineAt,signal}):null;
 // A requested product image that cannot be proved does not silently become a logo-only product reply.
 if(input.presentation&&input.presentedPairs.length&&product?.plan.kind!=='IMAGE')return null;
 if(signal.aborted||now()>=deadlineAt)return null;
 const proof=product?.plan.kind==='IMAGE'?input.presentation!.verifiedProducts??null:null;
 const sources:SourceProof={logo:resolved.image,product:product?.plan.kind==='IMAGE'?product.plan.image:null,verifiedProducts:proof,factsSha256:digest(canonicalJson(proof))};
 if(!trustedSources(sources,input.common,policy,input.presentedPairs[0]??null))return null;
 const identity=getRecoveryCompositeRuntimeIdentityV2({profile:selected.profile,profileSha256:selected.profileSha256});
 const provenance:RecoveryCompositeTrustedContextV2['provenance']={schemaVersion:2,...sourceProvenance(sources,input.common),layoutVersion:'RECOVERY_COMPOSITE_V2',rendererVersion:'RECOVERY_COMPOSITE_V2',profile:selected.profile,profileSha256:selected.profileSha256,fontResourceSha256:identity.fontResourceSha256,runtimeSha256:identity.runtimeSha256};
 const [settings,credentials]=await Promise.all([(deps.settings??readShopBrandPublicMediaConfiguration)(),(deps.credentials??readR2Configuration)()]);
 if(settings.publicOrigin!==policy.publicOrigin||signal.aborted||now()>=deadlineAt)return null;
 const result=await(deps.prepare??prepareRecoveryCompositeImageV2)({profile:selected.profile,profileSha256:selected.profileSha256,provenance,logo:sources.logo,product:sources.product?{image:sources.product,platform:proof!.platform}:null,publicOrigin:settings.publicOrigin,bucketName:settings.bucketName,r2:loadShopBrandR2Credentials(credentials),signal,deadlineAt});
 if(result.kind!=='READY'||signal.aborted||now()>=deadlineAt)return null;
 const receipt:CompositeReceipt={schemaVersion:2,...sources,templateReferenceHash:digest(canonicalJson(input.common.commonRef)),fontResourceSha256:identity.fontResourceSha256,runtimeSha256:identity.runtimeSha256,output:{contentSha256:result.image.contentSha256,byteLength:result.image.byteLength,width:result.image.width,height:result.image.height,profileSha256:result.image.provenance.profileSha256,renderIdentitySha256:result.image.renderIdentitySha256}};
 const finalTrusted=compositeTrustedContextV2(receipt,input.common,policy,input.presentedPairs[0]??null);if(!finalTrusted)return null;
 const plan=buildRecoveryCompositeImagePlanV2({image:result.image,trusted:finalTrusted},digest);
 return {plan:buildRecoveryCompositeMultipartDeliveryPlanV2({plan,trusted:finalTrusted},digest),receipt,policy};
 };
 let listener:(()=>void)|undefined;
 try{return await Promise.race([work(),new Promise<null>(resolve=>{listener=()=>resolve(null);signal.addEventListener('abort',listener,{once:true});if(signal.aborted)listener();})]);}catch{return null;}finally{if(listener)signal.removeEventListener('abort',listener);}
}
