import type { InitialFallbackTrigger } from "./initial-no-offer-fallback.service.js";

export type InitialOutreachFailureInput =
  | Readonly<{ kind: "OPTIONAL_ENRICHMENT_FAILURE"; trigger: InitialFallbackTrigger; beforeProviderAdmission: true }>
  | Readonly<{ kind: "MANDATORY_SEND_BLOCK"; reason:
      "STOP" | "CONSENT" | "TERMINAL_RECOVERY_OR_ORDER" |
      "WRONG_SHOP_OR_RECIPIENT" | "MODERATION" | "BILLING_OR_CAPACITY" |
      "TEMPLATE_NOT_APPROVED" | "CHECKOUT_ITEMS_UNAVAILABLE" }>
  | Readonly<{ kind: "TRANSIENT_REQUIRED_STATE"; reason:
      "DB_OR_CONFIG_UNAVAILABLE" | "CURRENT_RECOVERY_UNVERIFIABLE" }>
  | Readonly<{ kind: "PROVIDER_OUTCOME_UNCERTAIN" }>;

export type InitialFallbackDecision =
  | Readonly<{ action: "PREPARE_NO_OFFER_TEXT"; trigger: InitialFallbackTrigger }>
  | Readonly<{ action: "DO_NOT_SEND"; reason: Extract<InitialOutreachFailureInput,
      {kind:"MANDATORY_SEND_BLOCK"}>["reason"] }>
  | Readonly<{ action: "RETRY_EXISTING_ATTEMPT"; reason: Extract<InitialOutreachFailureInput,
      {kind:"TRANSIENT_REQUIRED_STATE"}>["reason"] }>
  | Readonly<{ action: "RECONCILE_EXISTING_SEND" }>;

export function classifyInitialOutreachFallback(
  input: InitialOutreachFailureInput,
): InitialFallbackDecision {
  switch (input.kind) {
    case "OPTIONAL_ENRICHMENT_FAILURE":
      return { action: "PREPARE_NO_OFFER_TEXT", trigger: input.trigger };
    case "MANDATORY_SEND_BLOCK":
      return { action: "DO_NOT_SEND", reason: input.reason };
    case "TRANSIENT_REQUIRED_STATE":
      return { action: "RETRY_EXISTING_ATTEMPT", reason: input.reason };
    case "PROVIDER_OUTCOME_UNCERTAIN":
      return { action: "RECONCILE_EXISTING_SEND" };
  }
}