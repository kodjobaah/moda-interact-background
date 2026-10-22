import type { PrismaClient } from "@prisma/client";
import prisma from "../lib/db.js";
import type { FailedMessageIdentity, ReachabilityFailureOutcome } from "./recipient-reachability-failure.service.js";
import {
  recoveryDeliveryNoticeBody, type CorrectedDisposition, type NotifiableCorrection,
} from "./recovery-delivery-notification-content.js";
import {
  recoveryDeliverySupportMessageService,
  type SupportNoticeOutcome,
} from "./recovery-delivery-support-message.service.js";

const COMPLETED = new Set<NotifiableCorrection>([
  "released", "already-released", "restored-spendable", "historical-only", "held-for-refund",
]);
export type RecoveryDeliveryNoticeOutcome = SupportNoticeOutcome | "skipped" | "deferred";

/** Runs strictly after committed correction and applicable reachability writing. */
export class RecoveryDeliveryMerchantNotificationService {
  constructor(
    private readonly database: Pick<PrismaClient, "conversationMessage"> = prisma,
    private readonly support: Pick<typeof recoveryDeliverySupportMessageService, "write"> =
      recoveryDeliverySupportMessageService,
  ) {}

  async notify(
    identity: FailedMessageIdentity,
    correction: NotifiableCorrection,
    reachability: ReachabilityFailureOutcome,
  ): Promise<RecoveryDeliveryNoticeOutcome> {
    if (correction === "purchased-compensation-required" || reachability === "deferred") {
      return "deferred";
    }
    if (!COMPLETED.has(correction)) return "skipped";

    const message = await this.database.conversationMessage.findUnique({
      where: "messageId" in identity
        ? { id: identity.messageId } : { providerMessageId: identity.providerMessageId },
      select: {
        id: true, direction: true, status: true, providerFailureCode: true,
        conversation: {
          select: {
            shopId: true,
            checkoutRecovery: { select: { id: true, shopId: true } },
          },
        },
      },
    });
    if (!message || message.direction !== "OUTBOUND" || message.status !== "FAILED") {
      return "skipped";
    }
    const recovery = message.conversation.checkoutRecovery;
    if (!recovery) return "skipped";
    if (message.conversation.shopId && message.conversation.shopId !== recovery.shopId) {
      throw new Error("Recovery failure notification has conflicting Shop ownership");
    }
    const suppressionRequired = message.providerFailureCode === "131026";
    if (suppressionRequired && reachability === "not-applicable") {
      throw new Error("Recipient suppression is required before merchant notification");
    }
    if (!suppressionRequired && reachability !== "not-applicable") {
      throw new Error("Non-recipient failure has unexpected suppression outcome");
    }
    return this.support.write({
      shopId: recovery.shopId,
      recoveryId: recovery.id,
      messageId: message.id,
      body: recoveryDeliveryNoticeBody(
        correction as CorrectedDisposition,
        suppressionRequired && reachability === "suppressed",
      ),
    });
  }
}

export const recoveryDeliveryMerchantNotificationService =
  new RecoveryDeliveryMerchantNotificationService();
