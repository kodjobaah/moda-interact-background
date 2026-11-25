export type WhatsAppProviderFailureClassification = "RECIPIENT_UNDELIVERABLE";

export function classifyWhatsAppProviderFailure(
  providerCode: string | null | undefined,
): WhatsAppProviderFailureClassification | null {
  return providerCode === "131026" ? "RECIPIENT_UNDELIVERABLE" : null;
}

/** Provider acceptance is not delivery. Require durable negative evidence and
 * never interpret pending, timeout or positive receipt evidence as non-delivery.
 * The existing synchronous recipient-rejection path remains independently valid.
 */
export function isConfirmedProviderNonDelivery(message: {
  status: string; providerMessageId: string | null; failedAt: Date | null;
  deliveredAt: Date | null; readAt: Date | null;
}): boolean {
  return message.status === "FAILED" && !!message.providerMessageId &&
    !!message.failedAt && !message.deliveredAt && !message.readAt;
}

export function outreachDeliveryFailureCode(providerCode: string | null | undefined): string {
  return classifyWhatsAppProviderFailure(providerCode) === "RECIPIENT_UNDELIVERABLE"
    ? "WHATSAPP_RECIPIENT_UNDELIVERABLE"
    : providerCode && /^[A-Za-z0-9_-]{1,64}$/.test(providerCode)
      ? `WHATSAPP_DELIVERY_FAILED:${providerCode}` : "WHATSAPP_DELIVERY_FAILED";
}
