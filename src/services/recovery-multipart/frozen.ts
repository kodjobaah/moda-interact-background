import { readRecoveryLayoutReceipt,commonLayoutBody,type RecoveryLayoutReceipt } from './common-layout.js';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@modainteract/moda-interact-shared/commerce';
import { parseRecoveryMultipartDeliveryPlan, digestRecoveryMultipartDeliveryPlan,
  type RecoveryMultipartDeliveryPlan } from '@modainteract/moda-interact-shared/commerce/presentation';
import { readBrandPreparationReceipt, type BrandPreparationReceipt, validConversationPlan, asMessageDeliveryReceipt } from '../conversation-delivery-plan.js';
import { hasPreparedRecoveryShopHeader, recoveryShopHeaderPrefix, withRecoveryShopHeader } from '../conversation-wrappers/recovery-shop-header.js';
import { validRecoveryCheckoutFooterUrl, hasPreparedRecoveryCheckoutFooter, RECOVERY_CHECKOUT_SEPARATOR, withHumanRecoveryCheckoutFooter } from '../conversation-wrappers/recovery-checkout-footer.js';
import { readBrandMediaPolicyRef, type BrandMediaPolicyRef } from '../conversation-brand-media.js';

export const humanMultipartMessageId=(commandId:string)=>`arch075human-${sha256(commandId)}`;
export const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
export const MULTIPART_DEADLINE_SECONDS = 120;
export const MULTIPART_REPAIR_BATCH = 100;
export const MULTIPART_REPAIR_MS = 5_000;
export function deliveryDeadline(now: Date, seconds = MULTIPART_DEADLINE_SECONDS): Date {
  if (!Number.isFinite(now.getTime()) || !Number.isInteger(seconds) || seconds < 30 || seconds > 300) throw new Error('INVALID_MULTIPART_DEADLINE');
  return new Date(now.getTime() + seconds * 1000);
}
export type FrozenMultipart = Readonly<{
  schemaVersion: 1; kind: 'RECOVERY_MULTIPART_PREPARATION'; messageId: string; body: string;
  checkoutUrl: string; recipient: string; recoveryId: string; actor: 'AGENT'|'HUMAN';
  receipt: BrandPreparationReceipt; recoveryShopHeader: RecoveryLayoutReceipt;
  policyRef: BrandMediaPolicyRef|null; command: {id: string; leaseToken: string}|null;
  sender: {providerAccountId: string; providerPhoneNumberId: string};
  plan: RecoveryMultipartDeliveryPlan; planDigest: string; frozenAt: string; deadlineAt: string;
}>;
const object = (v: unknown): v is Record<string,unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
const exact = (v: Record<string,unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k));
/** Private immutable server receipt, never accepted from model/queue payload. */
export function readFrozenMultipart(raw: unknown): FrozenMultipart|null {
  if (!object(raw) || !exact(raw,['schemaVersion','kind','messageId','body','checkoutUrl','recipient','recoveryId','actor','receipt','recoveryShopHeader','policyRef','command','sender','plan','planDigest','frozenAt','deadlineAt']) || raw.schemaVersion !== 1 || raw.kind !== 'RECOVERY_MULTIPART_PREPARATION' ||
      !identifier(raw.messageId) || !identifier(raw.recoveryId) || typeof raw.body !== 'string' || !raw.body.trim() || Array.from(raw.body).length > 4096 ||
      !validRecoveryCheckoutFooterUrl(raw.checkoutUrl) || typeof raw.recipient !== 'string' || !/^[1-9][0-9]{6,14}$/.test(raw.recipient) || (raw.actor !== 'AGENT' && raw.actor !== 'HUMAN')) return null;
  const receipt = readBrandPreparationReceipt(raw.receipt); const header = readRecoveryLayoutReceipt(raw.recoveryShopHeader,receipt?.conversationId ?? '');
  const policy = raw.policyRef === null ? null : readBrandMediaPolicyRef(raw.policyRef);
  if (!receipt || !header || header.shopId !== receipt.shopId || !(header.schemaVersion===2 ? commonLayoutBody(header)===raw.body && header.variables['checkout.url']===raw.checkoutUrl : hasPreparedRecoveryShopHeader(raw.body,header)) || !(header.schemaVersion===2 || hasPreparedRecoveryCheckoutFooter(raw.body,raw.checkoutUrl)) || (raw.policyRef !== null && !policy)) return null;
  if (!object(raw.sender) || !exact(raw.sender,['providerAccountId','providerPhoneNumberId']) || !identifier(raw.sender.providerAccountId) || !identifier(raw.sender.providerPhoneNumberId) || !/^[A-Za-z0-9_-]+$/.test(raw.sender.providerAccountId) || !/^[A-Za-z0-9_-]+$/.test(raw.sender.providerPhoneNumberId)) return null;
  if (raw.actor === 'HUMAN') {
    if (!object(raw.command) || !exact(raw.command,['id','leaseToken']) || !identifier(raw.command.id) || !identifier(raw.command.leaseToken) || receipt.sourceKind !== 'HUMAN_COMMAND' || receipt.sourceId !== raw.command.id || raw.messageId !== humanMultipartMessageId(raw.command.id)) return null;
  } else if (raw.command !== null || receipt.sourceKind !== 'MESSAGE' || receipt.sourceId !== raw.messageId) return null;
  const frozenAt = typeof raw.frozenAt === 'string' ? Date.parse(raw.frozenAt) : NaN;
  const deadlineAt = typeof raw.deadlineAt === 'string' ? Date.parse(raw.deadlineAt) : NaN;
  if (!Number.isFinite(frozenAt) || !Number.isFinite(deadlineAt) || deadlineAt-frozenAt < 30_000 || deadlineAt-frozenAt > 300_000) return null;
  let plan: RecoveryMultipartDeliveryPlan;
  try { plan = parseRecoveryMultipartDeliveryPlan(raw.plan,raw.checkoutUrl); } catch { return null; }
  if (raw.planDigest !== digestRecoveryMultipartDeliveryPlan(plan,sha256)) return null;
  const messageReceipt = asMessageDeliveryReceipt(receipt) ?? {...receipt,messageId:raw.messageId};
  for (const part of plan.parts) {
    if (!validConversationPlan(part.plan,part.plan.body,receipt.shopId,messageReceipt)) return null;
    if (part.plan.kind === 'BRAND_IMAGE' && (!policy || policy.publicOrigin !== part.plan.image.publicOrigin)) return null;
  }
  // Exact canonical boundary decomposition: no substring/prose heuristics.
  // The complete authored middle occurs exactly once, in PRODUCT or ANSWER;
  // a third product-image caption is only the existing trusted footer.
  if(header.schemaVersion===2){
    const {boundaries}=header;
    if(plan.parts.length===1){if(plan.parts[0]!.plan.body!==raw.body)return null;}
    else {
      if(plan.parts[0]!.plan.body!==boundaries.header+boundaries.footer || plan.parts.at(-1)!.plan.body!==boundaries.body+boundaries.footer)return null;
      if(plan.parts.length===3&&plan.parts[1]!.plan.body!==boundaries.footer)return null;
    }
  }else {
  const prefix=recoveryShopHeaderPrefix(header);
  const emptyFooter=withHumanRecoveryCheckoutFooter('',raw.checkoutUrl);
  const suffix=RECOVERY_CHECKOUT_SEPARATOR+raw.checkoutUrl;
  const inner=raw.body.slice(prefix.length);
  const middle=inner===emptyFooter ? '' : inner.endsWith(suffix) ? inner.slice(0,-suffix.length) : null;
  if(middle===null || withRecoveryShopHeader(withHumanRecoveryCheckoutFooter(middle,raw.checkoutUrl),header)!==raw.body) return null;
  if(plan.parts.length===1) {
    if(plan.parts[0]!.plan.body!==raw.body)return null;
  } else {
    if(plan.parts[0]!.plan.body!==withRecoveryShopHeader(emptyFooter,header))return null;
    const answer=withHumanRecoveryCheckoutFooter(middle,raw.checkoutUrl);
    if(plan.parts.at(-1)!.plan.body!==answer)return null;
    if(plan.parts.length===3 && plan.parts[1]!.plan.body!==emptyFooter)return null;
  }
  }
  return {...raw, receipt, recoveryShopHeader:header, policyRef:policy, plan} as FrozenMultipart;
}
export const multipartSourceDigest = (source: FrozenMultipart) => sha256(canonicalJson(source));
export function requireFrozenMultipart(raw: unknown): FrozenMultipart {
  const source = readFrozenMultipart(raw); if (!source) throw new Error('INVALID_MULTIPART_PREPARATION'); return source;
}

export type MultipartPartIdentity=Readonly<{schemaVersion:1;sourceDigest:string;shopId:string;conversationId:string}>;
export function multipartPartIdentity(source:FrozenMultipart):MultipartPartIdentity {
 return {schemaVersion:1,sourceDigest:multipartSourceDigest(source),shopId:source.receipt.shopId,conversationId:source.receipt.conversationId};
}
export function readMultipartPartIdentity(raw:unknown):MultipartPartIdentity|null {
 if(!object(raw)||!exact(raw,['schemaVersion','sourceDigest','shopId','conversationId'])||raw.schemaVersion!==1||typeof raw.sourceDigest!=='string'||! /^[a-f0-9]{64}$/.test(raw.sourceDigest)||!identifier(raw.shopId)||!identifier(raw.conversationId))return null;
 return raw as MultipartPartIdentity;
}
