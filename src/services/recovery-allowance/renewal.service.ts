import { isConfirmedProviderNonDelivery } from "../../domain/whatsapp-recipient-failure.js";
import { randomUUID } from "node:crypto";
import { hasLocalNoContact } from "../whatsapp-contact-opt-out/local-no-contact.js";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { Prisma, type PrismaClient } from "@prisma/client";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import prisma from "../../lib/db.js";
import { recoveryBillingService, type RecoveryBillingService } from "../recovery-billing.service.js";
import { EffectiveBillingPolicyResolver, EffectiveBillingPolicyError } from "../effective-billing-policy.service.js";
import { PostContractRecoveryPolicyResolver } from "../post-contract-recovery-policy.service.js";
import { lockRecoveryContext, readRecoveryWindowEvidence, terminalRecovery } from "../recovery-conversation/recovery-conversation.sql.js";
import { customerWindow } from "../recovery-conversation/recovery-follow-up-policy.service.js";
import { findExactReservationSource } from "../recovery-delivery-compensation/lineage.js";
import { freeRecoveryReservationService } from "../free-recovery-reservation.service.js";
import { paidIncludedRecoveryReservationService } from "../paid-included-recovery-reservation.service.js";
import { promotionalRecoveryReservationService } from "../promotional-recovery-reservation.service.js";
import { purchasedRecoveryReservationService } from "../purchased-recovery-reservation.service.js";
import { readCommittedRecoveryUsage } from "../recovery-delivery-compensation/committed-usage.js";
import { releaseReservedSource } from "../recovery-delivery-compensation/reserved.js";
import { AllowanceHeld, hasCurrentContinuation, allowanceSourceKey, allowanceUsage, notifyAllowanceBoundary, continuationSourceId, createSuccessor, exactBlockSource, type AllowanceLimits } from "./storage.js";
const logger=createLogger({serviceName:"moda-messaging-worker",environment:resolveDeploymentEnvironmentName()});
const WORK_LEASE_MS=120_000;
const REPAIR_DELAY_MS=30_000;
type Tx=Prisma.TransactionClient;
type ContinuationInput={shopId:string;conversationId:string;expectedControlRevision:number;expectedInboundVersion:number};
type Billing=Pick<RecoveryBillingService,"admit"|"revalidateBeforeProvider"|"releaseBeforeProvider">;

/** Funding is a durable intent in the existing Conversation, never a new outreach attempt. */
export class RecoveryAllowanceService {
 constructor(private readonly database:PrismaClient=prisma,private readonly billing:Billing=recoveryBillingService,private readonly clock:()=>Date=()=>new Date()){}
 async fundContinuation(input:ContinuationInput,limits:AllowanceLimits):Promise<boolean>{
  if(limits.outboundHardLimit-limits.terminalMessageReservedSlots<=0)return false;
  try{
   const prepared=await this.database.$transaction(async tx=>createSuccessor(tx,{...input,limits,kind:"CONTINUATION",now:this.clock()}));
   return this.fundBlock(prepared.block.id,input);
  }catch(error){if(error instanceof AllowanceHeld)return false;throw error;}
 }
 /** Legitimate sequence-two template credit funds its own successor; this never buys a continuation. */
 async beginFollowUp(input:{shopId:string;recoveryId:string;attemptId:string;limits:AllowanceLimits}){
  if(input.limits.outboundHardLimit-input.limits.terminalMessageReservedSlots<=0)throw new AllowanceHeld("no-normal-message-capacity");
  return this.database.$transaction(async tx=>{
   const conversation=await tx.conversation.findUnique({where:{checkoutRecoveryId:input.recoveryId},select:{id:true}});
   if(!conversation)throw new AllowanceHeld("owner-unavailable");
   const attempt=await tx.recoveryOutreachAttempt.findUnique({where:{id:input.attemptId}});
   if(!attempt||attempt.checkoutRecoveryId!==input.recoveryId||attempt.sequence!==2)throw new AllowanceHeld("follow-up-identity");
   const result=await createSuccessor(tx,{conversationId:conversation.id,limits:input.limits,kind:"FOLLOW_UP",now:this.clock()});
   if(result.context.shopId!==input.shopId)throw new AllowanceHeld("owner-unavailable");
   const now=this.clock();
   if(result.block.repairLeaseUntil&&result.block.repairLeaseUntil>now)throw new AllowanceHeld("follow-up-funding-leased");
   const token=randomUUID();
   await tx.conversationAllowanceBlock.update({where:{id:result.block.id},data:{repairLeaseToken:token,repairLeaseUntil:new Date(now.getTime()+WORK_LEASE_MS)}});
   return {id:result.block.id,token};
  });
 }
 async attachFollowUp(intent:{id:string;token:string},sourceKey:string){
  const blockId=intent.id;
  await this.database.$transaction(async tx=>{
   const block=await tx.conversationAllowanceBlock.findUniqueOrThrow({where:{id:blockId}});
   await lockRecoveryContext(tx,block.conversationId);
   if(block.repairLeaseToken!==intent.token||!block.repairLeaseUntil||block.repairLeaseUntil<=this.clock())throw new AllowanceHeld("follow-up-funding-lease-lost");
   const conversation=await tx.conversation.findUniqueOrThrow({where:{id:block.conversationId},select:{checkoutRecoveryId:true}});
   if(!conversation.checkoutRecoveryId)throw new AllowanceHeld("follow-up-owner");
   const attempt=await tx.recoveryOutreachAttempt.findUniqueOrThrow({where:{checkoutRecoveryId_sequence:{checkoutRecoveryId:conversation.checkoutRecoveryId,sequence:2}}});
   const logical=createRecoveryIdempotencyKey(block.shopId,`recovery-outreach:${attempt.id}`);
   const source=await findExactReservationSource(tx,block.shopId,logical);
   if(!source||source.reservation.sourceKey!==sourceKey||source.reservation.status!=="RESERVED"||block.state!=="PENDING"||block.fundingKind!=="FOLLOW_UP")throw new AllowanceHeld("follow-up-reservation");
   if(block.creditReservationId&&block.creditReservationId!==source.reservation.id)throw new AllowanceHeld("follow-up-reservation");
   await tx.conversationAllowanceBlock.update({where:{id:block.id},data:{creditReservationId:source.reservation.id,repairLeaseToken:null,repairLeaseUntil:null}});
  });
 }
 private async fundBlock(blockId:string,input:ContinuationInput):Promise<boolean>{
  const token=randomUUID();
  const acquired=await this.database.$transaction(async tx=>{
   const context=await lockRecoveryContext(tx,input.conversationId);
   const now=this.clock();
   const block=await tx.conversationAllowanceBlock.findUnique({where:{id:blockId}});
   if(!block||block.conversationId!==input.conversationId||block.shopId!==input.shopId||block.fundingKind!=="CONTINUATION"||block.state!=="PENDING")return false;
   if(block.creditReservationId)return true;
   if(!context||context.mode!=="AI"||context.revision!==input.expectedControlRevision||context.inboundVersion!==input.expectedInboundVersion||terminalRecovery(context.recoveryStatus)||!await hasCurrentContinuation(tx,context.id,input.expectedInboundVersion))return false;
   const window=await readRecoveryWindowEvidence(tx,{recoveryId:context.recoveryId,conversationId:context.id,now});
   if(!customerWindow(window?.verifiedInboundAt??null,now).open)return false;
   if(block.repairDeadlineAt! <= now || block.repairLeaseUntil&&block.repairLeaseUntil>now)return false;
   await tx.conversationAllowanceBlock.update({where:{id:block.id},data:{repairLeaseToken:token,repairLeaseUntil:new Date(now.getTime()+WORK_LEASE_MS)}});
   return true;
  });
  if(!acquired)return false;
  const existing=await this.database.conversationAllowanceBlock.findUniqueOrThrow({where:{id:blockId}});
  if(existing.creditReservationId)return true;
  const owner=await this.database.conversation.findUniqueOrThrow({where:{id:input.conversationId},select:{checkoutRecoveryId:true}});
  if(!owner.checkoutRecoveryId)return false;
  const fundingSourceId=continuationSourceId(blockId);
  let admission=await this.billing.admit({shopId:input.shopId,recoveryId:owner.checkoutRecoveryId,fundingSourceId});
  if(admission.kind==="admitted")admission=await this.billing.revalidateBeforeProvider({admission:admission.admission,recoveryId:owner.checkoutRecoveryId,fundingSourceId});
  if(admission.kind!=="admitted"){
   await this.releaseLease(blockId,token);
   return false;
  }
  const admitted=admission.admission;
  const attached=await this.database.$transaction(async tx=>{
   const context=await lockRecoveryContext(tx,input.conversationId);
   const now=this.clock();
   const block=await tx.conversationAllowanceBlock.findUnique({where:{id:blockId}});
   if(!block||block.state!=="PENDING"||block.repairLeaseToken!==token||!block.repairLeaseUntil||block.repairLeaseUntil<=now)return false;
   if(!context||context.mode!=="AI"||context.revision!==input.expectedControlRevision||context.inboundVersion!==input.expectedInboundVersion||terminalRecovery(context.recoveryStatus)||!await hasCurrentContinuation(tx,context.id,input.expectedInboundVersion))return false;
   const source=await findExactReservationSource(tx,input.shopId,allowanceSourceKey(input.shopId,blockId));
   if(!source||source.reservation.status!=="RESERVED"||source.reservation.sourceKey!==admitted.sourceKey)return false;
   await tx.conversationAllowanceBlock.update({where:{id:blockId},data:{creditReservationId:source.reservation.id,repairLeaseToken:null,repairLeaseUntil:null,repairAt:new Date(now.getTime()+REPAIR_DELAY_MS)}});
   return true;
  });
  if(!attached){
   // A fenced-out worker cannot refund an identity possibly admitted by its successor.
   await this.releaseLease(blockId,token);
  }
  return attached;
 }
 private async releaseLease(blockId:string,token:string){
  await this.database.conversationAllowanceBlock.updateMany({where:{id:blockId,state:"PENDING",repairLeaseToken:token},data:{repairLeaseToken:null,repairLeaseUntil:null,repairAt:new Date(this.clock().getTime()+REPAIR_DELAY_MS)}});
 }
 async reconcileConversation(conversationId:string){
  const pending=await this.database.conversationAllowanceBlock.findFirst({where:{conversationId,state:"PENDING"}});
  if(pending)await this.reconcileBlock(pending.id);
  await this.database.$transaction(async tx=>{
   await lockRecoveryContext(tx,conversationId);
   const active=await tx.conversationAllowanceBlock.findFirst({where:{conversationId,state:"ACTIVE"}});
   if(active&&await allowanceUsage(tx,active)>=active.hardMessageLimit-active.terminalReservedSlots)await notifyAllowanceBoundary(tx,active,this.clock());
  });
 }
 async repairPass(limit=100){
  const due=await this.database.conversationAllowanceBlock.findMany({where:{state:"PENDING",repairAt:{lte:this.clock()},OR:[{repairLeaseUntil:null},{repairLeaseUntil:{lte:this.clock()}}]},orderBy:[{repairAt:"asc"},{id:"asc"}],take:limit,select:{id:true}});
  for(const row of due){
   try{await this.reconcileBlock(row.id);}
   catch(error){logger.error("recovery.allowance.repair_failed",{blockId:row.id,error});}
  }
  return due.length;
 }
 private async reconcileBlock(id:string){
  const outcome=await this.database.$transaction(async tx=>{
   const pointer=await tx.conversationAllowanceBlock.findUnique({where:{id}});if(!pointer)return null;
   const context=await lockRecoveryContext(tx,pointer.conversationId);if(!context)return null;
   const block=await tx.conversationAllowanceBlock.findUniqueOrThrow({where:{id}});if(block.state!=="PENDING")return null;
   const now=this.clock();if(block.repairLeaseUntil&&block.repairLeaseUntil>now)return null;
   const token=randomUUID();
   await tx.conversationAllowanceBlock.update({where:{id},data:{repairLeaseToken:token,repairLeaseUntil:new Date(now.getTime()+WORK_LEASE_MS)}});
   // Recover the immutable reservation after a crash between billing admission
   // and the FK bind. The block ID, never the current plan, owns this action.
   if (!block.creditReservationId) {
    const attempt = block.fundingKind === "FOLLOW_UP"
     ? await tx.recoveryOutreachAttempt.findUnique({where:{checkoutRecoveryId_sequence:{checkoutRecoveryId:context.recoveryId,sequence:2}}}) : null;
    const source = block.fundingKind === "CONTINUATION"
     ? await findExactReservationSource(tx, block.shopId, allowanceSourceKey(block.shopId,block.id))
     : attempt ? await findExactReservationSource(tx, block.shopId, createRecoveryIdempotencyKey(block.shopId,`recovery-outreach:${attempt.id}`)) : null;
    if (source) {
     if (source.reservation.status !== "RESERVED") throw new AllowanceHeld("unattached-funding-not-reserved");
     await tx.conversationAllowanceBlock.update({where:{id},data:{creditReservationId:source.reservation.id}});
     block.creditReservationId=source.reservation.id;
    }
   }
   const messages=await tx.conversationMessage.findMany({where:{allowanceBlockId:id,direction:"OUTBOUND"},orderBy:[{createdAt:"asc"},{id:"asc"}]});
   const opening=messages[0];
   if(opening?.providerMessageId&&opening.sentAt&&["SENT","DELIVERED","READ"].includes(opening.status)&&!opening.failedAt){
    const source=await exactBlockSource(tx,block);if(!source)throw new AllowanceHeld("opening-funding-lineage");
    if(source.reservation.status==="RESERVED")await commitSource(tx,source,opening.sentAt);
    else if(source.reservation.status!=="COMMITTED")throw new AllowanceHeld("opening-funding-state");
    const settled=await exactBlockSource(tx,block);if(!settled||settled.reservation.status!=="COMMITTED")throw new AllowanceHeld("opening-not-settled");
    await readCommittedRecoveryUsage(tx,settled);
    await tx.conversationAllowanceBlock.updateMany({where:{id:block.predecessorId!,state:{in:["ACTIVE","EXHAUSTED"]}},data:{state:block.fundingKind==="CONTINUATION"?"EXHAUSTED":"CLOSED"}});
    const activated=await tx.conversationAllowanceBlock.update({where:{id},data:{state:"ACTIVE",repairAt:null,repairLeaseToken:null,repairLeaseUntil:null}});
    if(await allowanceUsage(tx,activated)>=activated.hardMessageLimit-activated.terminalReservedSlots)await notifyAllowanceBoundary(tx,activated,now);
    return null;
   }
   const noPermit=messages.every(m=>!m.providerDispatchKey&&!m.providerDispatchAdmittedAt&&!m.providerMessageId&&!m.sentAt);
   const evidence=await readRecoveryWindowEvidence(tx,{recoveryId:context.recoveryId,conversationId:context.id,now});
   const contactBlocked=!evidence||await hasLocalNoContact(tx,{shopId:block.shopId,recipient:evidence.recipient});
   const customerReturned=block.fundingKind==="FOLLOW_UP"&&customerWindow(evidence?.verifiedInboundAt??null,now).open;
   const noCurrentTurn=block.fundingKind==="CONTINUATION"&&!await hasCurrentContinuation(tx,context.id,context.inboundVersion);
   const invalid=noCurrentTurn||context.mode!=="AI"&&block.fundingKind==="CONTINUATION"||terminalRecovery(context.recoveryStatus)||block.repairDeadlineAt! <= now||contactBlocked||customerReturned;
   // A persisted HTTP rejection or definitive provider FAILED receipt is not
   // an ambiguous dispatch. Its specific code does not govern credit release.
   const definitiveFailure=!!opening&&(isConfirmedProviderNonDelivery(opening)||
    (opening.status==="FAILED"&&!!opening.failedAt&&!!opening.providerFailureCode&&!opening.deliveredAt&&!opening.readAt&&!opening.providerMessageId&&!opening.sentAt));
   if((noPermit && invalid)||opening?.status==="FAILED"&&(noPermit||definitiveFailure)){
    const otherAdmitted=messages.some(m=>m.id!==opening?.id&&(m.providerDispatchKey||m.providerDispatchAdmittedAt||m.providerMessageId||m.sentAt));
    if(otherAdmitted)throw new AllowanceHeld("late-opening-failure-after-consumption");
    const source=await exactBlockSource(tx,block);
    if(source?.reservation.status==="RESERVED")await releaseReservedSource(tx,source);
    else if(source&&source.reservation.status!=="RELEASED")throw new AllowanceHeld("pre-permit-funding-state");
    await tx.conversationAllowanceBlock.update({where:{id},data:{state:"CANCELLED",repairAt:null,repairLeaseToken:null,repairLeaseUntil:null}});
    return null;
   }
   if(block.repairDeadlineAt! <= now){
    await tx.conversationAllowanceBlock.update({where:{id},data:{repairAt:null,repairLeaseToken:null,repairLeaseUntil:null}});
    logger.error("recovery.allowance.reconciliation_required",{blockId:id,conversationId:block.conversationId,reason:"opening-outcome-unknown"});
    return null;
   }
   await tx.conversationAllowanceBlock.update({where:{id},data:{repairAt:new Date(Math.min(now.getTime()+REPAIR_DELAY_MS,block.repairDeadlineAt!.getTime())),repairLeaseToken:null,repairLeaseUntil:null}});
   return !opening&&!block.creditReservationId&&block.fundingKind==="CONTINUATION"?{shopId:context.shopId,conversationId:context.id,expectedControlRevision:context.revision,expectedInboundVersion:context.inboundVersion}:null;
  });
  if(outcome)await this.fundBlock(id,outcome);
 }
 async limits(shopId:string):Promise<AllowanceLimits>{
  try{return await new EffectiveBillingPolicyResolver(this.database).resolve(shopId);}
  catch(error){if(error instanceof EffectiveBillingPolicyError&&error.reason==="NO_CONTRACT")return new PostContractRecoveryPolicyResolver(this.database).resolve(shopId);throw error;}
 }
}
async function commitSource(tx:Tx,source:NonNullable<Awaited<ReturnType<typeof exactBlockSource>>>,occurredAt:Date){
 const input={shopId:source.reservation.shopId,sourceKey:source.reservation.sourceKey,quantity:1};
 const outcome=source.kind==="free"?await freeRecoveryReservationService.commitInExistingTransaction(tx,input):source.kind==="purchased"?await purchasedRecoveryReservationService.commitInExistingTransaction(tx,input):source.kind==="paid"?await paidIncludedRecoveryReservationService.commitInExistingTransaction(tx,{...input,occurredAt}):await promotionalRecoveryReservationService.commitInExistingTransaction(tx,input);
 if(outcome.kind!=="committed"&&outcome.kind!=="already-committed")throw new AllowanceHeld("opening-not-settled");
}
export const recoveryAllowanceService=new RecoveryAllowanceService();
