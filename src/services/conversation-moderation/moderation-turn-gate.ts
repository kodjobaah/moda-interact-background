import prisma from "../../lib/db.js";
import { moderationAssessmentService, type ModerationAssessmentService } from "./moderation-assessment.service.js";
import { moderationConfig } from "./moderation-policy.js";

export type PendingModerationOutcome = "allowed" | "suppressed" | "retry";

/** Turn settlement waits until each candidate inbound text is classified.
 * HTTP/Meta ingress persists/enqueues without calling OpenAI.
 */
export class ModerationTurnGate {
  constructor(private readonly assessment: ModerationAssessmentService = moderationAssessmentService) {}

  async moderatePending(conversationId: string, pendingTurnStartedAt: Date): Promise<PendingModerationOutcome> {
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { shopId: true, checkoutRecovery: { select: { shopId: true } } },
    });
    const shopId = conversation.checkoutRecovery?.shopId ?? conversation.shopId;
    if (!shopId) throw new Error("moderation_tenant_unavailable");
    const candidates = await prisma.conversationMessage.findMany({
      where: { conversationId, direction: "INBOUND", senderType: "CUSTOMER",
        OR: [
          { contentType: { not: "AUDIO" }, createdAt: { gte: pendingTurnStartedAt } },
          { contentType: "AUDIO", transcriptionCompletedAt: { gte: pendingTurnStartedAt } },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, content: true, contentType: true, transcriptionStatus: true },
    });
    let allowed = false;
    let retry = false;
    for (const message of candidates) {
      if (message.contentType !== "TEXT" && !(message.contentType === "AUDIO" && message.transcriptionStatus === "COMPLETED")) {
        // Unsupported images/media never become normal AI context.
        continue;
      }
      const result = await this.assessment.assessText({
        subject: { kind: "CUSTOMER_MESSAGE", messageId: message.id },
        shopId, conversationId, effectiveText: message.content,
        inputKind: message.contentType === "AUDIO" ? "TRANSCRIPT" : "TEXT",
        policyVersion: moderationConfig().policyVersion, now: new Date(),
      });
      if (result.kind === "allow") allowed = true;
      if (result.kind === "retry") retry = true;
    }
    return retry ? "retry" : allowed ? "allowed" : "suppressed";
  }
}
export const moderationTurnGate = new ModerationTurnGate();
