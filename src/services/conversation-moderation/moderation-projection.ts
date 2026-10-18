import prisma from "../../lib/db.js";
import { moderationConfig } from "./moderation-policy.js";
import { readModerationOperation } from "./moderation-operation.js";
import type { ModerationSubject } from "./moderation-assessment.service.js";

/** API read adapter: no raw text, scores, private reviews, or provider metadata. */
export async function readShopModerationStatus(input: {
  shopId: string; conversationId: string; subject: ModerationSubject;
}): Promise<{ assessmentId: string; status: string; reasonCode: string | null } | null> {
  const currentModel = (await readModerationOperation()).moderation.value.modelId;
  const assessment = await prisma.conversationModerationAssessment.findFirst({
    where: {
      shopId: input.shopId, conversationId: input.conversationId,
      policyVersion: moderationConfig().policyVersion, requestedModel: currentModel,
      ...(input.subject.kind === "HUMAN_COMMAND"
        ? { merchantSendCommandId: input.subject.commandId }
        : { conversationMessageId: input.subject.messageId }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, decision: true, reasonCode: true },
  });
  return assessment ? { assessmentId: assessment.id,
    status: assessment.decision, reasonCode: assessment.reasonCode } : null;
}
