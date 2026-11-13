import { readFrozenHumanBody } from '../recovery-conversation/human-prepared-command.service.js';
import prisma from "../../lib/db.js";
import { sha256Text } from "./moderation-assessment.service.js";
import { moderationConfig } from "./moderation-policy.js";
import { readModerationOperation, type ModerationOperationReader } from "./moderation-operation.js";

export type HistoryCandidate = { id: string; content: string; senderType: string; direction: string };
/** Content-specific immutable ALLOW only. Filter before serialising model history. */
export async function allowedHistoryCandidates<T extends HistoryCandidate>(
  items: T[], readOperation: ModerationOperationReader = readModerationOperation,
): Promise<T[]> {
  if (!items.length) return [];
  // Never allow an assessment from an older moderation model into normal AI context.
  // Reader failures propagate: there is no fail-open history fallback.
  const modelId = (await readOperation()).moderation.value.modelId;
  const version = moderationConfig().policyVersion;
  const ids = items.map((row) => row.id);
  const [decisions, human] = await Promise.all([
    prisma.conversationModerationAssessment.findMany({
      where: { conversationMessageId: { in: ids }, decision: "ALLOW", policyVersion: version, requestedModel: modelId },
      select: { conversationMessageId: true, contentSha256: true },
    }),
    prisma.merchantConversationSendCommand.findMany({
      where: { outboundMessageId: { in: ids } },
      select: { id:true,shopId:true,conversationId:true,state:true,outboundMessageId: true, kind: true, textBody: true,
        preparedTextBody:true,preparedWrapperEvidence:true,preparedAt:true,
        conversation:{select:{shopId:true,checkoutRecovery:{select:{shopId:true}}}},
        outboundMessage:{select:{id:true,conversationId:true,direction:true,senderType:true,status:true,sentAt:true,content:true}},
        moderationAssessments: { where: { policyVersion: version, requestedModel: modelId, decision: "ALLOW" },
          select: { contentSha256: true } },
      },
    }),
  ]);
  const approved = new Set(decisions.map((a) => `${a.conversationMessageId}:${a.contentSha256}`));
  const humanAllowed = new Map(human.flatMap(cmd=>{
    const message=cmd.outboundMessage;
    if(cmd.kind!=='HUMAN_TEXT'||cmd.state!=='SENT'||!message||!cmd.conversation.checkoutRecovery||
      cmd.shopId!==cmd.conversation.checkoutRecovery.shopId||cmd.conversation.shopId&&cmd.conversation.shopId!==cmd.shopId||
      cmd.outboundMessageId!==message.id||cmd.conversationId!==message.conversationId||message.direction!=='OUTBOUND'||message.senderType!=='HUMAN'||
      !message.sentAt||!['SENT','DELIVERED','READ'].includes(message.status))return [];
    // Explicit preparation must validate through the same immutable reader as dispatch.
    const hasPrepared=cmd.preparedTextBody!==null||cmd.preparedWrapperEvidence!==null||cmd.preparedAt!==null;
    const frozen=hasPrepared?readFrozenHumanBody(cmd,cmd.textBody,cmd.id,cmd.shopId):null;
    const body=hasPrepared?(frozen?.kind==='frozen'?frozen.body:null):cmd.textBody;
    if(body===null||body!==message.content||!cmd.moderationAssessments.some(a=>a.contentSha256===sha256Text(body)))return [];
    return [[message.id,body] as const];
  }));
  return items.filter(row=>row.senderType==='HUMAN'
    ?row.direction==='OUTBOUND'&&humanAllowed.get(row.id)===row.content
    :approved.has(`${row.id}:${sha256Text(row.content)}`));
}
