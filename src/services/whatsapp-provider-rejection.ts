import { classifyWhatsAppProviderFailure } from "../domain/whatsapp-recipient-failure.js";

/** HTTP rejection evidence, never an inferred network/timeout outcome. */
export type DefinitiveWhatsAppError = Error & {
  name: "WhatsAppServiceError";
  code: "configuration-missing" | "provider-rejected";
  providerCode?: string;
};

export function isDefinitiveWhatsAppError(error: unknown): error is DefinitiveWhatsAppError {
  return error instanceof Error && error.name === "WhatsAppServiceError" &&
    ((error as Error & { code?: unknown }).code === "provider-rejected" ||
      (error as Error & { code?: unknown }).code === "configuration-missing");
}

/** Only the exact Meta rejection may enter correction + reachability. */
export function isSynchronousRecipientFailure(error: unknown): error is DefinitiveWhatsAppError {
  return isDefinitiveWhatsAppError(error) && error.code === "provider-rejected" &&
    classifyWhatsAppProviderFailure(error.providerCode) === "RECIPIENT_UNDELIVERABLE";
}
