import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { CommerceModelInvocationFailure } from "@modainteract/moda-interact-shared/commerce/runner";

/** Background-only provenance around the host's model invocation wrapper. */
export type CommerceModelBridgePhase =
  | "turn_state_check"
  | "production_model_invoke"
  | "response_postprocess";

export type CommerceModelBridgeIdentifiers = Readonly<{
  shopId: string;
  recoveryId: string;
  conversationId: string;
  inboundVersion: number;
}>;

const descriptions = {
  turn_state_check: {
    reasonCode: "HOST_MODEL_TURN_STATE_CHECK_FAILED",
    reasonMessage: "The host failed while checking conversation state before invoking the production model.",
    operatorAction: "Inspect the conversation processing lease and state lookup before the model call.",
  },
  production_model_invoke: {
    reasonCode: "HOST_MODEL_INVOKER_FAILED",
    reasonMessage: "The host's production-model invoker threw while handling the prepared request.",
    operatorAction: "Inspect the matching commerce.model credential, provider and invocation diagnostics.",
  },
  response_postprocess: {
    reasonCode: "HOST_MODEL_RESPONSE_POSTPROCESS_FAILED",
    reasonMessage: "The host failed while inspecting or reconciling the returned model step.",
    operatorAction: "Inspect model-step shape and final-response evidence handling in the host.",
  },
} as const;

const safeExceptionNames = new Set([
  "TypeError", "ReferenceError", "SyntaxError", "RangeError", "AbortError",
  "TimeoutError", "AggregateError",
]);

function safeExceptionName(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 6 && current instanceof Error && !seen.has(current); depth += 1) {
    seen.add(current);
    try {
      if (safeExceptionNames.has(current.name)) return current.name;
      current = current.cause;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Mark entry/dispatch to distinguish a runner-side request-construction failure. */
export function logCommerceModelBridgeMilestone(
  logger: StructuredLogger,
  identifiers: CommerceModelBridgeIdentifiers,
  phase: "turn_state_check" | "production_model_invoke",
): void {
  try {
    logger.debug("commerce.host.model_bridge.reached", { ...identifiers, phase });
  } catch {
    // Observability must never alter model invocation.
  }
}

/** Preserve original failure semantics; only attach fixed, safe operational provenance. */
export async function observeCommerceModelBridgePhase<T>(
  logger: StructuredLogger,
  identifiers: CommerceModelBridgeIdentifiers,
  phase: CommerceModelBridgePhase,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const explanation = descriptions[phase];
    const modelDiagnostic = error instanceof CommerceModelInvocationFailure
      ? error.diagnostic
      : undefined;
    try {
      logger.error("commerce.host.model_bridge.failed", {
        ...identifiers,
        phase,
        ...explanation,
        ...(safeExceptionName(error) ? { exceptionName: safeExceptionName(error) } : {}),
        ...(modelDiagnostic ? {
          modelReasonCode: modelDiagnostic.reasonCode,
          modelReasonMessage: modelDiagnostic.reasonMessage,
          modelOperatorAction: modelDiagnostic.operatorAction,
          modelProviderStage: modelDiagnostic.providerStage,
          modelStatusCode: modelDiagnostic.statusCode,
          modelTransportCode: modelDiagnostic.transportCode,
        } : {}),
      });
    } catch {
      // A broken logger cannot replace the original failure.
    }
    throw error;
  }
}
