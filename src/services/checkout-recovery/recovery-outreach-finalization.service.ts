import prisma from "../../lib/db.js";
import { recoveryOutreachAttemptService } from "../recovery-outreach-attempt.service.js";
import { recoveryOutreachFollowUpService } from "../recovery-outreach-follow-up.service.js";
import {
  recoveryBillingService,
  type RecoveryBillingService,
} from "../recovery-billing.service.js";

type ConfirmedMessage = {
  id: string;
  conversationId: string;
  status: string;
  sentAt: Date;
};

export class RecoveryOutreachFinalizationService {
  constructor(
    private readonly billingService: RecoveryBillingService = recoveryBillingService,
  ) {}

  requireConfirmedMessage(
    message: { id: string; conversationId: string; status: string; sentAt: Date | null } | null,
    conversationId: string,
    attemptId: string,
  ): asserts message is ConfirmedMessage {
    if (
      !message ||
      !["SENT", "DELIVERED", "READ"].includes(message.status) ||
      !message.sentAt ||
      message.conversationId !== conversationId
    ) {
      throw new Error(`Recovery outreach has no confirmed durable message for attempt ${attemptId}`);
    }
  }

  async finalizeConfirmedOutreach(input: {
    recovery: { id: string; status: string };
    attempt: { id: string; sequence: number; followUpDueAt?: Date | null };
    admission: Parameters<RecoveryBillingService["commitSuccessfulInitiation"]>[0]["admission"];
    message: ConfirmedMessage;
    policy?: { followUpEnabled: boolean; followUpDelayMinutes: number | null };
  }) {
    await this.billingService.commitSuccessfulInitiation({
      admission: input.admission,
      recoveryId: input.recovery.id,
      occurredAt: input.message.sentAt,
    });

    const followUpDueAt = input.attempt.sequence === 1
      ? input.attempt.followUpDueAt ?? (
          input.policy?.followUpEnabled && input.policy.followUpDelayMinutes
            ? new Date(input.message.sentAt.getTime() + input.policy.followUpDelayMinutes * 60_000)
            : null
        )
      : null;
    const transition = await recoveryOutreachAttemptService.markWaitingAfterConfirmedSend(
      input.attempt.id,
      {
        sentAt: input.message.sentAt,
        outboundMessageId: input.message.id,
        followUpDueAt,
      },
    );
    if (transition && transition.count === 0) {
      const current = await prisma.recoveryOutreachAttempt.findUnique({ where: { id: input.attempt.id } });
      if (!current || current.outboundMessageId !== input.message.id || ["FAILED", "CANCELLED"].includes(current.status)) {
        throw new Error(`Recovery outreach finalisation conflict for attempt ${input.attempt.id}`);
      }
    }

    if (input.attempt.sequence === 1) {
      if (input.recovery.status === "DETECTED") {
        await prisma.checkoutRecovery.updateMany({
          where: { id: input.recovery.id, status: "DETECTED" },
          data: { status: "MESSAGE_SENT", messageSentAt: input.message.sentAt, admissionBlockedAt: null, admissionBlockReason: null },
        });
      }
      await this.ensureScheduledInitialFollowUp(input.recovery.id);
    }
  }

  async ensureScheduledInitialFollowUp(recoveryId: string) {
    const recovery = await prisma.checkoutRecovery.findUnique({
      where: { id: recoveryId },
      include: { outreachAttempts: { orderBy: { sequence: "asc" } } },
    });
    const initial = recovery?.outreachAttempts.find((item) => item.sequence === 1);
    if (
      !recovery ||
      !["MESSAGE_SENT", "ENGAGED"].includes(recovery.status) ||
      !initial ||
      initial.status !== "WAITING_FOR_RESPONSE" ||
      !initial.sentAt ||
      !initial.followUpDueAt ||
      initial.customerRespondedAt ||
      recovery.outreachAttempts.some((item) => ["WAITING_FOR_RESPONSE", "ENGAGED"].includes(item.status) && item.sequence === 2)
    ) return;
    await recoveryOutreachFollowUpService.schedule(
      { checkoutRecoveryId: recovery.id, sequence: 2 },
      initial.followUpDueAt,
    );
  }
}