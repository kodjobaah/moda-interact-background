import {
  safeParseNormalizedWhatsAppStatus,
  type NormalizedWhatsAppStatus,
} from "@modainteract/moda-interact-shared/billing";
import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import { MessageStatus, Prisma, UsageMetric } from "@prisma/client";

import prisma from "../lib/db.js";

type Database = typeof prisma;
const MAX_TRANSACTION_RETRIES = 3;

const STATUS_RANK: Record<MessageStatus, number> = {
  PENDING: 0,
  FAILED: 1,
  SENT: 2,
  DELIVERED: 3,
  READ: 4,
};

const logger = createLogger({
  serviceName: "moda-messaging-worker",
  environment: process.env.NODE_ENV ?? "development",
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

      const nextStatus = statusForEvent(event.status, message.status);
      const shouldRecordDelivered =
        event.status === "DELIVERED" || event.status === "READ";
      const becameDelivered =
        shouldRecordDelivered &&
        STATUS_RANK[message.status] < STATUS_RANK.DELIVERED;

      const lifecycleData = lifecycleUpdate(
        message,
        nextStatus,
        occurredAt,
        event.status,
      );
      if (Object.keys(lifecycleData).length > 0) {
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
          nextStatus === message.status && !becameDelivered
            ? "ignored"
            : "applied",
      });
      return nextStatus === message.status && !becameDelivered
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

function statusForEvent(
  eventStatus: NormalizedWhatsAppStatus["status"],
  currentStatus: MessageStatus,
): MessageStatus {
  const candidate = eventStatus as MessageStatus;
  if (
    candidate === "FAILED" &&
    (currentStatus === "PENDING" || currentStatus === "SENT")
  ) {
    return candidate;
  }
  return STATUS_RANK[candidate] > STATUS_RANK[currentStatus]
    ? candidate
    : currentStatus;
}

function lifecycleUpdate(
  message: {
    status: MessageStatus;
    sentAt: Date | null;
    deliveredAt: Date | null;
    readAt: Date | null;
  },
  nextStatus: MessageStatus,
  occurredAt: Date,
  eventStatus: NormalizedWhatsAppStatus["status"],
): Prisma.ConversationMessageUpdateInput {
  const data: Prisma.ConversationMessageUpdateInput = {};
  if (
    nextStatus !== message.status &&
    (nextStatus === "FAILED" ||
      STATUS_RANK[nextStatus] > STATUS_RANK[message.status])
  ) {
    data.status = nextStatus;
  }
  if (eventStatus === "SENT" && !message.sentAt) data.sentAt = occurredAt;
  if (
    (eventStatus === "DELIVERED" || eventStatus === "READ") &&
    !message.deliveredAt
  ) {
    data.deliveredAt = occurredAt;
  }
  if (eventStatus === "READ" && !message.readAt) data.readAt = occurredAt;
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
