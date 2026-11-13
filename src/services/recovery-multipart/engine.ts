import { moderationConfig } from "../conversation-moderation/moderation-policy.js";
import { randomUUID } from 'node:crypto';
import { recoveryStoredConsentService, type StoredRecoveryConsentReader } from "../recovery-conversation/recovery-stored-consent.service.js";
import { canonicalJson } from '@modainteract/moda-interact-shared/commerce';
import type { NormalizedWhatsAppStatus } from '@modainteract/moda-interact-shared/billing';
import { createLogger } from '@modainteract/moda-interact-shared/logging';
import { resolveDeploymentEnvironmentName } from '../../runtime/deployment-environment.js';
import { first, rows, changed, lockRecoveryContext, recoveryDatabase, type RecoveryDatabase, type SqlTransaction } from '../recovery-conversation/recovery-conversation.sql.js';
import { OutboundSendFenceService } from '../recovery-conversation/outbound-send-fence.service.js';
import { recoveryRuntimeEligibility } from '../recovery-conversation/recovery-runtime-eligibility.service.js';
import { whatsAppService, WhatsAppServiceError, type WhatsAppService } from '../whatsapp.service.js';
import { requireFrozenMultipart, readFrozenMultipart, multipartPartIdentity, readMultipartPartIdentity, sha256, MULTIPART_REPAIR_BATCH, type FrozenMultipart } from './frozen.js';

const logger = createLogger({serviceName:'moda-messaging-worker',environment:resolveDeploymentEnvironmentName()});
type Part = {id:string;messageId:string;ordinal:number;state:string;providerMessageId:string|null;providerDispatchAdmittedAt:Date|null;deadlineAt:Date;payload:unknown};
export type ContinueOutcome = 'absent'|'waiting'|'acknowledged'|'unknown'|'failed'|'cancelled'|'already-attempted';
export type ScheduleContinuation = (messageId:string)=>Promise<void>;
const noSchedule: ScheduleContinuation = async()=>{};
/** One durable logical reservation, one irreversible CAS per physical request.
 * Queue jobs carry only root identity; all authority comes from persisted rows. */
export class RecoveryMultipartDeliveryEngine {
  constructor(private readonly database: RecoveryDatabase = recoveryDatabase,
    private readonly sender: Pick<WhatsAppService,'sendWhatsAppText'|'sendWhatsAppImage'> = whatsAppService,
    private readonly fence = new OutboundSendFenceService(database,recoveryRuntimeEligibility),
    private readonly schedule: ScheduleContinuation = noSchedule,
    private readonly clock: ()=>Date = ()=>new Date(),
    private readonly consent: StoredRecoveryConsentReader = recoveryStoredConsentService) {}

  /** Trusted producer API only. Existing frozen roots can replay exact bytes,
   * but may never be upgraded from a legacy plan or rewritten to new media. */
  async freeze(raw: FrozenMultipart): Promise<'created'|'existing'> {
    const source = requireFrozenMultipart(raw);
    return this.database.$transaction(async tx=>{
      const context = await lockRecoveryContext(tx,source.receipt.conversationId);
      if (!context || context.shopId !== source.receipt.shopId || context.recoveryId !== source.recoveryId || context.revision !== source.receipt.controlRevision ||
          context.mode !== (source.actor === 'HUMAN'?'HUMAN':'AI') || (source.actor !== 'HUMAN' && context.inboundVersion !== source.receipt.inboundVersion)) throw new Error('MULTIPART_OWNER_STALE');
      if (Date.parse(source.frozenAt) > this.clock().getTime() || this.clock().getTime() >= Date.parse(source.deadlineAt)) throw new Error('MULTIPART_DEADLINE');
      if (source.actor === 'HUMAN') {
        const command = await first<{id:string}>(tx,`SELECT "id" FROM "whatsapp"."MerchantConversationSendCommand"
          WHERE "id"=$1 AND "shopId"=$2 AND "conversationId"=$3 AND "kind"='HUMAN_TEXT' AND "state"='CLAIMED'
            AND "leaseToken"=$4 AND "leaseExpiresAt">$5 AND "expectedControlRevision"=$6 AND "preparedTextBody"=$7
            AND "outboundMessageId" IS NULL AND "providerDispatchKey" IS NULL FOR UPDATE`,
          source.command!.id,context.shopId,context.id,source.command!.leaseToken,this.clock(),context.revision,source.body);
        if (!command) throw new Error('MULTIPART_COMMAND_STALE');
      }
      let root = await first<{content:string;outboundPresentation:unknown;providerDispatchKey:string|null}>(tx,`
        SELECT "content","outboundPresentation","providerDispatchKey" FROM "whatsapp"."ConversationMessage"
        WHERE "id"=$1 AND "conversationId"=$2 AND "direction"='OUTBOUND' AND "senderType"=$3::"whatsapp"."MessageSenderType" FOR UPDATE`,source.messageId,context.id,source.actor);
      if (!root && source.actor === 'HUMAN') {
        await changed(tx,`INSERT INTO "whatsapp"."ConversationMessage" ("id","conversationId","direction","senderType","status","content","contentType","outboundPresentation")
          VALUES ($1,$2,'OUTBOUND','HUMAN','PENDING',$3,'TEXT',$4::jsonb)`,source.messageId,context.id,source.body,JSON.stringify(source));
        root = {content:source.body,outboundPresentation:source,providerDispatchKey:null};
      }
      if (!root || root.content !== source.body) throw new Error('MULTIPART_ROOT_INVALID');
      const existing = readFrozenMultipart(root.outboundPresentation);
      if (existing && canonicalJson(existing) !== canonicalJson(source)) throw new Error('MULTIPART_FROZEN_CONFLICT');
      if (!existing) {
        if (root.outboundPresentation !== null || root.providerDispatchKey) throw new Error('MULTIPART_LEGACY_FROZEN');
        const count = await changed(tx,`UPDATE "whatsapp"."ConversationMessage" SET "outboundPresentation"=$2::jsonb
          WHERE "id"=$1 AND "outboundPresentation" IS NULL AND "providerDispatchKey" IS NULL AND "status"='PENDING'`,source.messageId,JSON.stringify(source));
        if (count !== 1) throw new Error('MULTIPART_FREEZE_CAS_LOST');
      }
      const sourceIdentity = JSON.stringify(multipartPartIdentity(source));
      for (const [ordinal,part] of source.plan.parts.entries()) {
        await changed(tx,`INSERT INTO "whatsapp"."ConversationDeliveryPart"
          ("id","messageId","ordinal","role","payload","payloadDigest","sourceIdentity","deadlineAt","providerAccountId","providerPhoneNumberId","updatedAt")
          VALUES ($1,$2,$3,$4::"whatsapp"."ConversationDeliveryPartRole",$5::jsonb,$6,$7::jsonb,$8,$9,$10,$11) ON CONFLICT ("messageId","ordinal") DO NOTHING`,
          `arch075part-${sha256(`${source.messageId}:${ordinal}`)}`,source.messageId,ordinal,part.role,JSON.stringify(part.plan),sha256(canonicalJson(part.plan)),sourceIdentity,new Date(source.deadlineAt),source.sender.providerAccountId,source.sender.providerPhoneNumberId,this.clock());
      }
      return existing?'existing':'created';
    });
  }

  async continue(messageId:string): Promise<ContinueOutcome> {
    const root = await first<{outboundPresentation:unknown}>(this.database,`SELECT "outboundPresentation" FROM "whatsapp"."ConversationMessage" WHERE "id"=$1`,messageId);
    const source = readFrozenMultipart(root?.outboundPresentation);
    if (!source || source.messageId!==messageId) {
      const raw=root?.outboundPresentation;
      if(raw && typeof raw==='object' && !Array.isArray(raw) && (raw as Record<string,unknown>).kind==='RECOVERY_MULTIPART_PREPARATION') {
        await this.abortInvalid(messageId);return 'cancelled';
      }
      return 'absent';
    }
    await this.reconcileRoot(messageId);
    const parts = await rows<Part>(this.database,`SELECT * FROM "whatsapp"."ConversationDeliveryPart" WHERE "messageId"=$1 ORDER BY "ordinal"`,messageId);
    if (parts.length !== source.plan.parts.length) throw new Error('MULTIPART_MANIFEST_INCOMPLETE');
    if (parts.some(p=>p.state==='UNKNOWN')) {await this.cancelTail(source,'multipart_unknown');return 'unknown';}
    if (parts.some(p=>['FAILED','CANCELLED'].includes(p.state))) {await this.cancelTail(source,'multipart_partial_failure');return 'failed';}
    if (Date.parse(source.deadlineAt)<=this.clock().getTime()) {await this.expire(source);return 'cancelled';}
    const part = parts.find(p=>p.state==='PREPARED');
    if (!part) return parts.some(p=>p.state==='ADMITTED')?'already-attempted':'waiting';
    if (part.ordinal && !['DELIVERED','READ'].includes(parts[part.ordinal-1]!.state)) return 'waiting';
    const consent=await this.consent.preflight({shopId:source.receipt.shopId,recoveryId:source.recoveryId,recipient:source.recipient});
    if(consent.kind!=='allowed'){await this.cancelTail(source,'multipart_consent_refused');return 'cancelled';}
    const permit = await this.fence.admitProviderDispatch({senderType:source.actor,shopId:source.receipt.shopId,conversationId:source.receipt.conversationId,
      recoveryId:source.recoveryId,expectedControlRevision:source.receipt.controlRevision,
      ...(source.actor==='AGENT'?{expectedInboundVersion:source.receipt.inboundVersion}:{}),
      ...(source.command?{commandId:source.command.id,leaseToken:source.command.leaseToken}:{}),
      messageId,recipient:source.recipient,expectedContent:source.body,deliveryKind:'TEXT',now:this.clock(),multipartPartId:part.id,multipartConsent:consent.snapshot,...(source.recoveryShopHeader.schemaVersion===1?{recoveryShopHeader:source.recoveryShopHeader}:{})});
    if (permit.kind !== 'admitted') {
      if(permit.reason==='moderation_content_stale' && await this.moderationMayProgress(source))return 'waiting';
      if (['multipart-predecessor-pending','multipart-earlier-group-pending','multipart-already-attempted','already-admitted-or-sent'].includes(permit.reason)) return 'waiting';
      logger.info('whatsapp.multipart.part_refused',{messageId,ordinal:part.ordinal,reason:permit.reason});
      await this.cancelTail(source,'multipart_authority_refused'); return 'cancelled';
    }
    // No await between a committed permit and this single transport attempt
    // other than the provider operation itself; exceptions are never retried.
    const plan = permit.deliveryPlan!;
    let providerMessageId:string;
    try {
      const result = plan.kind==='TEXT' ? await this.sender.sendWhatsAppText({to:source.recipient,text:plan.body,expectedSender:source.sender}) :
        await this.sender.sendWhatsAppImage({to:source.recipient,caption:plan.body,link:plan.image.publicUrl,expectedSender:source.sender});
      providerMessageId=result.providerMessageId;
    } catch (error) {
      const known = error instanceof WhatsAppServiceError && ['sender-mismatch','configuration-missing','provider-rejected'].includes(error.code);
      await this.failAttempt(source,part.id,known?'FAILED':'UNKNOWN',known?'multipart_provider_rejected':'multipart_provider_unknown');
      logger.warn('whatsapp.multipart.part_stopped',{messageId,ordinal:part.ordinal,outcome:known?'FAILED':'UNKNOWN'});
      return known?'failed':'unknown';
    }
    // Persistence/scheduler errors after the provider ACK are not provider
    // failures. Repair may persist/reconcile evidence, never repeat HTTP.
    await this.accept(part.id,providerMessageId);
    await this.schedule(messageId);
    return 'acknowledged';
  }

  async accept(partId:string,providerMessageId:string):Promise<void> {
    if (!providerMessageId.trim() || providerMessageId.length>512) throw new Error('MULTIPART_ACK_INVALID');
    const pointer = await first<{messageId:string}>(this.database,`SELECT "messageId" FROM "whatsapp"."ConversationDeliveryPart" WHERE "id"=$1`,partId);
    if (!pointer) throw new Error('MULTIPART_PART_MISSING');
    await this.withRoot(pointer.messageId,async(tx)=>{
      const part = await first<{state:string;providerMessageId:string|null}>(tx,`SELECT "state"::text,"providerMessageId" FROM "whatsapp"."ConversationDeliveryPart" WHERE "id"=$1 FOR UPDATE`,partId);
      if (part?.providerMessageId===providerMessageId) return;
      if (!part || !['ADMITTED','UNKNOWN'].includes(part.state) || part.providerMessageId) throw new Error('MULTIPART_ACK_CONFLICT');
      await changed(tx,`UPDATE "whatsapp"."ConversationDeliveryPart" SET "state"='ACKNOWLEDGED',"providerMessageId"=$2,
        "acknowledgedAt"=COALESCE("acknowledgedAt",$3),"updatedAt"=$3 WHERE "id"=$1`,partId,providerMessageId,this.clock());
      await this.reconcileReceipts(tx,partId);
      await this.aggregate(tx,pointer.messageId);
    },false);
  }

  /** Known multipart events precede legacy scalar lookup. Unknown receipts are
   * durable but never claim authority over a different account/phone. */
  async observe(event:NormalizedWhatsAppStatus):Promise<boolean> {
    let rootId:string|null=null;
    const handled=await this.database.$transaction(async tx=>{
      const receiptId=`arch075receipt-${sha256(canonicalJson([event.providerAccountId,event.providerPhoneNumberId,event.providerMessageId,event.status,event.occurredAt]))}`;
      await changed(tx,`INSERT INTO "whatsapp"."ConversationDeliveryStatusReceipt"
        ("id","providerAccountId","providerPhoneNumberId","providerMessageId","status","providerTimestamp","failureCode")
        VALUES ($1,$2,$3,$4,$5::"whatsapp"."ConversationDeliveryStatus",$6,$7) ON CONFLICT DO NOTHING`,receiptId,event.providerAccountId,event.providerPhoneNumberId,event.providerMessageId,event.status,new Date(event.occurredAt),event.schemaVersion === 3 && event.failure?.providerCode && /^[A-Za-z0-9_.:-]{1,64}$/.test(event.failure.providerCode) ? event.failure.providerCode : null);
      const pointer=await first<{id:string;messageId:string;conversationId:string}>(tx,`SELECT p."id",p."messageId",m."conversationId" FROM "whatsapp"."ConversationDeliveryPart" p
        JOIN "whatsapp"."ConversationMessage" m ON m."id"=p."messageId" WHERE p."providerMessageId"=$1 AND p."providerAccountId"=$2 AND p."providerPhoneNumberId"=$3`,event.providerMessageId,event.providerAccountId,event.providerPhoneNumberId);
      if (!pointer) return false;
      if(!(await this.lockOutcomeRoot(tx,pointer.messageId)))return true;
      await this.reconcileReceipts(tx,pointer.id);await this.aggregate(tx,pointer.messageId);
      rootId=pointer.messageId;return true;
    });
    if(rootId)await this.schedule(rootId);
    return handled;
  }

  private async reconcileReceipts(tx:SqlTransaction,partId:string):Promise<void> {
    const p=await first<{state:string;providerAccountId:string;providerPhoneNumberId:string;providerMessageId:string|null}>(tx,`SELECT * FROM "whatsapp"."ConversationDeliveryPart" WHERE "id"=$1 FOR UPDATE`,partId);
    if(!p?.providerMessageId)return;
    await changed(tx,`UPDATE "whatsapp"."ConversationDeliveryStatusReceipt" SET "partId"=$1
      WHERE "partId" IS NULL AND "providerAccountId"=$2 AND "providerPhoneNumberId"=$3 AND "providerMessageId"=$4`,partId,p.providerAccountId,p.providerPhoneNumberId,p.providerMessageId);
    const receipts=await rows<{status:string;providerTimestamp:Date;failureCode:string|null}>(tx,`SELECT "status"::text,"providerTimestamp","failureCode" FROM "whatsapp"."ConversationDeliveryStatusReceipt" WHERE "partId"=$1 ORDER BY "providerTimestamp","id"`,partId);
    for(const receipt of receipts){
      if(receipt.status==='READ')await changed(tx,`UPDATE "whatsapp"."ConversationDeliveryPart" SET "state"='READ',"readAt"=COALESCE("readAt",$2),"updatedAt"=$3 WHERE "id"=$1 AND "state" IN ('ACKNOWLEDGED','DELIVERED','READ','UNKNOWN','FAILED')`,partId,receipt.providerTimestamp,this.clock());
      else if(receipt.status==='DELIVERED')await changed(tx,`UPDATE "whatsapp"."ConversationDeliveryPart" SET "state"=CASE WHEN "state"='READ' THEN 'READ'::"whatsapp"."ConversationDeliveryPartState" ELSE 'DELIVERED'::"whatsapp"."ConversationDeliveryPartState" END,"deliveredAt"=COALESCE("deliveredAt",$2),"updatedAt"=$3 WHERE "id"=$1 AND "state" IN ('ACKNOWLEDGED','DELIVERED','READ','UNKNOWN','FAILED')`,partId,receipt.providerTimestamp,this.clock());
      else if(receipt.status==='FAILED')await changed(tx,`UPDATE "whatsapp"."ConversationDeliveryPart" SET "state"='FAILED',"failedAt"=COALESCE("failedAt",$2),"failureCode"=COALESCE("failureCode",$3),"updatedAt"=$4 WHERE "id"=$1 AND "state" IN ('ACKNOWLEDGED','UNKNOWN')`,partId,receipt.providerTimestamp,receipt.failureCode??'multipart_provider_failed',this.clock());
    }
  }

  private async aggregate(tx:SqlTransaction,messageId:string):Promise<void> {
    const parts=await rows<{state:string}>(tx,`SELECT "state"::text FROM "whatsapp"."ConversationDeliveryPart" WHERE "messageId"=$1 ORDER BY "ordinal" FOR UPDATE`,messageId);
    if(!parts.length)return;
    const failed=parts.some(p=>['FAILED','CANCELLED'].includes(p.state));const unknown=parts.some(p=>p.state==='UNKNOWN');const inFlight=parts.some(p=>p.state==='ADMITTED');
    const allAck=parts.every(p=>['ACKNOWLEDGED','DELIVERED','READ'].includes(p.state));
    const status=unknown||inFlight?'PENDING':failed?'FAILED':parts.every(p=>p.state==='READ')?'READ':parts.every(p=>['DELIVERED','READ'].includes(p.state))?'DELIVERED':allAck?'SENT':'PENDING';
    if(failed || unknown)await changed(tx,`UPDATE "whatsapp"."ConversationDeliveryPart" SET "state"='CANCELLED',"cancelledAt"=COALESCE("cancelledAt",$2),"failureCode"=COALESCE("failureCode",$3),"updatedAt"=$2 WHERE "messageId"=$1 AND "state"='PREPARED'`,messageId,this.clock(),unknown?'multipart_provider_unknown':'multipart_partial_failure');
    await changed(tx,`UPDATE "whatsapp"."ConversationMessage" SET "status"=$2::"whatsapp"."MessageStatus",
      "sentAt"=CASE WHEN $3 THEN COALESCE("sentAt",$4) ELSE "sentAt" END,
      "deliveredAt"=CASE WHEN $2 IN ('DELIVERED','READ') THEN COALESCE("deliveredAt",$4) ELSE "deliveredAt" END,
      "readAt"=CASE WHEN $2='READ' THEN COALESCE("readAt",$4) ELSE "readAt" END,
      "failedAt"=CASE WHEN $2='FAILED' THEN COALESCE("failedAt",$4) ELSE "failedAt" END,
      "providerFailureCode"=CASE WHEN $2='FAILED' THEN COALESCE("providerFailureCode",'multipart_partial_failure') ELSE "providerFailureCode" END
      WHERE "id"=$1 AND "status" IN ('PENDING','SENT','DELIVERED','READ','FAILED')`,messageId,status,allAck,this.clock());
    if(status==='DELIVERED'||status==='READ'){
      const owner=await first<{shopId:string}>(tx,`SELECT r."shopId" FROM "whatsapp"."ConversationMessage" m
        JOIN "whatsapp"."Conversation" c ON c."id"=m."conversationId" JOIN "commerce"."CheckoutRecovery" r ON r."id"=c."checkoutRecoveryId" WHERE m."id"=$1`,messageId);
      if(owner)await changed(tx,`INSERT INTO "billing"."UsageEvent" ("id","shopId","metric","quantity","idempotencyKey","sourceType","sourceId","occurredAt")
        VALUES ($1,$2,'DELIVERED_WHATSAPP_MESSAGE',1,$3,'WHATSAPP_PROVIDER_STATUS',$4,$5) ON CONFLICT ("idempotencyKey") DO NOTHING`,randomUUID(),owner.shopId,`whatsapp-delivered:${messageId}`,messageId,this.clock());
    }
    // Match existing known-no-send automated failure accounting only when no
    // physical send can have been accepted or uncertain. Never release prefix.
    if(failed && !unknown && !inFlight)await changed(tx,`DELETE FROM "billing"."UsageEvent" usage USING "whatsapp"."ConversationMessage" root,"whatsapp"."Conversation" c,"commerce"."CheckoutRecovery" recovery
      WHERE root."id"=$1 AND root."senderType"='AGENT' AND c."id"=root."conversationId" AND recovery."id"=c."checkoutRecoveryId"
        AND usage."sourceId"=root."id" AND usage."shopId"=recovery."shopId" AND usage."metric"='OUTBOUND_AUTOMATED_MESSAGE' AND usage."quantity"=1
        AND NOT EXISTS (SELECT 1 FROM "whatsapp"."ConversationDeliveryPart" p WHERE p."messageId"=root."id" AND (p."providerMessageId" IS NOT NULL OR p."state" IN ('ADMITTED','UNKNOWN')))`,messageId);
    if(allAck || (failed && !inFlight) || unknown)await changed(tx,`UPDATE "whatsapp"."MerchantConversationSendCommand" SET "state"=$2::"whatsapp"."MerchantConversationSendState",
      "completedAt"=CASE WHEN $2 IN ('SENT','FAILED') THEN COALESCE("completedAt",$3) ELSE "completedAt" END,
      "failureCode"=CASE WHEN $2='FAILED' THEN 'multipart_partial_failure' WHEN $2='UNKNOWN' THEN 'multipart_provider_unknown' ELSE "failureCode" END,
      "leaseToken"=CASE WHEN $2 IN ('SENT','FAILED','UNKNOWN') THEN NULL ELSE "leaseToken" END,
      "leaseExpiresAt"=CASE WHEN $2 IN ('SENT','FAILED','UNKNOWN') THEN NULL ELSE "leaseExpiresAt" END,"updatedAt"=$3
      WHERE "outboundMessageId"=$1 AND "state" IN ('DISPATCH_ADMITTED','UNKNOWN')`,messageId,allAck?'SENT':unknown?'UNKNOWN':'FAILED',this.clock());
  }

  private async abortInvalid(messageId:string):Promise<void>{
    await this.database.$transaction(async tx=>{
      if(!(await this.lockOutcomeRoot(tx,messageId)))return;
      await changed(tx,`UPDATE "whatsapp"."ConversationDeliveryPart" SET "state"='CANCELLED',"cancelledAt"=COALESCE("cancelledAt",$2),"failureCode"='multipart_source_invalid',"updatedAt"=$2 WHERE "messageId"=$1 AND "state"='PREPARED'`,messageId,this.clock());
      await changed(tx,`UPDATE "whatsapp"."ConversationDeliveryPart" SET "state"='UNKNOWN',"unknownAt"=COALESCE("unknownAt",$2),"failureCode"='multipart_source_invalid',"updatedAt"=$2 WHERE "messageId"=$1 AND "state"='ADMITTED' AND "deadlineAt"<=$2`,messageId,this.clock());
      await this.aggregate(tx,messageId);
    });
  }
  private async moderationMayProgress(source:FrozenMultipart):Promise<boolean>{
    const assessment=await first<{decision:string}>(this.database,`SELECT "decision"::text FROM "whatsapp"."ConversationModerationAssessment"
      WHERE ${source.actor==='HUMAN'?'"merchantSendCommandId"=$1':'"conversationMessageId"=$1'} AND "subject"=$6::"whatsapp"."ConversationModerationSubject"
        AND "shopId"=$2 AND "conversationId"=$3 AND "contentSha256"=$4 AND "policyVersion"=$5 AND "inputKind"='TEXT' LIMIT 1`,
      source.command?.id??source.messageId,source.receipt.shopId,source.receipt.conversationId,sha256(source.body),moderationConfig().policyVersion,source.actor==='HUMAN'?'HUMAN_COMMAND':'AGENT_MESSAGE');
    // Waiting grants no authority: the same final fence still requires ALLOW.
    // BLOCK/REVIEW_REQUIRED are definitive; every wait retains original deadline.
    return !assessment || ['PENDING','CHECKING','RETRYABLE_ERROR','ALLOW'].includes(assessment.decision);
  }
  private async lockOutcomeRoot(tx:SqlTransaction,messageId:string):Promise<boolean>{
    const pointer=await first<{conversationId:string;sourceIdentity:unknown}>(tx,`SELECT root."conversationId",part."sourceIdentity"
      FROM "whatsapp"."ConversationMessage" root JOIN "whatsapp"."ConversationDeliveryPart" part ON part."messageId"=root."id"
      WHERE root."id"=$1 ORDER BY part."ordinal" LIMIT 1`,messageId);
    const identity=readMultipartPartIdentity(pointer?.sourceIdentity);
    if(!pointer || !identity || identity.conversationId!==pointer.conversationId)return false;
    // Outcome evidence survives takeover, source corruption and recovery unlink.
    // This is NOT a sending permit; the original immutable part tenant orders
    // locks, and later dispatch still goes through the full fresh final fence.
    await rows(tx,`SELECT "id" FROM "commerce"."Shop" WHERE "id"=$1 FOR UPDATE`,identity.shopId);
    await rows(tx,`SELECT "id" FROM "whatsapp"."Conversation" WHERE "id"=$1 FOR UPDATE`,identity.conversationId);
    return (await rows<{id:string}>(tx,`SELECT "id" FROM "whatsapp"."ConversationMessage" WHERE "id"=$1 AND "conversationId"=$2 FOR UPDATE`,messageId,identity.conversationId)).length===1;
  }
  private async reconcileRoot(messageId:string):Promise<void>{
    // Close the commit-order race where callback and ACK each read before the
    // other's transaction committed. Durable unmatched facts remain repairable.
    await this.withRoot(messageId,async tx=>{
      const parts=await rows<{id:string}>(tx,`SELECT "id" FROM "whatsapp"."ConversationDeliveryPart" WHERE "messageId"=$1 AND "providerMessageId" IS NOT NULL ORDER BY "ordinal" FOR UPDATE`,messageId);
      for(const part of parts)await this.reconcileReceipts(tx,part.id);
      await this.aggregate(tx,messageId);
    },false);
  }
  private async withRoot<T>(messageId:string,run:(tx:SqlTransaction)=>Promise<T>,requireSource=true):Promise<T>{
    return this.database.$transaction(async tx=>{
      if(!(await this.lockOutcomeRoot(tx,messageId)))throw new Error('MULTIPART_ROOT_UNAVAILABLE');
      const locked=await first<{outboundPresentation:unknown}>(tx,`SELECT "outboundPresentation" FROM "whatsapp"."ConversationMessage" WHERE "id"=$1`,messageId);
      if(requireSource)requireFrozenMultipart(locked?.outboundPresentation);
      return run(tx);
    });
  }
  private async cancelUnadmittedCommand(tx:SqlTransaction,source:FrozenMultipart,reason:string):Promise<void>{
    if(!source.command)return;
    await changed(tx,`UPDATE "whatsapp"."MerchantConversationSendCommand" SET "state"='CANCELLED',"failureCode"=$6,
      "leaseToken"=NULL,"leaseExpiresAt"=NULL,"completedAt"=$7,"updatedAt"=$7
      WHERE "id"=$1 AND "shopId"=$2 AND "conversationId"=$3 AND "leaseToken"=$4 AND "expectedControlRevision"=$5
        AND "state"='CLAIMED' AND "providerDispatchKey" IS NULL AND "outboundMessageId" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "whatsapp"."ConversationDeliveryPart" p WHERE p."messageId"=$8 AND p."providerDispatchKey" IS NOT NULL)`,
      source.command.id,source.receipt.shopId,source.receipt.conversationId,source.command.leaseToken,source.receipt.controlRevision,reason,this.clock(),source.messageId);
  }
  private async cancelTail(source:FrozenMultipart,reason:string):Promise<void>{await this.withRoot(source.messageId,async tx=>{
    await changed(tx,`UPDATE "whatsapp"."ConversationDeliveryPart" SET "state"='CANCELLED',"cancelledAt"=COALESCE("cancelledAt",$2),"failureCode"=$3,"updatedAt"=$2 WHERE "messageId"=$1 AND "state"='PREPARED'`,source.messageId,this.clock(),reason);await this.cancelUnadmittedCommand(tx,source,reason);await this.aggregate(tx,source.messageId);
  });}
  private async expire(source:FrozenMultipart):Promise<void>{await this.withRoot(source.messageId,async tx=>{
    // An admitted crash has an unknowable provider outcome. Never put it back
    // into PREPARED or erase it merely to release conversation ordering.
    await changed(tx,`UPDATE "whatsapp"."ConversationDeliveryPart" SET "state"='UNKNOWN',"unknownAt"=COALESCE("unknownAt",$2),"failureCode"='multipart_deadline_unknown',"updatedAt"=$2 WHERE "messageId"=$1 AND "state"='ADMITTED'`,source.messageId,this.clock());
    await changed(tx,`UPDATE "whatsapp"."ConversationDeliveryPart" SET "state"='CANCELLED',"cancelledAt"=COALESCE("cancelledAt",$2),"failureCode"='multipart_deadline',"updatedAt"=$2 WHERE "messageId"=$1 AND "state"='PREPARED'`,source.messageId,this.clock());await this.cancelUnadmittedCommand(tx,source,'multipart_deadline');await this.aggregate(tx,source.messageId);
  });}
  private async failAttempt(source:FrozenMultipart,partId:string,state:'FAILED'|'UNKNOWN',reason:string):Promise<void>{await this.withRoot(source.messageId,async tx=>{
    await changed(tx,`UPDATE "whatsapp"."ConversationDeliveryPart" SET "state"=$2::"whatsapp"."ConversationDeliveryPartState",
      "failedAt"=CASE WHEN $2='FAILED' THEN COALESCE("failedAt",$3) ELSE "failedAt" END,"unknownAt"=CASE WHEN $2='UNKNOWN' THEN COALESCE("unknownAt",$3) ELSE "unknownAt" END,"failureCode"=$4,"updatedAt"=$3 WHERE "id"=$1 AND "state"='ADMITTED'`,partId,state,this.clock(),reason);await this.aggregate(tx,source.messageId);
  },false);}
  async repair():Promise<{scanned:number}>{
    const roots=await rows<{messageId:string}>(this.database,`SELECT p."messageId" FROM "whatsapp"."ConversationDeliveryPart" p
      WHERE p."state" IN ('PREPARED','ADMITTED') GROUP BY p."messageId" ORDER BY min(p."deadlineAt"),p."messageId" LIMIT $1`,MULTIPART_REPAIR_BATCH);
    for(const root of roots)await this.schedule(root.messageId);
    await changed(this.database,`DELETE FROM "whatsapp"."ConversationDeliveryStatusReceipt" WHERE "id" IN (
      SELECT "id" FROM "whatsapp"."ConversationDeliveryStatusReceipt" WHERE "partId" IS NULL AND "receivedAt"<$1 ORDER BY "receivedAt","id" LIMIT $2)`,new Date(this.clock().getTime()-7*86400_000),MULTIPART_REPAIR_BATCH);
    return {scanned:roots.length};
  }
}
