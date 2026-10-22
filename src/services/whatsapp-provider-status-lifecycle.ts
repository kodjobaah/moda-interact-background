import { MessageStatus, Prisma } from "@prisma/client";
import type { NormalizedWhatsAppStatus } from "@modainteract/moda-interact-shared/billing";

export class ProviderStatusConcurrencyConflict extends Error {}

export function lifecycleUpdate(
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

export function deliveredUsageKey(messageId: string): string {
  return `whatsapp-delivered:${messageId}`;
}

export function providerSummary(event: NormalizedWhatsAppStatus): string {
  return JSON.stringify({
    providerAccountId: event.providerAccountId,
    providerPhoneNumberId: event.providerPhoneNumberId,
    status: event.status,
    ...(event.pricing ? { pricing: event.pricing } : {}),
  }).slice(0, 2000);
}

export function isRetryableConflict(error: unknown): boolean {
  return error instanceof ProviderStatusConcurrencyConflict ||
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034");
}
