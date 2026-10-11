import type { MessageStatus } from "@prisma/client";
import type { NormalizedWhatsAppStatus } from "@modainteract/moda-interact-shared/billing";

const ALLOWED_TRANSITIONS: Record<
  MessageStatus,
  readonly NormalizedWhatsAppStatus["status"][]
> = {
  PENDING: ["SENT", "DELIVERED", "READ", "FAILED"],
  SENT: ["DELIVERED", "READ", "FAILED"],
  FAILED: ["DELIVERED", "READ"],
  DELIVERED: ["READ"],
  READ: [],
};

export function canApplyProviderStatus(
  currentStatus: MessageStatus,
  eventStatus: NormalizedWhatsAppStatus["status"],
): boolean {
  return currentStatus === eventStatus ||
    ALLOWED_TRANSITIONS[currentStatus].includes(eventStatus);
}

export function statusForProviderEvent(
  currentStatus: MessageStatus,
  eventStatus: NormalizedWhatsAppStatus["status"],
): MessageStatus {
  return canApplyProviderStatus(currentStatus, eventStatus)
    ? eventStatus as MessageStatus
    : currentStatus;
}