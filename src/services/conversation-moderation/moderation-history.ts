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
      select: { outboundMessageId: true, kind: true, textBody: true,
        moderationAssessments: { where: { policyVersion: version, requestedModel: modelId, decision: "ALLOW" },
          select: { contentSha256: true } },
      },
    }),
  ]);
  const approved = new Set(decisions.map((a) => `${a.conversationMessageId}:${a.contentSha256}`));
  const humanAllowed = new Set(human.filter((cmd) => cmd.kind === "HUMAN_TEXT" &&
    cmd.moderationAssessments.some((a) => a.contentSha256 === sha256Text(cmd.textBody ?? "")))
    .map((cmd) => cmd.outboundMessageId));
  return items.filter((row) => approved.has(`${row.id}:${sha256Text(row.content)}`) ||
    (row.senderType === "HUMAN" && humanAllowed.has(row.id)));
}
