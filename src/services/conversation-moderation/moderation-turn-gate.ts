import { readRoutingHistoryProjection, projectRoutingHistory, latestRoutingObjective } from '../recovery-sender-pool/routing-projection.js';
import {priorCommerceHistorySelection,commerceHistoryActivityAt} from '../../commerce/history-selection.js';
import prisma from "../../lib/db.js";
import { moderationAssessmentService, type ModerationAssessmentService } from "./moderation-assessment.service.js";
import { MODERATION_TIMEOUT_MS,moderationConfig } from "./moderation-policy.js";

export type PendingModerationOutcome = "allowed" | "suppressed" | "retry";

/** Turn settlement waits until each candidate inbound text is classified.
 * HTTP/Meta ingress persists/enqueues without calling OpenAI.
 */
export class ModerationTurnGate {
  constructor(private readonly assessment: ModerationAssessmentService = moderationAssessmentService, private readonly now:()=>Date=()=>new Date()) {}

  async moderatePending(conversationId: string, pendingTurnStartedAt: Date, processingLeaseExpiresAt?:Date): Promise<PendingModerationOutcome> {
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { shopId: true, checkoutRecovery: { select: { shopId: true } } },
    });
    const shopId = conversation.checkoutRecovery?.shopId ?? conversation.shopId;
    if (!shopId) throw new Error("moderation_tenant_unavailable");
    const projection = await readRoutingHistoryProjection(conversationId);
    const candidates = await prisma.conversationMessage.findMany({
      where: { conversationId, direction: "INBOUND", senderType: "CUSTOMER",
        OR: [
          { contentType: { not: "AUDIO" }, createdAt: { gte: pendingTurnStartedAt } },
          { contentType: "AUDIO", transcriptionCompletedAt: { gte: pendingTurnStartedAt } },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, direction: true, senderType: true, content: true, contentType: true, transcriptionStatus: true,createdAt:true,transcriptionCompletedAt:true },
    });
    const ordered = projectRoutingHistory(candidates, projection, pendingTurnStartedAt);
    const objective = latestRoutingObjective(ordered);
    const objectiveIds = new Set(objective.map(row => row.id));
    const latest = objective.at(-1);
    const allowedIds = new Set<string>();
    let retry = false;
    const seen=new Set<string>();
    for (const message of ordered) {
      if(seen.has(message.id))continue;seen.add(message.id);
      if (message.contentType !== "TEXT" && !(message.contentType === "AUDIO" && message.transcriptionStatus === "COMPLETED")) {
        // Unsupported images/media never become normal AI context.
        continue;
      }
      const result = await this.assessment.assessText({
        subject: { kind: "CUSTOMER_MESSAGE", messageId: message.id },
        shopId, conversationId, effectiveText: message.content,
        inputKind: message.contentType === "AUDIO" ? "TRANSCRIPT" : "TEXT",
        policyVersion: moderationConfig().policyVersion, now: this.now(),
      });
      if (objectiveIds.has(message.id) && result.kind === "allow") allowedIds.add(message.id);
      if (result.kind === "retry") retry = true;
    }
    // Historical outcomes cannot authorize a blocked/unsupported current turn.
    if(retry)return 'retry';
    if(!objective.length || objective.some(row => !allowedIds.has(row.id)))return 'suppressed';
    const historicalDeadline=this.now().getTime()+2*MODERATION_TIMEOUT_MS;
    const leaseDeadline=processingLeaseExpiresAt?.getTime()??Infinity;
    if(Number.isNaN(leaseDeadline))return 'retry';
    const priorSelection = priorCommerceHistorySelection(conversationId,latest ? commerceHistoryActivityAt(latest)??pendingTurnStartedAt : pendingTurnStartedAt,latest?.createdAt?{id:latest.id,createdAt:latest.createdAt}:undefined);
    const prior=await prisma.conversationMessage.findMany({
      ...priorSelection,
      where: projection.excludedMessageIds.length ? { AND: [priorSelection.where, { id: { notIn: projection.excludedMessageIds } }] } : priorSelection.where,
      select:{id:true,content:true,contentType:true,transcriptionStatus:true,direction:true,senderType:true},
    });
    for(const message of projectRoutingHistory(prior, projection).slice(-20)){
      if(seen.has(message.id))continue;seen.add(message.id);
      if(message.direction!=='INBOUND'||message.senderType!=='CUSTOMER'||
        !(message.contentType==='TEXT'||message.contentType==='AUDIO'&&message.transcriptionStatus==='COMPLETED'))continue;
      if(Math.min(historicalDeadline,leaseDeadline)-this.now().getTime()<MODERATION_TIMEOUT_MS+1000)return 'retry';
      const result=await this.assessment.assessText({subject:{kind:'CUSTOMER_MESSAGE',messageId:message.id},
        shopId,conversationId,effectiveText:message.content,inputKind:message.contentType==='AUDIO'?'TRANSCRIPT':'TEXT',
        policyVersion:moderationConfig().policyVersion,now:this.now()});
      if(result.kind==='retry')return 'retry';
    }
    // The existing turn retry path and bounded assessment backoff/attempt cap apply;
    // BLOCK/review stay excluded from history without suppressing the allowed turn.
    return 'allowed';
  }
}
export const moderationTurnGate = new ModerationTurnGate();
