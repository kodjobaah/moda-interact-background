import type { ShopExecutionDenialReason } from "../shop-execution-eligibility.service.js";
import type { OutboundSuppressionReason } from "./outbound-whatsapp-admission.types.js";

export function definitiveProviderFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "WhatsAppServiceError" &&
    ["configuration-missing", "provider-rejected"].includes(
      (error as Error & { code?: string }).code ?? "",
    );
}

export function suppressionReason(reason: ShopExecutionDenialReason): OutboundSuppressionReason {
  if (reason === "CONTRACT_REQUIRED") return "contract-required";
  if (reason === "SUBSCRIPTION_FROZEN") return "subscription-frozen";
  return "shop-unavailable";
}
