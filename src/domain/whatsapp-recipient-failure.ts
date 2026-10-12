export type WhatsAppProviderFailureClassification = "RECIPIENT_UNDELIVERABLE";

export function classifyWhatsAppProviderFailure(
  providerCode: string | null | undefined,
): WhatsAppProviderFailureClassification | null {
  return providerCode === "131026" ? "RECIPIENT_UNDELIVERABLE" : null;
}