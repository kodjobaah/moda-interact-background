import {
  safeParseNormalizedWhatsAppStatus,
  type NormalizedWhatsAppStatus,
} from "@modainteract/moda-interact-shared/billing";
import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import { MessageStatus, MerchantConversationSendState, Prisma, UsageMetric } from "@prisma/client";

import prisma from "../lib/db.js";
import {
  canApplyProviderStatus,
  statusForProviderEvent,
} from "../domain/whatsapp-provider-status-transition.js";
import { classifyWhatsAppProviderFailure } from "../domain/whatsapp-recipient-failure.js";

type Database = typeof prisma;
const MAX_TRANSACTION_RETRIES = 3;

const logger = createLogger({
  serviceName: "moda-messaging-worker",
  environment: resolveDeploymentEnvironmentName(),
});

export type ProviderStatusOutcome =
  "invalid" | "unknown-message" | "ignored" | "applied";

export class WhatsAppProviderStatusService {
  constructor(
    private readonly database: Database = prisma,
    private readonly serviceLogger: StructuredLogger = logger,
    private readonly maxRetries = MAX_TRANSACTION_RETRIES,
  ) {}

  async process(input: unknown): Promise<ProviderStatusOutcome> {
    const parsed = safeParseNormalizedWhatsAppStatus(input);
    if (!parsed.success) {
      this.serviceLogger.warn("whatsapp.provider_status.invalid", {
        reason: "schema-validation-failed",
      });
      return "invalid";
    }

    return this.apply(parsed.data);
  }

  private async apply(
    event: NormalizedWhatsAppStatus,
  ): Promise<ProviderStatusOutcome> {
    const occurredAt = new Date(event.occurredAt);

    return this.withRetry(() => this.database.$transaction(async (transaction) => {
      const message = await transaction.conversationMessage.findUnique({
        where: { providerMessageId: event.providerMessageId },
        select: {
          id: true,
          direction: true,
          status: true,
          sentAt: true,
          deliveredAt: true,
          readAt: true,
          providerFailureCode: true,
          failedAt: true,
          merchantSendCommand: { select: { id: true, state: true } },
          recoveryOutreachAttempt: { select: { id: true, status: true } },
          conversation: {
            select: {
              shopId: true,
              checkoutRecovery: { select: { shopId: true } },
            },
          },
        },
      });

      if (!message) {
        this.serviceLogger.warn("whatsapp.provider_status.unknown_message", {
          providerMessageId: event.providerMessageId,
        });
        return "unknown-message";
      }

      if (message.direction !== "OUTBOUND") {
        this.serviceLogger.warn("whatsapp.provider_status.non_outbound_message", {
          providerMessageId: event.providerMessageId,
          messageId: message.id,
        });
        return "ignored";
      }

      const shopId =
        message.conversation.shopId ??
        message.conversation.checkoutRecovery?.shopId;
      if (!shopId) {
        this.serviceLogger.warn("whatsapp.provider_status.unowned_message", {
          providerMessageId: event.providerMessageId,
          messageId: message.id,
        });
        return "ignored";
      }

      const canApplyStatus = canApplyProviderStatus(message.status, event.status);
      const nextStatus = statusForProviderEvent(message.status, event.status);
      const shouldRecordDelivered =
        canApplyStatus && (event.status === "DELIVERED" || event.status === "READ");
      const becameDelivered =
        shouldRecordDelivered &&
        message.status !== "DELIVERED" && message.status !== "READ";

      const lifecycleData = lifecycleUpdate(
        message,
        nextStatus,
        occurredAt,
        event.status,
        canApplyStatus,
        event,
      );
      const lifecycleChanged = Object.keys(lifecycleData).length > 0;
      if (lifecycleChanged) {
        const updated = await transaction.conversationMessage.updateMany({
          where: {
            id: message.id,
            direction: "OUTBOUND",
            status: message.status,
          },
          data: lifecycleData,
        });
        if (updated.count !== 1) throw new ProviderStatusConcurrencyConflict();
      }

      let commandConverged = false;
      if (message.merchantSendCommand && canApplyStatus) {
        if (event.status === "FAILED") {
          const updated = await transaction.merchantConversationSendCommand.updateMany({
            where: {
              id: message.merchantSendCommand.id,
              state: { in: [MerchantConversationSendState.DISPATCH_ADMITTED, MerchantConversationSendState.UNKNOWN] },
            },
            data: {
              state: MerchantConversationSendState.FAILED,
              failureCode: event.schemaVersion === 3 && event.failure
                ? event.failure.providerCode
                : "provider_failed",
              completedAt: occurredAt,
            },
          });
          commandConverged = updated.count === 1;
        } else if (event.status === "SENT" || event.status === "DELIVERED" || event.status === "READ") {
          const updated = await transaction.merchantConversationSendCommand.updateMany({
            where: {
              id: message.merchantSendCommand.id,
              state: { in: [MerchantConversationSendState.DISPATCH_ADMITTED, MerchantConversationSendState.UNKNOWN] },
            },
            data: {
              state: MerchantConversationSendState.SENT,
              completedAt: occurredAt,
            },
          });
          commandConverged = updated.count === 1;
        }
      }

      const updatedFailureCode = lifecycleData.providerFailureCode;
      const persistedFailureCode = typeof updatedFailureCode === "string"
        ? updatedFailureCode
        : message.providerFailureCode;
      const terminalRecipientFailure =
        canApplyStatus &&
        event.status === "FAILED" &&
        classifyWhatsAppProviderFailure(persistedFailureCode) === "RECIPIENT_UNDELIVERABLE";
      let attemptConverged = false;
      if (
        terminalRecipientFailure &&
        message.recoveryOutreachAttempt?.status === "WAITING_FOR_RESPONSE"
      ) {
        const converged = await transaction.recoveryOutreachAttempt.updateMany({
          where: {
            id: message.recoveryOutreachAttempt.id,
            status: "WAITING_FOR_RESPONSE",
          },
          data: {
            status: "FAILED",
            failureCode: "WHATSAPP_RECIPIENT_UNDELIVERABLE",
            closedAt: occurredAt,
          },
        });
        attemptConverged = converged.count === 1;
      }

      if (becameDelivered) {
        await transaction.usageEvent.upsert({
          where: { idempotencyKey: deliveredUsageKey(message.id) },
          create: {
            shopId,
            metric: UsageMetric.DELIVERED_WHATSAPP_MESSAGE,
            quantity: 1,
            idempotencyKey: deliveredUsageKey(message.id),
            sourceType: "WHATSAPP_PROVIDER_STATUS",
            sourceId: message.id,
            occurredAt,
            shopifyReportState: "NOT_APPLICABLE",
            providerResponseSummary: providerSummary(event),
          },
          update: {},
        });
      }

      this.serviceLogger.info("whatsapp.provider_status.applied", {
        messageId: message.id,
        status: event.status,
        outcome:
          !lifecycleChanged && !becameDelivered && !attemptConverged && !commandConverged
            ? "ignored"
            : "applied",
      });
      return !lifecycleChanged && !becameDelivered && !attemptConverged && !commandConverged
        ? "ignored"
        : "applied";
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!isRetryableConflict(error) || attempt === this.maxRetries - 1) {
          throw error;
        }
      }
    }
    throw new Error("Provider status retry limit exceeded");
  }
}

class ProviderStatusConcurrencyConflict extends Error {}

function lifecycleUpdate(
  message: {
    status: MessageStatus;
    sentAt: Date | null;
    deliveredAt: Date | null;
    readAt: Date | null;
    providerFailureCode: string | null;
    failedAt: Date | null;
  },
  nextStatus: MessageStatus,
  occurredAt: Date,
  eventStatus: NormalizedWhatsAppStatus["status"],
  canApplyStatus: boolean,
  event: NormalizedWhatsAppStatus,
): Prisma.ConversationMessageUpdateInput {
  const data: Prisma.ConversationMessageUpdateInput = {};
  if (nextStatus !== message.status) {
    data.status = nextStatus;
  }
  if (canApplyStatus && eventStatus === "SENT" && !message.sentAt) {
    data.sentAt = occurredAt;
  }
  if (
    (canApplyStatus || message.status === "READ") &&
    (eventStatus === "DELIVERED" || eventStatus === "READ") &&
    !message.deliveredAt
  ) {
    data.deliveredAt = occurredAt;
  }
  if (canApplyStatus && eventStatus === "READ" && !message.readAt) {
    data.readAt = occurredAt;
  }
  if (canApplyStatus && eventStatus === "FAILED") {
    if (!message.failedAt) data.failedAt = occurredAt;
    if (
      !message.providerFailureCode &&
      event.schemaVersion === 3 &&
      event.failure
    ) {
      data.providerFailureCode = event.failure.providerCode;
    }
  }
  return data;
}

function deliveredUsageKey(messageId: string): string {
  return `whatsapp-delivered:${messageId}`;
}

function providerSummary(event: NormalizedWhatsAppStatus): string {
  return JSON.stringify({
    providerAccountId: event.providerAccountId,
    providerPhoneNumberId: event.providerPhoneNumberId,
    status: event.status,
    ...(event.pricing ? { pricing: event.pricing } : {}),
  }).slice(0, 2000);
}

function isRetryableConflict(error: unknown): boolean {
  return error instanceof ProviderStatusConcurrencyConflict ||
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034");
}

export const whatsappProviderStatusService =
  new WhatsAppProviderStatusService();
