import { fitVerifiedProductCaption } from '../../commerce/compact-product-presentation.js';
import { readTemplateCompositeProfile } from './composite-profile.js';
import { prepareCompositeReply, compositeReplyEnabled, type CompositeReceipt, type CompositeDependencies } from './composite.js';
import { buildRecoveryMultipartDeliveryPlan, readCommonRecoveryLayoutReference, composeCommerceWhatsAppPreview, buildConversationBrandImageDeliveryPlan, type RecoveryCompositeMultipartDeliveryPlanV2, type WrapperSlot } from '@modainteract/moda-interact-shared/commerce/presentation';
import { commerceStoreHostname } from '@modainteract/moda-interact-shared/commerce';
import { digest,readPreparedWrapper,stableJson } from '../conversation-wrappers/projection.js';
import { languageChoices,validDefinition } from '../conversation-wrappers/selection.js';
import type { RenderConversationResponseInput,VerifiedWrapperContext,WrappedResult } from '../conversation-wrappers/contracts.js';
import { prepareConversationDelivery } from '../conversation-product-media.js';
import { resolveConversationLogo,readBrandMediaPolicyRef,type ConversationLogoResolver,type BrandMediaPolicyRef } from '../conversation-brand-media.js';
import { commonLayoutVariables,renderCommonLayoutBoundaries,commonLayoutBody,humanCommonLayoutApplicationKey,type CommonLayoutReceipt } from './common-layout.js';
import { wrapperApplicationKey } from '../conversation-wrappers/application-key.js';
export type CommonReplyPreparation=Readonly<{commonLayout:CommonLayoutReceipt;multipartPlan:RecoveryCompositeMultipartDeliveryPlanV2;brandMediaPolicy?:BrandMediaPolicyRef}>;
/** A common-shaped active SHARED revision is the only opt-in. Existing generic
 * audience wrappers remain exact legacy content until coordinated activation. */
export function selectedCommonLayout(slots:readonly WrapperSlot[],context:VerifiedWrapperContext,preferred?:string|null){
 const matches=slots.filter(s=>s.audience==='SHARED');if(matches.length!==1)return null;
 const slot=matches[0]!;if(!validDefinition(slot.definition,slot))return null;
 const choices=languageChoices({conversationTag:context.conversationLanguageTag,merchantTag:context.merchantLanguageTag,preferredTag:preferred,platformFallbackTag:null});if(choices==='invalid')return null;
 const locale=choices.map(tag=>slot.definition.locales.find(l=>l.languageTag===tag)).find(Boolean);if(!locale||locale.providerLanguageCode!==null||locale.status!==(locale.languageTag==='en'?'SOURCE_SAVED':'REVIEWED')||(locale.languageTag!=='en'&&(!locale.reviewedAt||!locale.reviewedByAdminId)))return null;
 const prepared=readPreparedWrapper(locale.localeAst,locale.contentHash);if(prepared.kind!=='ok')return null;
 const parsed=readCommonRecoveryLayoutReference({schemaVersion:1,definitionId:slot.definitionId,sourceHash:slot.definition.sourceHash,localeId:locale.id,languageTag:locale.languageTag,contentHash:locale.contentHash,prepared:prepared.prepared},digest);
 return parsed.kind==='ok'?{slot,reference:parsed.reference}:null;
}
/** No new content formatter. Both the complete body and exact physical
 * boundaries come from the same published renderer and selected SHARED source. */
export async function composeCommonReply(input:RenderConversationResponseInput,context:VerifiedWrapperContext,selected:NonNullable<ReturnType<typeof selectedCommonLayout>>,deps:{logoResolver?:ConversationLogoResolver;mediaDependencies?:Parameters<typeof prepareConversationDelivery>[1];compositeDependencies?:CompositeDependencies}={}):Promise<WrappedResult|null>{
 const website=context.recoveryShopHeader?.websiteUrl;const checkout=context.checkoutAvailable?context.variables['checkout.url']:undefined;
 if(!website||!checkout)return null;
 const variables=commonLayoutVariables(context.shopId,website,context.recoveryShopHeader?.name,checkout);if(!variables)return null;
 let middle=input.responseBody;let presentedPairs:{productId:string;variantId:string|null}[]=[];
 if(input.commercePresentation){
  const p=input.commercePresentation;
  const plain=composeCommerceWhatsAppPreview({responseStyle:'AGENT',envelope:p.envelope,presentation:p.verified,...(context.conversationLanguageTag?{locale:context.conversationLanguageTag}:{}),brandName:context.variables['shopBrand.brandName']??context.variables['shop.name']??null,wrapper:{slots:[],context,digest,platformFallbackLanguageTag:null}});
  if(plain.kind==='refused')return null;middle=plain.body;
  const facts=p.verified.disposition==='PRODUCT_DETAILS'?p.verified.productFacts:p.verified.disposition==='PRODUCT_OPTIONS'?p.verified.optionFacts:null;
  presentedPairs=p.envelope.answerKind==='ANSWER'?(facts?facts.map(({productId,variantId})=>({productId,variantId})):[...(p.productPairs??[])]):[];
 }
 let boundaries=renderCommonLayoutBoundaries(selected.reference,variables,middle,context.shopId,input.conversationId);if(!boundaries)return null;
 let mediaPresentation=input.commercePresentation;
 if(compositeReplyEnabled()&&input.source==='AI'&&input.commercePresentation?.envelope.answerKind==='ANSWER'&&Array.from(boundaries.body+boundaries.footer).length>1024){
  const fitted=fitVerifiedProductCaption(input.commercePresentation,candidate=>renderCommonLayoutBoundaries(selected.reference,variables,candidate,context.shopId,input.conversationId));
  if(fitted){boundaries=fitted.boundaries;presentedPairs=fitted.pairs;mediaPresentation=fitted.presentation;}
 }
 const commonLayout:CommonLayoutReceipt={schemaVersion:2,kind:'RECOVERY_COMMON_LAYOUT',shopId:context.shopId,commonRef:selected.reference,variables,boundaries};
 const body=commonLayoutBody(commonLayout);if(Array.from(body).length>4096)return null;
 let multipartPlan:RecoveryCompositeMultipartDeliveryPlanV2,brandMediaPolicy:BrandMediaPolicyRef|undefined,compositeReceipt:CompositeReceipt|undefined;
 if(compositeReplyEnabled()){
  if(!readTemplateCompositeProfile(commonLayout))return null;
  const prepared=await prepareCompositeReply({common:commonLayout,presentedPairs,...(mediaPresentation?{presentation:mediaPresentation}:{}),deadlineAt:input.mediaDeadlineAt??input.commercePresentation?.deadlineAt??0,...(input.mediaSignal??input.commercePresentation?.signal?{signal:input.mediaSignal??input.commercePresentation?.signal}:{})},{...deps.compositeDependencies,...(deps.logoResolver?{logoResolver:deps.logoResolver}:{})});
  if(prepared){multipartPlan=prepared.plan;brandMediaPolicy=prepared.policy;compositeReceipt=prepared.receipt;}
  else multipartPlan=buildRecoveryMultipartDeliveryPlan({parts:[{role:'ANSWER',plan:{schemaVersion:1,kind:'TEXT',body}}],checkoutUrl:checkout});
 }else {
 const headerBody=boundaries.header+boundaries.footer,answerBody=boundaries.body+boundaries.footer;
 let header:import('@modainteract/moda-interact-shared/commerce/presentation').ConversationMediaDeliveryPlan={schemaVersion:1,kind:'TEXT',body:headerBody};

 if(Array.from(headerBody).length<=1024){try{const resolved=await (deps.logoResolver??resolveConversationLogo)(context.shopId);const policy=readBrandMediaPolicyRef(resolved?.policyRef),image=resolved?.image;
  if(image&&policy&&policy.publicOrigin===image.publicOrigin&&image.origin.shopId===context.shopId&&['LOGO','SQUARE_LOGO'].includes(image.origin.role)&&image.origin.shopDomain===commerceStoreHostname(variables['shop.websiteUrl'])){
   const built=buildConversationBrandImageDeliveryPlan({plan:header,origin:image.origin,publicOrigin:image.publicOrigin,image});if(built.plan.kind!=='IMAGE')header=built.plan;if(header.kind==='BRAND_IMAGE')brandMediaPolicy=policy;
  }
 }catch{/* Optional logo cannot discard authored content. */}}
 const consolidated=brandedMainReplyEnabled();
 const captionFits=!consolidated&&Array.from(answerBody).length<=1024;
 const media=input.commercePresentation?await prepareConversationDelivery({body:captionFits?answerBody:boundaries.footer,binding:{variable:'response.productImage',placement:'BEFORE_BODY',optional:true},shopId:context.shopId,displayedPairs:presentedPairs,verifiedProducts:input.commercePresentation.verifiedProducts,deadlineAt:input.commercePresentation.deadlineAt??Date.now(),signal:input.commercePresentation.signal},deps.mediaDependencies):null;
 const parts:import('@modainteract/moda-interact-shared/commerce/presentation').RecoveryMultipartDeliveryPlan['parts']=[];
 if(consolidated){
  let main:typeof header={schemaVersion:1,kind:'TEXT',body};
  if(Array.from(body).length<=1024&&header.kind==='BRAND_IMAGE')main={...header,body};
  else brandMediaPolicy=undefined;
  if(main.kind==='BRAND_IMAGE'||media?.plan.kind==='IMAGE')parts.push({role:'HEADER',plan:main});
  else parts.push({role:'ANSWER',plan:main});
  if(media?.plan.kind==='IMAGE')parts.push({role:'PRODUCT',plan:media.plan});
 }else {
  parts.push({role:'HEADER',plan:header});
  if(media?.plan.kind==='IMAGE'){parts.push({role:'PRODUCT',plan:media.plan});if(!captionFits)parts.push({role:'ANSWER',plan:{schemaVersion:1,kind:'TEXT',body:answerBody}});}
  else parts.push({role:'ANSWER',plan:{schemaVersion:1,kind:'TEXT',body:answerBody}});
 }
 // If a physical caption/text cannot fit, preserve the whole valid logical
 // response in the existing one-message TEXT fallback, never truncate it.

 try{multipartPlan=buildRecoveryMultipartDeliveryPlan({parts,checkoutUrl:checkout});}
 catch{multipartPlan=buildRecoveryMultipartDeliveryPlan({parts:[{role:'ANSWER',plan:{schemaVersion:1,kind:'TEXT',body}}],checkoutUrl:checkout});brandMediaPolicy=undefined;}
 }
 const responseDigest=input.commercePresentation?digest(stableJson({envelope:input.commercePresentation.envelope,verified:input.commercePresentation.verified,productPairs:input.commercePresentation.productPairs??[],verifiedProducts:input.commercePresentation.verifiedProducts??null})):digest(input.responseBody);
 const applicationKey=input.source==='HUMAN'?humanCommonLayoutApplicationKey({commandId:input.messageIdentity,conversationId:input.conversationId,shopId:context.shopId,slotEditVersion:selected.slot.editVersion,textBody:input.responseBody,body,receipt:commonLayout,...(compositeReceipt?{composite:{plan:multipartPlan,receipt:compositeReceipt,policyRef:brandMediaPolicy??null}}:{})}):wrapperApplicationKey({conversationId:input.conversationId,messageIdentity:input.messageIdentity,source:input.source,wrapperDefinitionId:selected.reference.definitionId,localeId:selected.reference.localeId,contentHash:selected.reference.contentHash,editVersion:selected.slot.editVersion,responseDigest,body,recoveryCheckoutUrl:checkout,commonLayout,multipartPlan,...(compositeReceipt?{compositeReceipt}:{})});
 return {kind:'rendered',body,wrapperDefinitionId:selected.reference.definitionId,localeId:selected.reference.localeId,audience:'SHARED',slotEditVersion:selected.slot.editVersion,languageTag:selected.reference.languageTag,contentHash:selected.reference.contentHash,messageIdentity:input.messageIdentity,source:input.source,applicationKey,responseDigest,replayed:false,recoveryCheckoutUrl:checkout,commonLayout,multipartPlan,presentedPairs,...(compositeReceipt?{compositeReceipt}:{}),...(brandMediaPolicy?{brandMediaPolicy}:{})};
}

/** Reader-first rollout: all unrecognized values keep legacy writes disabled. */
export const brandedMainReplyEnabled=()=>process.env.RECOVERY_BRANDED_MAIN_REPLY_ENABLED==='true';
