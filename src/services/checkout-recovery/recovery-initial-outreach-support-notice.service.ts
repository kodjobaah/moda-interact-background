import {
  MerchantSupportMessageKind,
  MerchantSupportMessageState,
  MessageDirection,
  MessageSenderType,
  MessageStatus,
  Prisma,
  RecoveryOutreachInitiator,
  RecoveryOutreachStatus,
  RecoveryOutreachTrigger,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import prisma from "../../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import type {
  ConfirmedInitialOutreachFinalizer,
  ConfirmedInitialRecoveryOutreachInput,
  InitialOutreachNoticeResult,
} from "./recovery-initial-outreach-support-notice.contracts.js";

type NoticeDatabase = Pick<PrismaClient, "$transaction">;
type NoticeLogger = Pick<StructuredLogger, "info" | "error">;
type ErrorCategory = "INVALID_INPUT" | "LINEAGE_MISMATCH" | "FINALIZATION_CONFLICT" | "PERSISTENCE_FAILURE";
type NoticeEvent =
  | "recovery.initial_outreach_support_notice.created"
  | "recovery.initial_outreach_support_notice.disabled"
  | "recovery.initial_outreach_support_notice.replayed"
  | "recovery.initial_outreach_support_notice.failed";

const defaultLogger = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});
const originalBody = "A checkout recovery message was sent to a customer.";
const outcomeEvents = {
  created: "recovery.initial_outreach_support_notice.created",
  disabled: "recovery.initial_outreach_support_notice.disabled",
  replayed: "recovery.initial_outreach_support_notice.replayed",
} as const;
const confirmedMessageStatuses: MessageStatus[] = [MessageStatus.SENT, MessageStatus.DELIVERED, MessageStatus.READ];
const replayableStatuses: RecoveryOutreachStatus[] = [
  RecoveryOutreachStatus.WAITING_FOR_RESPONSE,
  RecoveryOutreachStatus.ENGAGED,
  RecoveryOutreachStatus.NO_RESPONSE,
];
const initialPendingStatuses: RecoveryOutreachStatus[] = [
  RecoveryOutreachStatus.PENDING,
  RecoveryOutreachStatus.CAPACITY_BLOCKED,
];
const sourceKeyFor = (attemptId: string) => `recovery-initial-outreach:v1:${attemptId}`;

class FinalizationError extends Error {
  constructor(readonly category: ErrorCategory, message: string) {
    super(message);
    this.name = "FinalizationError";
  }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= 128;
}

function validateInput(input: ConfirmedInitialRecoveryOutreachInput): void {
  if (!input || typeof input !== "object") {
    throw new FinalizationError("INVALID_INPUT", "Invalid initial outreach finalisation input");
  }
  if (!validId(input.shopId)) throw new FinalizationError("INVALID_INPUT", "Invalid shopId");
  if (!validId(input.checkoutRecoveryId)) {
    throw new FinalizationError("INVALID_INPUT", "Invalid checkoutRecoveryId");
  }
  if (!validId(input.outreachAttemptId)) {
    throw new FinalizationError("INVALID_INPUT", "Invalid outreachAttemptId");
  }
  if (!validId(input.outboundMessageId)) {
    throw new FinalizationError("INVALID_INPUT", "Invalid outboundMessageId");
  }
  if (!(input.sentAt instanceof Date) || !Number.isFinite(input.sentAt.getTime())) {
    throw new FinalizationError("INVALID_INPUT", "Invalid sentAt");
  }
  if (input.followUpDueAt !== null &&
      (!(input.followUpDueAt instanceof Date) || !Number.isFinite(input.followUpDueAt.getTime()) ||
       input.followUpDueAt.getTime() <= input.sentAt.getTime())) {
    throw new FinalizationError("INVALID_INPUT", "Invalid followUpDueAt");
  }
}

function sameDate(left: Date | null, right: Date | null): boolean {
  return left?.getTime() === right?.getTime();
}

function lineageMismatch(message: string): never {
  throw new FinalizationError("LINEAGE_MISMATCH", message);
}

function finalizationConflict(message: string): never {
  throw new FinalizationError("FINALIZATION_CONFLICT", message);
}

/** Atomically records the confirmed first send and, when enabled, one Support notice. */
export class RecoveryInitialOutreachSupportNoticeService implements ConfirmedInitialOutreachFinalizer {
  constructor(
    private readonly database: NoticeDatabase = prisma,
    private readonly now: () => Date = () => new Date(),
    private readonly logger: NoticeLogger = defaultLogger,
  ) {}

  async finalizeConfirmedInitial(
    input: ConfirmedInitialRecoveryOutreachInput,
  ): Promise<InitialOutreachNoticeResult> {
    let inputValidated = false;
    try {
      validateInput(input);
      inputValidated = true;
      const result = await this.database.$transaction(async (tx): Promise<InitialOutreachNoticeResult> => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id"
          FROM "commerce"."RecoveryOutreachAttempt"
          WHERE "id" = ${input.outreachAttemptId}
          FOR UPDATE
        `);
        if (locked.length !== 1) lineageMismatch("Initial outreach attempt was not found");

        const attempt = await tx.recoveryOutreachAttempt.findUnique({
          where: { id: input.outreachAttemptId },
          select: {
            id: true,
            checkoutRecoveryId: true,
            sequence: true,
            trigger: true,
            initiatedBy: true,
            status: true,
            sentAt: true,
            outboundMessageId: true,
            followUpDueAt: true,
            checkoutRecovery: {
              select: {
                shopId: true,
                conversation: { select: { id: true, shopId: true } },
              },
            },
          },
        });
        if (!attempt || attempt.id !== input.outreachAttemptId ||
            attempt.checkoutRecoveryId !== input.checkoutRecoveryId ||
            attempt.sequence !== 1 || attempt.trigger !== RecoveryOutreachTrigger.INITIAL ||
            attempt.initiatedBy === RecoveryOutreachInitiator.HUMAN) {
          lineageMismatch("Initial outreach attempt lineage did not match");
        }
        const recovery = attempt.checkoutRecovery;
        const conversation = recovery.conversation;
        if (recovery.shopId !== input.shopId || !conversation ||
            (conversation.shopId !== null && conversation.shopId !== recovery.shopId)) {
          lineageMismatch("Recovery tenant or conversation lineage did not match");
        }

        const outboundMessage = await tx.conversationMessage.findUnique({
          where: { id: input.outboundMessageId },
          select: {
            id: true,
            conversationId: true,
            direction: true,
            senderType: true,
            status: true,
            sentAt: true,
          },
        });
        if (!outboundMessage || outboundMessage.conversationId !== conversation.id ||
            outboundMessage.direction !== MessageDirection.OUTBOUND ||
            outboundMessage.senderType !== MessageSenderType.AUTOMATION ||
            !confirmedMessageStatuses.includes(outboundMessage.status) ||
            !outboundMessage.sentAt || outboundMessage.sentAt.getTime() !== input.sentAt.getTime()) {
          lineageMismatch("Confirmed outbound message lineage did not match");
        }

        if (replayableStatuses.includes(attempt.status)) {
          if (attempt.outboundMessageId !== input.outboundMessageId ||
              !sameDate(attempt.sentAt, input.sentAt) ||
              !sameDate(attempt.followUpDueAt, input.followUpDueAt)) {
            finalizationConflict("Initial outreach attempt was finalised with a different message identity");
          }
          return { outcome: "replayed", outreachAttemptId: attempt.id };
        }
        if (!initialPendingStatuses.includes(attempt.status) ||
            attempt.sentAt !== null || attempt.outboundMessageId !== null) {
          finalizationConflict("Initial outreach attempt cannot be finalised from its current state");
        }

        const transitioned = await tx.recoveryOutreachAttempt.updateMany({
          where: {
            id: attempt.id,
            status: { in: [RecoveryOutreachStatus.PENDING, RecoveryOutreachStatus.CAPACITY_BLOCKED] },
            sentAt: null,
            outboundMessageId: null,
          },
          data: {
            status: RecoveryOutreachStatus.WAITING_FOR_RESPONSE,
            sentAt: input.sentAt,
            outboundMessageId: input.outboundMessageId,
            followUpDueAt: input.followUpDueAt,
          },
        });
        if (transitioned.count !== 1) {
          finalizationConflict("Initial outreach attempt changed before finalisation");
        }

        const settings = await tx.shopSettings.findUnique({
          where: { shopId: recovery.shopId },
          select: { notifyOnInitialRecoveryOutreach: true },
        });
        if (!settings?.notifyOnInitialRecoveryOutreach) {
          return { outcome: "disabled", outreachAttemptId: attempt.id };
        }

        await tx.merchantSupportThread.createMany({
          data: [{ shopId: recovery.shopId }],
          skipDuplicates: true,
        });
        const thread = await tx.merchantSupportThread.findUniqueOrThrow({
          where: { shopId: recovery.shopId },
          select: { id: true },
        });
        const availableAt = this.now();
        if (!(availableAt instanceof Date) || !Number.isFinite(availableAt.getTime())) {
          throw new FinalizationError("INVALID_INPUT", "Invalid now() date");
        }
        const sourceKey = sourceKeyFor(attempt.id);
        const inserted = await tx.merchantSupportMessage.createMany({
          skipDuplicates: true,
          data: [{
            threadId: thread.id,
            kind: MerchantSupportMessageKind.SYSTEM,
            state: MerchantSupportMessageState.AVAILABLE,
            originalBody,
            sourceLanguageTag: "en-GB",
            systemCode: "RECOVERY_INITIAL_OUTREACH_SENT",
            systemVersion: "1",
            sourceKey,
            checkoutRecoveryId: attempt.checkoutRecoveryId,
            readAt: null,
            availableAt,
          }],
        });
        if (inserted.count !== 1) {
          finalizationConflict("Initial outreach Support source key already exists");
        }
        await tx.merchantSupportThread.updateMany({
          where: {
            id: thread.id,
            OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: availableAt } }],
          },
          data: { lastMessageAt: availableAt },
        });
        return { outcome: "created", outreachAttemptId: attempt.id };
      });
      const event: NoticeEvent = outcomeEvents[result.outcome];
      this.logSafely(event, {
        shopId: input.shopId,
        checkoutRecoveryId: input.checkoutRecoveryId,
        outreachAttemptId: input.outreachAttemptId,
        outboundMessageId: input.outboundMessageId,
        outcome: result.outcome,
      }, "info");
      return result;
    } catch (error) {
      const category: ErrorCategory = error instanceof FinalizationError
        ? error.category
        : "PERSISTENCE_FAILURE";
      const fields: Record<string, unknown> = {
        outcome: "failed",
        errorCategory: category,
      };
      // Shared logging applies its bounded Error serialization to both domain and persistence failures.
      fields.error = error;
      if (inputValidated) {
        fields.shopId = input.shopId;
        fields.checkoutRecoveryId = input.checkoutRecoveryId;
        fields.outreachAttemptId = input.outreachAttemptId;
        fields.outboundMessageId = input.outboundMessageId;
      }
      this.logSafely("recovery.initial_outreach_support_notice.failed", fields, "error");
      throw error;
    }
  }

  private logSafely(event: NoticeEvent, fields: Record<string, unknown>, level: "info" | "error"): void {
    // A failing sink must never undo a committed transaction or replace its original error.
    try {
      this.logger[level](event, fields);
    } catch {
      // Logging is best-effort; preserve business success and failure semantics.
    }
  }
}

export const recoveryInitialOutreachSupportNoticeService = new RecoveryInitialOutreachSupportNoticeService();
