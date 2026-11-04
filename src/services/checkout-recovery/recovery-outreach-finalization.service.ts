import prisma from "../../lib/db.js";
import type { PrismaClient } from "@prisma/client";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { recoveryOutreachAttemptService } from "../recovery-outreach-attempt.service.js";
import { recoveryOutreachFollowUpService } from "../recovery-outreach-follow-up.service.js";
import {
  recoveryInitialOutreachSupportNoticeService,
} from "./recovery-initial-outreach-support-notice.service.js";
import type {
  ConfirmedInitialOutreachFinalizer,
} from "./recovery-initial-outreach-support-notice.contracts.js";
import {
  recoveryBillingService,
  type ConfirmedInitialOutreachSettlement,
  type RecoveryBillingService,
} from "../recovery-billing.service.js";
import { initialOutreachDiagnostic } from "../outbound-whatsapp-admission/outbound-provider-failure.service.js";

type FinalizationLogger = Pick<StructuredLogger, "error">;
type FinalizationDatabase = Pick<PrismaClient, "checkoutRecovery" | "recoveryOutreachAttempt">;
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
    private readonly database: FinalizationDatabase = prisma,
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

  async finalizeConfirmedInitialOutreach(input: {
    recovery: { id: string; shopId: string; status: string };
    attempt: {
      id: string;
      sequence: number;
      status: string;
      sentAt: Date | null;
      outboundMessageId: string | null;
      followUpDueAt: Date | null;
    };
    message: ConfirmedMessage;
    policy?: { followUpEnabled: boolean; followUpDelayMinutes: number | null };
  }): Promise<
    | { kind: "finalized"; outboundMessageId: string; sentAt: Date }
    | { kind: "held"; reason: Extract<ConfirmedInitialOutreachSettlement, { kind: "held" }>["reason"] }
  > {
    let stage: FinalizationStage = "billing";
    try {
      if (input.attempt.sequence !== 1) return { kind: "held", reason: "lineage-conflict" };
      const settlement = await this.billingService.settleConfirmedInitialOutreach({
        shopId: input.recovery.shopId,
        recoveryId: input.recovery.id,
        outreachAttemptId: input.attempt.id,
        outboundMessageId: input.message.id,
      });
      if (settlement.kind === "held") return settlement;
      if (settlement.outboundMessageId !== input.message.id ||
          settlement.sentAt.getTime() !== input.message.sentAt.getTime()) {
        return { kind: "held", reason: "lineage-conflict" };
      }

      const alreadyFinalized = input.attempt.outboundMessageId === input.message.id &&
        input.attempt.sentAt?.getTime() === input.message.sentAt.getTime();
      const followUpDueAt = alreadyFinalized
        ? input.attempt.followUpDueAt
        : input.policy?.followUpEnabled && input.policy.followUpDelayMinutes
          ? new Date(input.message.sentAt.getTime() + input.policy.followUpDelayMinutes * 60_000)
          : null;

      stage = "support_notice";
      await this.initialOutreachFinalizer.finalizeConfirmedInitial({
        shopId: input.recovery.shopId,
        checkoutRecoveryId: input.recovery.id,
        outreachAttemptId: input.attempt.id,
        outboundMessageId: input.message.id,
        sentAt: input.message.sentAt,
        followUpDueAt,
      });

      stage = "recovery_status";
      const transitioned = await this.database.checkoutRecovery.updateMany({
        where: { id: input.recovery.id, shopId: input.recovery.shopId, status: "DETECTED" },
        data: { status: "MESSAGE_SENT", messageSentAt: input.message.sentAt,
          admissionBlockedAt: null, admissionBlockReason: null },
      });
      if (transitioned.count !== 1) {
        const current = await this.database.checkoutRecovery.findUnique({
          where: { id: input.recovery.id },
          select: { shopId: true, status: true },
        });
        if (current?.shopId !== input.recovery.shopId ||
            !["MESSAGE_SENT", "ENGAGED", "COMPLETED", "CANCELLED", "EXPIRED"].includes(current.status)) {
          throw new Error(`Recovery status changed during confirmed initial finalization for ${input.recovery.id}`);
        }
      }

      stage = "follow_up";
      await this.ensureScheduledInitialFollowUp(input.recovery.id);
      return { kind: "finalized", outboundMessageId: input.message.id, sentAt: input.message.sentAt };
    } catch (error) {
      this.logConfirmedFinalizationFailure(input, stage, error);
      throw error;
    }
  }

  async finalizeConfirmedOutreach(input: {
    recovery: { id: string; shopId: string; status: string };
    attempt: { id: string; sequence: number; status: string; followUpDueAt?: Date | null; sentAt?: Date | null; outboundMessageId?: string | null };
    admission: Parameters<RecoveryBillingService["commitSuccessfulInitiation"]>[0]["admission"];
    message: ConfirmedMessage;
    policy?: { followUpEnabled: boolean; followUpDelayMinutes: number | null };
  }) {
    const alreadyFinalized = input.attempt.sequence === 1 &&
      input.attempt.outboundMessageId === input.message.id &&
      input.attempt.sentAt?.getTime() === input.message.sentAt.getTime();
    const followUpDueAt = input.attempt.sequence === 1
      ? alreadyFinalized ? input.attempt.followUpDueAt ?? null : (
          input.policy?.followUpEnabled && input.policy.followUpDelayMinutes
            ? new Date(input.message.sentAt.getTime() + input.policy.followUpDelayMinutes * 60_000)
            : null
        )
      : null;

    if (input.attempt.sequence === 1) {
      const result = await this.finalizeConfirmedInitialOutreach({
        recovery: input.recovery,
        attempt: {
          id: input.attempt.id,
          sequence: input.attempt.sequence,
          status: input.attempt.status,
          sentAt: input.attempt.sentAt ?? null,
          outboundMessageId: input.attempt.outboundMessageId ?? null,
          followUpDueAt: input.attempt.followUpDueAt ?? null,
        },
        message: input.message,
        ...(input.policy ? { policy: input.policy } : {}),
      });
      if (result.kind === "held") throw new Error(`INITIAL_OUTREACH_FINALIZATION_HELD:${result.reason}`);
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
        sourceError: initialOutreachDiagnostic(error),
      });
    } catch {
      // A failing logger sink must not mask the original Shopify finalisation error.
    }
  }

  private logConfirmedFinalizationFailure(
    input: Parameters<RecoveryOutreachFinalizationService["finalizeConfirmedInitialOutreach"]>[0],
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
        sourceError: initialOutreachDiagnostic(error),
      });
    } catch {
      // Preserve the finalization exception if the logging sink fails.
    }
  }

  async ensureScheduledInitialFollowUp(recoveryId: string) {
    const recovery = await this.database.checkoutRecovery.findUnique({
      where: { id: recoveryId },
      include: { outreachAttempts: { orderBy: { sequence: "asc" } } },
    });
    const initial = recovery?.outreachAttempts?.find((item) => item.sequence === 1);
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
