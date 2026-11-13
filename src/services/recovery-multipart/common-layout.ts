import { canonicalJson } from '@modainteract/moda-interact-shared/commerce';
import { readCommonRecoveryLayoutReference,renderPreparedWrapper,type CommonRecoveryLayoutReference,type VerifiedWrapperContext } from '@modainteract/moda-interact-shared/commerce/presentation';
import { digest,readPreparedWrapper } from '../conversation-wrappers/projection.js';
import { readRecoveryShopHeader,verifiedRecoveryShopHeader,type RecoveryShopHeaderReceipt } from '../conversation-wrappers/recovery-shop-header.js';
import { validRecoveryCheckoutFooterUrl } from '../conversation-wrappers/recovery-checkout-footer.js';
import { trustedHttpsUrl } from '../conversation-wrappers/repository.js';
import { first,type SqlTransaction } from '../recovery-conversation/recovery-conversation.sql.js';
import { isCheckoutRecoveryWithinLifetime,parseCheckoutRecoveryLifetimeDays } from '../recovery-lifetime/checkout-recovery-lifetime.js';
export type CommonLayoutVariables=Readonly<{'shop.name':string;'shop.websiteUrl':string;'checkout.url':string}>;
export type CommonLayoutReceipt=Readonly<{schemaVersion:2;kind:'RECOVERY_COMMON_LAYOUT';shopId:string;commonRef:CommonRecoveryLayoutReference;variables:CommonLayoutVariables;boundaries:Readonly<{header:string;body:string;footer:string}>}>;
export type RecoveryLayoutReceipt=RecoveryShopHeaderReceipt|CommonLayoutReceipt;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
/** Same owning saved-identity policy as the legacy header. Domain fallback is
 * explicit merchant identity, never a guessed display name or model value. */
export function commonLayoutVariables(shopId:string,domain:string,brandName:unknown,checkoutUrl:string):CommonLayoutVariables|null{
 const identity=verifiedRecoveryShopHeader(shopId,domain,brandName);
 if(!identity||!validRecoveryCheckoutFooterUrl(checkoutUrl)||trustedHttpsUrl(checkoutUrl,domain)!==checkoutUrl)return null;
 return {'shop.name':identity.name??new URL(identity.websiteUrl).hostname,'shop.websiteUrl':identity.websiteUrl,'checkout.url':checkoutUrl};
}
/** Derive boundaries only from the approved renderer's own generated output,
 * never by searching/stripping the authored body. No layout copy lives here. */
export function renderCommonLayoutBoundaries(reference:CommonRecoveryLayoutReference,variables:CommonLayoutVariables,body:string,shopId:string,conversationId=''):CommonLayoutReceipt['boundaries']|null{
 const context:VerifiedWrapperContext={conversationId,shopId,conversationLanguageTag:reference.languageTag,merchantLanguageTag:null,checkoutAvailable:true,variables};
 const material=canonicalJson([reference.prepared,variables,body]);
 let marker:string|null=null;
 for(let i=0;i<4;i++){const candidate=`__MODA_COMMON_BODY_${digest(`${material}:${i}`)}__`;if(!material.includes(candidate)){marker=candidate;break;}}
 if(!marker)return null;
 const probe=renderPreparedWrapper({prepared:reference.prepared,context,responseBody:marker});
 if(probe.kind!=='rendered')return null;
 const at=probe.body.indexOf(marker);if(at<0||probe.body.lastIndexOf(marker)!==at)return null;
 const header=probe.body.slice(0,at),footer=probe.body.slice(at+marker.length);
 const actual=renderPreparedWrapper({prepared:reference.prepared,context,responseBody:body});
 return actual.kind==='rendered'&&actual.body===header+body+footer?{header,body,footer}:null;
}
export function readCommonLayoutReceipt(raw:unknown,conversationId=''):CommonLayoutReceipt|null{
 if(!object(raw)||!exact(raw,['schemaVersion','kind','shopId','commonRef','variables','boundaries'])||raw.schemaVersion!==2||raw.kind!=='RECOVERY_COMMON_LAYOUT'||typeof raw.shopId!=='string'||!raw.shopId||raw.shopId.length>128||!object(raw.variables)||!exact(raw.variables,['shop.name','shop.websiteUrl','checkout.url'])||!object(raw.boundaries)||!exact(raw.boundaries,['header','body','footer']))return null;
 const values=raw.variables;
 if(typeof values['shop.name']!=='string'||typeof values['shop.websiteUrl']!=='string'||typeof values['checkout.url']!=='string')return null;
 const normalized=commonLayoutVariables(raw.shopId,values['shop.websiteUrl'],values['shop.name'],values['checkout.url']);
 if(!normalized||canonicalJson(normalized)!==canonicalJson(values))return null;
 const ref=readCommonRecoveryLayoutReference(raw.commonRef,digest);if(ref.kind!=='ok')return null;
 const boundaries=raw.boundaries;
 if(!['header','body','footer'].every(k=>typeof boundaries[k]==='string'&&String(boundaries[k]).length<=4096)||typeof boundaries.body!=='string'||!boundaries.body.trim())return null;
 const rendered=renderCommonLayoutBoundaries(ref.reference,normalized,boundaries.body,raw.shopId,conversationId);
 if(!rendered||canonicalJson(rendered)!==canonicalJson(boundaries)||rendered.header.length+rendered.body.length+rendered.footer.length>4096)return null;
 return {schemaVersion:2,kind:'RECOVERY_COMMON_LAYOUT',shopId:raw.shopId,commonRef:ref.reference,variables:normalized,boundaries:rendered};
}
export function readRecoveryLayoutReceipt(raw:unknown,conversationId=''):RecoveryLayoutReceipt|null{return readRecoveryShopHeader(raw)??readCommonLayoutReceipt(raw,conversationId);}
export function commonLayoutBody(receipt:CommonLayoutReceipt):string{return receipt.boundaries.header+receipt.boundaries.body+receipt.boundaries.footer;}
export function humanCommonLayoutApplicationKey(input:{commandId:string;conversationId:string;shopId:string;slotEditVersion:number;textBody:string;body:string;receipt:CommonLayoutReceipt}):string{
 return digest(canonicalJson({schemaVersion:2,kind:'RECOVERY_COMMON_HUMAN_APPLICATION',...input}));
}
/** Fresh authority only; pure reference snapshots are never their own grant.
 * Invoked within the existing Shop→Conversation final-permit transaction. */
export async function currentCommonLayoutMatches(tx:SqlTransaction,receipt:CommonLayoutReceipt,body:string,input:{shopId:string;conversationId:string;recoveryId?:string;slotEditVersion?:number;now?:Date}):Promise<boolean>{
 const parsed=readCommonLayoutReceipt(receipt,input.conversationId);if(!parsed||parsed.shopId!==input.shopId||commonLayoutBody(parsed)!==body)return false;
 const shop=await first<{domain:string;status:string}>(tx,`SELECT "domain","status"::text FROM "commerce"."Shop" WHERE "id"=$1 FOR SHARE`,input.shopId);
 const brand=await first<{brandName:string|null}>(tx,`SELECT "brandName" FROM "commerce"."ShopBrand" WHERE "shopId"=$1 FOR SHARE`,input.shopId);
 const recovery=await first<{id:string;checkoutUrl:string|null;expiredAt:Date|null;lastExternalActivityAt:Date;status:string}>(tx,`SELECT r."id",r."checkoutUrl",r."expiredAt",r."lastExternalActivityAt",r."status"::text
   FROM "commerce"."CheckoutRecovery" r JOIN "whatsapp"."Conversation" c ON c."checkoutRecoveryId"=r."id"
   WHERE c."id"=$1 AND r."shopId"=$2 AND (c."shopId" IS NULL OR c."shopId"=$2) FOR SHARE OF r`,input.conversationId,input.shopId);
 const policy=await first<{checkoutRecoveryLifetimeDays:number}>(tx,`SELECT "checkoutRecoveryLifetimeDays" FROM "public"."BackgroundRuntimeConfig" WHERE "id"='default' FOR SHARE`);
 const now=input.now??new Date();let days:number;try{days=parseCheckoutRecoveryLifetimeDays(policy?.checkoutRecoveryLifetimeDays);}catch{return false;}
 if(!shop||shop.status!=='ACTIVE'||!recovery||input.recoveryId!==undefined&&recovery.id!==input.recoveryId||!['DETECTED','MESSAGE_SENT','ENGAGED'].includes(recovery.status)||recovery.expiredAt&&recovery.expiredAt<=now||!isCheckoutRecoveryWithinLifetime({lastExternalActivityAt:recovery.lastExternalActivityAt,now,checkoutRecoveryLifetimeDays:days}))return false;
 const variables=commonLayoutVariables(input.shopId,shop.domain,brand?.brandName,trustedHttpsUrl(recovery.checkoutUrl,shop.domain)??'');if(!variables||canonicalJson(variables)!==canonicalJson(parsed.variables))return false;
 return currentCommonReferenceMatches(tx,parsed.commonRef,input.slotEditVersion);
}
export async function currentCommonReferenceMatches(tx:SqlTransaction,ref:CommonRecoveryLayoutReference,slotEditVersion?:number):Promise<boolean>{
 const parsedRef=readCommonRecoveryLayoutReference(ref,digest);if(parsedRef.kind!=='ok')return false;
 const active=await first<{definitionId:string;editVersion:number;sourceHash:string;kind:string;status:string;audience:string;publishedAt:Date|null;retiredAt:Date|null;sourceLanguageTag:string;astSchemaVersion:number;createdByAdminId:string}>(tx,`SELECT slot."definitionId",slot."editVersion",def."sourceHash",def."kind"::text,def."status"::text,def."audience"::text,def."publishedAt",def."retiredAt",def."sourceLanguageTag",def."astSchemaVersion",def."createdByAdminId"
   FROM "whatsapp"."WhatsAppConversationWrapperActiveSlot" slot JOIN "whatsapp"."WhatsAppTemplateDefinition" def ON def."id"=slot."definitionId"
   WHERE slot."audience"='SHARED' FOR SHARE OF slot,def`);
 if(!active||active.definitionId!==ref.definitionId||active.sourceHash!==ref.sourceHash||active.audience!=='SHARED'||active.kind!=='MODA_CONVERSATION_WRAPPER'||active.status!=='PUBLISHED'||!active.publishedAt||active.retiredAt||active.sourceLanguageTag!=='en'||active.astSchemaVersion!==1||!active.createdByAdminId||slotEditVersion!==undefined&&active.editVersion!==slotEditVersion)return false;
 const locale=await first<{definitionId:string;languageTag:string;contentHash:string|null;status:string;localeAst:unknown;providerLanguageCode:string|null;reviewedAt:Date|null;reviewedByAdminId:string|null}>(tx,`SELECT "definitionId","languageTag","contentHash","status"::text,"localeAst","providerLanguageCode","reviewedAt","reviewedByAdminId" FROM "whatsapp"."WhatsAppTemplateLocale" WHERE "id"=$1 FOR SHARE`,ref.localeId);
 if(!locale||locale.definitionId!==ref.definitionId||locale.languageTag!==ref.languageTag||locale.contentHash!==ref.contentHash||locale.providerLanguageCode!==null||!(locale.languageTag==='en'?locale.status==='SOURCE_SAVED':locale.status==='REVIEWED'&&locale.reviewedAt&&locale.reviewedByAdminId))return false;
 const prepared=readPreparedWrapper(locale.localeAst,locale.contentHash);if(prepared.kind!=='ok')return false;
 const current=readCommonRecoveryLayoutReference({...ref,sourceHash:active.sourceHash,prepared:prepared.prepared},digest);
 return current.kind==='ok'&&canonicalJson(current.reference)===canonicalJson(ref);
}
