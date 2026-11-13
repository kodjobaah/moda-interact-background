import { readRecoveryLayoutReceipt,commonLayoutBody,type RecoveryLayoutReceipt } from "./recovery-multipart/common-layout.js";
import { readBrandMediaPolicyRef, type BrandMediaPolicyRef } from "./conversation-brand-media.js";
import { hasPreparedRecoveryShopHeader } from "./conversation-wrappers/recovery-shop-header.js";
import { canonicalJson } from '@modainteract/moda-interact-shared/commerce';
import { ConversationMediaDeliveryPlanSchema, type ConversationMediaDeliveryPlan } from '@modainteract/moda-interact-shared/commerce/presentation';
/** Receipt is host verified selection metadata, separate from persisted plan JSON. */
export type ConversationDeliveryReceipt = {conversationId: string; messageId: string; inboundVersion: number; controlRevision: number; shopId: string; firstPair: {productId: string; variantId: string | null} | null};
export function sameConversationPlan(actual: unknown, expected: ConversationMediaDeliveryPlan): boolean {
 const parsed = readPersistedConversationPlan(actual);
 return parsed !== null && canonicalJson(parsed.plan) === canonicalJson(expected);
}
export function validConversationPlan(plan: ConversationMediaDeliveryPlan, body: string, shopId: string, receipt?: ConversationDeliveryReceipt): boolean {
 const parsed = ConversationMediaDeliveryPlanSchema.safeParse(plan);
 if (!parsed.success || plan.body !== body) return false;
 if (plan.kind === 'TEXT') return true;
 if (plan.kind === 'BRAND_IMAGE') return plan.image.origin.shopId === shopId && ['LOGO','SQUARE_LOGO'].includes(plan.image.origin.role);
 return !!receipt && receipt.shopId === shopId && plan.image.shopId === shopId &&
  receipt.firstPair?.productId === plan.image.productId && receipt.firstPair.variantId === plan.image.variantId;
}

export function matchesConversationReceipt(receipt: ConversationDeliveryReceipt | undefined, identity: {shopId: string; conversationId: string; messageId: string; expectedInboundVersion?: number; expectedControlRevision?: number}): boolean {
 return !!receipt && receipt.shopId === identity.shopId && receipt.conversationId === identity.conversationId &&
  receipt.messageId === identity.messageId && receipt.inboundVersion === identity.expectedInboundVersion &&
  receipt.controlRevision === identity.expectedControlRevision;
}

import { createHash } from 'node:crypto';
import { digestConversationMediaDeliveryPlan } from '@modainteract/moda-interact-shared/commerce/presentation';
export type BrandPreparationReceipt = Omit<ConversationDeliveryReceipt, 'messageId'> & {
 sourceKind: 'MESSAGE' | 'HUMAN_COMMAND'; sourceId: string;
};
export type FrozenBrandMediaEnvelope = {schemaVersion: 1; kind: 'RECOVERY_BRAND_MEDIA';
 plan: Extract<ConversationMediaDeliveryPlan, {kind: 'BRAND_IMAGE'}>; receipt: BrandPreparationReceipt; recoveryShopHeader: RecoveryLayoutReceipt; policyRef: BrandMediaPolicyRef; planDigest: string};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
export function readBrandPreparationReceipt(value: unknown): BrandPreparationReceipt | null {
 if (!record(value) || !exact(value, ['sourceKind','sourceId','shopId','conversationId','inboundVersion','controlRevision','firstPair']) ||
   (typeof value.sourceKind !== 'string' || !['MESSAGE','HUMAN_COMMAND'].includes(value.sourceKind)) || !id(value.sourceId) || !id(value.shopId) || !id(value.conversationId) ||
   !revision(value.inboundVersion) || !revision(value.controlRevision)) return null;
 const pair = value.firstPair;
 if (pair !== null && (!record(pair) || !exact(pair, ['productId','variantId']) || !id(pair.productId) || !(pair.variantId === null || id(pair.variantId)))) return null;
 return {sourceKind: value.sourceKind as BrandPreparationReceipt['sourceKind'], sourceId: value.sourceId,
  shopId: value.shopId, conversationId: value.conversationId, inboundVersion: value.inboundVersion, controlRevision: value.controlRevision,
  firstPair: pair as BrandPreparationReceipt['firstPair']};
}
export function readFrozenBrandMedia(value: unknown): FrozenBrandMediaEnvelope | null {
 if (!record(value) || !exact(value, ['schemaVersion','kind','plan','receipt','recoveryShopHeader','policyRef','planDigest']) || value.schemaVersion !== 1 || value.kind !== 'RECOVERY_BRAND_MEDIA') return null;
 const policyRef=readBrandMediaPolicyRef(value.policyRef);
 const header = readRecoveryLayoutReceipt(value.recoveryShopHeader);
 const parsed = ConversationMediaDeliveryPlanSchema.safeParse(value.plan); const receipt = readBrandPreparationReceipt(value.receipt);
 if (!parsed.success || parsed.data.kind !== 'BRAND_IMAGE' || !receipt || !policyRef || policyRef.publicOrigin!==parsed.data.image.publicOrigin || !header || header.shopId !== receipt.shopId || !(header.schemaVersion===2?commonLayoutBody(header)===parsed.data.body:hasPreparedRecoveryShopHeader(parsed.data.body, header)) || receipt.shopId !== parsed.data.image.origin.shopId ||
   !['LOGO','SQUARE_LOGO'].includes(parsed.data.image.origin.role) || value.planDigest !== digestConversationMediaDeliveryPlan(parsed.data, hash)) return null;
 return {schemaVersion: 1, kind: 'RECOVERY_BRAND_MEDIA', plan: parsed.data, receipt, recoveryShopHeader: header, policyRef, planDigest: String(value.planDigest)};
}
export function freezeBrandMedia(plan: Extract<ConversationMediaDeliveryPlan, {kind:'BRAND_IMAGE'}>, receipt: BrandPreparationReceipt, recoveryShopHeader: RecoveryLayoutReceipt, policyRef: BrandMediaPolicyRef): FrozenBrandMediaEnvelope {
 const envelope = readFrozenBrandMedia({schemaVersion: 1, kind:'RECOVERY_BRAND_MEDIA', plan, receipt, recoveryShopHeader, policyRef, planDigest: digestConversationMediaDeliveryPlan(plan, hash)});
 if (!envelope) throw new Error('INVALID_BRAND_MEDIA_PREPARATION');
 return envelope;
}
export function messageBrandReceipt(receipt: ConversationDeliveryReceipt): BrandPreparationReceipt {
 const {messageId, ...rest} = receipt; return {sourceKind:'MESSAGE', sourceId:messageId, ...rest};
}
export function asMessageDeliveryReceipt(receipt: BrandPreparationReceipt): ConversationDeliveryReceipt | null {
 if (receipt.sourceKind !== 'MESSAGE') return null;
 const {sourceKind: _kind, sourceId, ...rest} = receipt; return {messageId:sourceId, ...rest};
}
export function readPersistedConversationPlan(value: unknown): {plan: ConversationMediaDeliveryPlan; brand?: FrozenBrandMediaEnvelope; common?: FrozenCommonText} | null {
 const common=readFrozenCommonText(value);if(common)return {plan:common.plan,common};
 const brand = readFrozenBrandMedia(value); if (brand) return {plan: brand.plan, brand};
 const parsed = ConversationMediaDeliveryPlanSchema.safeParse(value);
 return parsed.success && parsed.data.kind !== 'BRAND_IMAGE' ? {plan:parsed.data} : null;
}

export type FrozenCommonText={schemaVersion:1;kind:'RECOVERY_COMMON_TEXT';plan:Extract<ConversationMediaDeliveryPlan,{kind:'TEXT'}>;receipt:BrandPreparationReceipt;recoveryShopHeader:Extract<RecoveryLayoutReceipt,{schemaVersion:2}>;planDigest:string};
export function readFrozenCommonText(value:unknown):FrozenCommonText|null{
 if(!record(value)||!exact(value,['schemaVersion','kind','plan','receipt','recoveryShopHeader','planDigest'])||value.schemaVersion!==1||value.kind!=='RECOVERY_COMMON_TEXT')return null;
 const plan=ConversationMediaDeliveryPlanSchema.safeParse(value.plan),receipt=readBrandPreparationReceipt(value.receipt),header=readRecoveryLayoutReceipt(value.recoveryShopHeader,receipt?.conversationId??'');
 if(!plan.success||plan.data.kind!=='TEXT'||!receipt||receipt.sourceKind!=='MESSAGE'||!header||header.schemaVersion!==2||receipt.shopId!==header.shopId||commonLayoutBody(header)!==plan.data.body||value.planDigest!==digestConversationMediaDeliveryPlan(plan.data,hash))return null;
 return {schemaVersion:1,kind:'RECOVERY_COMMON_TEXT',plan:plan.data,receipt,recoveryShopHeader:header,planDigest:String(value.planDigest)};
}
export function freezeCommonText(plan:Extract<ConversationMediaDeliveryPlan,{kind:'TEXT'}>,receipt:BrandPreparationReceipt,recoveryShopHeader:Extract<RecoveryLayoutReceipt,{schemaVersion:2}>):FrozenCommonText{
 const result=readFrozenCommonText({schemaVersion:1,kind:'RECOVERY_COMMON_TEXT',plan,receipt,recoveryShopHeader,planDigest:digestConversationMediaDeliveryPlan(plan,hash)});if(!result)throw new Error('INVALID_COMMON_TEXT_PREPARATION');return result;
}
