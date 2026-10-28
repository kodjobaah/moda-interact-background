import prisma from "../../lib/db.js";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { recoveryOutreachAttemptService } from "../recovery-outreach-attempt.service.js";
import { recoveryOutreachFollowUpService } from "../recovery-outreach-follow-up.service.js";
import {
  recoveryInitialOutreachSupportNoticeService,
} from "./recovery-initial-outreach-support-notice.service.js";
import type {
  ConfirmedInitialOutreachFinalizer,
  ConfirmedInitialRecoveryOutreachInput,
} from "./recovery-initial-outreach-support-notice.contracts.js";
import {
  recoveryBillingService,
  type RecoveryBillingService,
} from "../recovery-billing.service.js";

type FinalizationLogger = Pick<StructuredLogger, "error">;
type FinalizationStage = "billing" | "support_notice" | "recovery_status" | "follow_up";

const defaultFinalizationLogger = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});

type ConfirmedMessage = {
  id: string;
  conversationId: string;
  status: string;
  sentAt: Date;
};

export class RecoveryOutreachFinalizationService {
  constructor(
    private readonly billingService: RecoveryBillingService = recoveryBillingService,
    private readonly initialOutreachFinalizer: ConfirmedInitialOutreachFinalizer = recoveryInitialOutreachSupportNoticeService,
    private readonly logger: FinalizationLogger = defaultFinalizationLogger,
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
    recovery: { id: string; shopId: string; status: string };
    attempt: { id: string; sequence: number; followUpDueAt?: Date | null };
    admission: Parameters<RecoveryBillingService["commitSuccessfulInitiation"]>[0]["admission"];
    message: ConfirmedMessage;
    policy?: { followUpEnabled: boolean; followUpDelayMinutes: number | null };
  }) {
    const followUpDueAt = input.attempt.sequence === 1
      ? input.attempt.followUpDueAt ?? (
          input.policy?.followUpEnabled && input.policy.followUpDelayMinutes
            ? new Date(input.message.sentAt.getTime() + input.policy.followUpDelayMinutes * 60_000)
            : null
        )
      : null;

    if (input.attempt.sequence === 1) {
      let stage: FinalizationStage = "billing";
      try {
        await this.billingService.commitSuccessfulInitiation({
          admission: input.admission,
          recoveryId: input.recovery.id,
          occurredAt: input.message.sentAt,
        });

        stage = "support_notice";
        const noticeInput: ConfirmedInitialRecoveryOutreachInput = {
          shopId: input.recovery.shopId,
          checkoutRecoveryId: input.recovery.id,
          outreachAttemptId: input.attempt.id,
          outboundMessageId: input.message.id,
          sentAt: input.message.sentAt,
          followUpDueAt,
        };
        await this.initialOutreachFinalizer.finalizeConfirmedInitial(noticeInput);

        stage = "recovery_status";
        if (input.recovery.status === "DETECTED") {
          await prisma.checkoutRecovery.updateMany({
            where: { id: input.recovery.id, status: "DETECTED" },
            data: { status: "MESSAGE_SENT", messageSentAt: input.message.sentAt, admissionBlockedAt: null, admissionBlockReason: null },
          });
        }

        stage = "follow_up";
        await this.ensureScheduledInitialFollowUp(input.recovery.id);
      } catch (error) {
        this.logFinalizationFailure(input, stage, error);
        throw error;
      }
      return;
    }

    // Preserve the established billing and attempt transition behavior for sequence two.
    await this.billingService.commitSuccessfulInitiation({
      admission: input.admission,
      recoveryId: input.recovery.id,
      occurredAt: input.message.sentAt,
    });

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

  }

  private logFinalizationFailure(
    input: Parameters<RecoveryOutreachFinalizationService["finalizeConfirmedOutreach"]>[0],
    stage: FinalizationStage,
    error: unknown,
  ): void {
    try {
      this.logger.error("recovery.initial_outreach_support_notice.shopify_finalization_failed", {
        shopId: input.recovery.shopId,
        checkoutRecoveryId: input.recovery.id,
        outreachAttemptId: input.attempt.id,
        outboundMessageId: input.message.id,
        stage,
        error,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // A failing logger sink must not mask the original Shopify finalisation error.
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
