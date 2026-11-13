import { currentCommonLayoutMatches } from './common-layout.js';
import { parsePreparedEvidence } from '../recovery-conversation/human-prepared-command.service.js';
import { checkFinalStoredRecoveryConsent } from "../recovery-conversation/recovery-stored-consent.service.js";
import { canonicalJson } from '@modainteract/moda-interact-shared/commerce';
import type { DispatchInput, DispatchPermit } from '../recovery-conversation/outbound-send-fence.service.js';
import { first, rows, changed, type SqlTransaction, type RecoveryContext } from '../recovery-conversation/recovery-conversation.sql.js';
import { currentRecoveryShopHeaderMatches } from '../recovery-conversation/recovery-shop-header-verification.js';
import { currentBrandPlanMatches } from '../conversation-brand-media.js';
import { moderationConfig } from '../conversation-moderation/moderation-policy.js';
import { readFrozenMultipart, multipartPartIdentity, sha256 } from './frozen.js';

/** Invoked only within the existing final fence after its current tenant,
 * control, window, STOP, entitlement/usage and HUMAN wrapper checks. */
export async function admitMultipartPart(tx: SqlTransaction, input: DispatchInput, context: RecoveryContext, now: Date): Promise<DispatchPermit> {
  const row = await first<{id:string;content:string;outboundPresentation:unknown;providerDispatchKey:string|null}>(tx,`
    SELECT "id","content","outboundPresentation","providerDispatchKey" FROM "whatsapp"."ConversationMessage"
    WHERE "id"=$1 AND "conversationId"=$2 AND "direction"='OUTBOUND' AND "senderType"=$3::"whatsapp"."MessageSenderType" FOR UPDATE`,input.messageId,context.id,input.senderType);
  const source = readFrozenMultipart(row?.outboundPresentation);
  if (!row || !source || source.messageId !== row.id || source.body !== row.content || source.body !== input.expectedContent ||
      source.actor !== input.senderType || source.receipt.shopId !== context.shopId || source.receipt.conversationId !== context.id ||
      source.recoveryId !== context.recoveryId || source.receipt.controlRevision !== context.revision || source.recipient !== input.recipient ||
      (source.actor === 'AGENT' && source.receipt.inboundVersion !== context.inboundVersion) ||
      (source.actor === 'HUMAN' && (source.command?.id !== input.commandId || source.command?.leaseToken !== input.leaseToken)))
    return {kind:'suppressed',reason:'multipart-identity-invalid'};
  if (Date.parse(source.deadlineAt) <= now.getTime()) return {kind:'suppressed',reason:'multipart-deadline'};
  const platform=await first<{platform:string}>(tx,`SELECT "platform"::text FROM "commerce"."Shop" WHERE "id"=$1`,context.shopId);
  if(platform?.platform==='SHOPIFY') {
    const denial=await checkFinalStoredRecoveryConsent(tx,context,source.recipient,input.multipartConsent ?? undefined);
    if(denial)return {kind:'suppressed',reason:denial};
  }

  if (!(source.recoveryShopHeader.schemaVersion===2 ? await currentCommonLayoutMatches(tx,source.recoveryShopHeader,source.body,{shopId:context.shopId,conversationId:context.id,recoveryId:context.recoveryId,now}) : await currentRecoveryShopHeaderMatches(tx,source.recoveryShopHeader,source.body,context.shopId))) return {kind:'suppressed',reason:'recovery-shop-header-stale'};
  if(source.actor==='HUMAN' && source.recoveryShopHeader.schemaVersion===2){
    const command=await first<{preparedTextBody:string|null;preparedWrapperEvidence:unknown;preparedAt:Date|null;textBody:string|null}>(tx,`SELECT "preparedTextBody","preparedWrapperEvidence","preparedAt","textBody" FROM "whatsapp"."MerchantConversationSendCommand" WHERE "id"=$1`,source.command!.id);
    const evidence=command?parsePreparedEvidence(command.preparedTextBody,command.preparedWrapperEvidence,command.preparedAt):null;
    if(!evidence || evidence.outcome!=='RENDERED' || command!.textBody!==source.recoveryShopHeader.boundaries.body || canonicalJson(evidence.recoveryShopHeader)!==canonicalJson(source.recoveryShopHeader))return {kind:'suppressed',reason:'multipart-command-frame-invalid'};
  }
  const parts = await rows<{id:string;ordinal:number;role:string;payload:unknown;payloadDigest:string;sourceIdentity:unknown;state:string;deadlineAt:Date;providerAccountId:string;providerPhoneNumberId:string}>(tx,`
    SELECT * FROM "whatsapp"."ConversationDeliveryPart" WHERE "messageId"=$1 ORDER BY "ordinal" FOR UPDATE`,row.id);
  if (parts.length !== source.plan.parts.length) return {kind:'suppressed',reason:'multipart-manifest-invalid'};
  const index = parts.findIndex(part => part.id === input.multipartPartId);
  if (index < 0) return {kind:'suppressed',reason:'multipart-part-invalid'};
  const sourceIdentity = multipartPartIdentity(source);
  if (parts.some((part,i) => part.ordinal !== i || part.role !== source.plan.parts[i]!.role ||
      canonicalJson(part.payload) !== canonicalJson(source.plan.parts[i]!.plan) || part.payloadDigest !== sha256(canonicalJson(part.payload)) ||
      canonicalJson(part.sourceIdentity) !== canonicalJson(sourceIdentity) || part.deadlineAt.getTime() !== Date.parse(source.deadlineAt) ||
      part.providerAccountId !== source.sender.providerAccountId || part.providerPhoneNumberId !== source.sender.providerPhoneNumberId)) return {kind:'suppressed',reason:'multipart-manifest-invalid'};
  const part = parts[index]!;
  if (part.state !== 'PREPARED') return {kind:'suppressed',reason:'multipart-already-attempted'};
  if (index && !['DELIVERED','READ'].includes(parts[index-1]!.state)) return {kind:'suppressed',reason:'multipart-predecessor-pending'};
  // Do not let another logical reply interleave before this group's deadline.
  const predecessor = await first<{id:string}>(tx,`
    SELECT prior."id" FROM "whatsapp"."ConversationMessage" prior
    WHERE prior."conversationId"=$1 AND (prior."createdAt",prior."id") < (SELECT "createdAt","id" FROM "whatsapp"."ConversationMessage" WHERE "id"=$2)
      AND EXISTS (SELECT 1 FROM "whatsapp"."ConversationDeliveryPart" p WHERE p."messageId"=prior."id" AND p."deadlineAt">$3
        AND p."state" IN ('PREPARED','ADMITTED','ACKNOWLEDGED','UNKNOWN')) LIMIT 1`,context.id,row.id,now);
  if (predecessor) return {kind:'suppressed',reason:'multipart-earlier-group-pending'};
  const assessment = await first<{id:string}>(tx,`
    SELECT "id" FROM "whatsapp"."ConversationModerationAssessment"
    WHERE ${source.actor === 'HUMAN' ? '"merchantSendCommandId"=$1 AND "subject"=\'HUMAN_COMMAND\'' : '"conversationMessageId"=$1 AND "subject"=\'AGENT_MESSAGE\''}
      AND "decision"='ALLOW' AND "inputKind"='TEXT' AND "contentSha256"=$2 AND "policyVersion"=$3 LIMIT 1`,source.command?.id ?? row.id,sha256(source.body),moderationConfig().policyVersion);
  if (!assessment) return {kind:'suppressed',reason:'moderation_content_stale'};
  const plan = source.plan.parts[index]!.plan;
  for(const component of source.plan.parts) if (!(await currentBrandPlanMatches(tx,component.plan,context.shopId,source.policyRef ?? undefined))) return {kind:'suppressed',reason:'brand-media-stale'};
  const rootKey = source.actor === 'HUMAN' ? `arch040-human-${sha256(source.command!.id)}` : `arch040-auto-${sha256(row.id)}`;
  if (index === 0) {
    if (row.providerDispatchKey) return {kind:'suppressed',reason:'already-admitted-or-sent'};
    const root = await changed(tx,`UPDATE "whatsapp"."ConversationMessage" SET "providerDispatchKey"=$2,
      "providerDispatchAdmittedAt"=$3,"providerDispatchControlRevision"=$4
      WHERE "id"=$1 AND "status"='PENDING' AND "providerDispatchKey" IS NULL AND "providerMessageId" IS NULL`,row.id,rootKey,now,context.revision);
    if (root !== 1) throw new Error('MULTIPART_ROOT_CAS_LOST');
    if (source.actor === 'HUMAN') {
      const count = await changed(tx,`UPDATE "whatsapp"."MerchantConversationSendCommand" SET "state"='DISPATCH_ADMITTED',"outboundMessageId"=$3,
        "providerDispatchKey"=$4,"providerDispatchAdmittedAt"=$5,"providerDispatchControlRevision"=$6,
        "providerDispatchRestrictionRevision"=COALESCE((SELECT "revision" FROM "commerce"."ShopHumanMessagingRestriction" WHERE "shopId"=$7),0),"updatedAt"=$5
        WHERE "id"=$1 AND "leaseToken"=$2 AND "state"='CLAIMED' AND "leaseExpiresAt">$5 AND "outboundMessageId" IS NULL`,source.command!.id,source.command!.leaseToken,row.id,rootKey,now,context.revision,context.shopId);
      if (count !== 1) throw new Error('MULTIPART_COMMAND_CAS_LOST');
    }
  } else if (row.providerDispatchKey !== rootKey) return {kind:'suppressed',reason:'multipart-root-permit-invalid'};
  const key = `arch075-${sha256(`${row.id}:${index}`)}`;
  const admitted = await changed(tx,`UPDATE "whatsapp"."ConversationDeliveryPart" SET "state"='ADMITTED',"providerDispatchKey"=$2,
    "providerDispatchAdmittedAt"=$3,"updatedAt"=$3 WHERE "id"=$1 AND "state"='PREPARED' AND "providerDispatchKey" IS NULL`,part.id,key,now);
  if (admitted !== 1) throw new Error('MULTIPART_PART_CAS_LOST');
  return {kind:'admitted',messageId:row.id,dispatchKey:key,admittedAt:now,messageContent:plan.body,deliveryPlan:plan};
}
