import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import type { CommerceModelInvoker } from "@modainteract/moda-interact-shared/commerce/runner";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import { createInitialOutreachOfferGraph, MAX_OUTREACH_DEADLINE_MS } from "./initial-outreach-offer.graph.js";
import {
  InitialOutreachAgentContextSchema,
  InitialOutreachAgentResultSchema,
  type InitialOutreachAgentContext,
  type InitialOutreachAgentResult,
} from "./initial-outreach-offer.types.js";
import { RecoveryOutreachMcpSelectorService } from "../services/recovery-offers/recovery-outreach-mcp-selector.service.js";

const defaultLogger = createLogger({
  serviceName: "moda-background",
  environment: resolveDeploymentEnvironmentName(),
});

export type RunInitialOutreachOfferAgentDependencies = Readonly<{
  signal: AbortSignal;
  modelInvoker?: CommerceModelInvoker;
  createModelInvoker?: () => Promise<CommerceModelInvoker>;
  createSelector?: (input: { shopId: string; signal: AbortSignal }) => RecoveryOutreachMcpSelectorService;
  logger?: Pick<StructuredLogger, "info" | "warn" | "error">;
  now?: () => Date;
}>;

function safeLog(
  logger: Pick<StructuredLogger, "info" | "warn" | "error">,
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
): void {
  try { logger[level](event, fields); } catch { /* Logging must not alter offer selection. */ }
}

function safeExceptionFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { origin: "internal", sourceErrorName: "NonErrorThrown", sourceErrorMessage: "[REDACTED]", redactionApplied: true };
  const redact = (value: string, maximum: number) => {
    const safe = value.replace(/[\r\n\t]+/g, " ")
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED]")
      .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
      .replace(/\b(?:access[_ -]?token|refresh[_ -]?token|api[_ -]?key|client[_ -]?secret|password|passwd|secret|credential)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "[REDACTED]")
      .replace(/(?<![A-Za-z0-9])\+?\d(?:[\s().-]*\d){6,14}(?![A-Za-z0-9])/g, "[REDACTED]")
      .replace(/\b(?:https?:\/\/|www\.)[^\s<>"']+/gi, "[REDACTED_URL]");
    const truncated = safe.length > maximum;
    return { value: truncated ? `${safe.slice(0, maximum)}[TRUNCATED]` : safe,
      redacted: safe !== value, truncated };
  };
  const name = redact(error.name, 96);
  const message = redact(error.message, 512);
  return {
    origin: "sdk_exception",
    sourceError: { name: name.value, message: message.value },
    redactionApplied: name.redacted || message.redacted,
    truncated: name.truncated || message.truncated,
  };
}

function fail(
  code: Extract<InitialOutreachAgentResult, { kind: "FAILURE" }> ["code"],
  reasonCode: string,
  retryable: boolean,
): InitialOutreachAgentResult {
  return InitialOutreachAgentResultSchema.parse({ kind: "FAILURE", code, reasonCode, retryable });
}

function validatePriceReport(context: InitialOutreachAgentContext): string | null {
  if (context.mode === "NONE") return context.priceReconciliation === null ? null : "NONE_MODE_HAS_PRICE_REPORT";
  const report = context.priceReconciliation;
  if (!report) return "PRICE_PREFLIGHT_MISSING";
  if (report.shopId !== context.shopId || report.checkoutRecoveryId !== context.checkoutRecoveryId ||
      report.outreachAttemptId !== context.outreachAttemptId || report.generation !== context.basket.generation ||
      report.basketFingerprint !== context.basket.fingerprint || report.lines.length !== context.basket.items.length) {
    return "PRICE_PREFLIGHT_IDENTITY_MISMATCH";
  }
  const seen = new Set<string>();
  for (const [index, item] of context.basket.items.entries()) {
    const line = report.lines[index];
    if (!line || line.lineKey !== `line-${String(index + 1).padStart(4, "0")}` ||
        line.lineKey !== item.lineKey || seen.has(line.lineKey) ||
        line.productId !== item.productId || line.variantId !== item.variantId || line.quantity !== item.quantity) {
      return "PRICE_PREFLIGHT_LINE_MISMATCH";
    }
    seen.add(line.lineKey);
  }
  if (report.currentMerchandiseSubtotal &&
      (report.currentMerchandiseSubtotal.currency !== context.basket.currency ||
       !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(report.currentMerchandiseSubtotal.amountDecimal))) {
    return "PRICE_PREFLIGHT_SUBTOTAL_INVALID";
  }
  return null;
}

function policyNoOffer(context: InitialOutreachAgentContext): InitialOutreachAgentResult | null {
  if (context.mode === "NONE") {
    return InitialOutreachAgentResultSchema.parse({
      kind: "NO_VERIFIED_OFFER", reason: "POLICY_NONE", discoveryIncomplete: false,
    });
  }
  if (context.mode === "FIXED" && context.authorisedDiscountIds.length === 0) {
    return InitialOutreachAgentResultSchema.parse({
      kind: "NO_VERIFIED_OFFER", reason: "NO_AUTHORISED_DISCOUNTS", discoveryIncomplete: false,
    });
  }
  return null;
}

export async function runInitialOutreachOfferAgent(
  rawContext: unknown,
  dependencies: RunInitialOutreachOfferAgentDependencies,
): Promise<InitialOutreachAgentResult> {
  const logger = dependencies.logger ?? defaultLogger;
  const startedAt = (dependencies.now?.() ?? new Date()).getTime();
  const parsedContext = InitialOutreachAgentContextSchema.safeParse(rawContext);
  if (!parsedContext.success) {
    const result = fail("INVALID_RESULT", "TRUSTED_CONTEXT_INVALID", false);
    safeLog(logger, "error", "outreach.offer_agent.failed", {
      operation: "context.validate",
      reasonCode: "TRUSTED_CONTEXT_INVALID",
      selectedOutcome: result.kind,
      modelSteps: 0,
      toolCalls: 0,
      durationMs: Math.max(0, (dependencies.now?.() ?? new Date()).getTime() - startedAt),
    });
    return result;
  }
  const context = parsedContext.data as InitialOutreachAgentContext;
  const identifiers = {
    shopId: context.shopId,
    recoveryId: context.checkoutRecoveryId,
    outreachAttemptId: context.outreachAttemptId,
    mode: context.mode,
  };
  safeLog(logger, "info", "outreach.offer_agent.started", { ...identifiers, operation: "initial_outreach_offer" });
  const noOffer = policyNoOffer(context);
  if (noOffer) {
    safeLog(logger, "info", "outreach.offer_agent.completed", {
      ...identifiers,
      reasonCode: noOffer.kind === "NO_VERIFIED_OFFER" ? noOffer.reason : "POLICY_NO_OFFER",
      selectedOutcome: noOffer.kind,
      modelSteps: 0,
      toolCalls: 0,
      durationMs: Math.max(0, (dependencies.now?.() ?? new Date()).getTime() - startedAt),
    });
    return noOffer;
  }
  if (context.mode === "FIXED" && context.authorisedDiscountIds.length > 50) {
    return fail("INVALID_RESULT", "FIXED_SELECTION_LIMIT_EXCEEDED", false);
  }
  if (context.mode !== "FIXED" && context.authorisedDiscountIds.length !== 0) {
    return fail("INVALID_RESULT", "UNSELECTED_MODE_HAS_AUTHORISED_IDS", false);
  }
  const priceFailure = validatePriceReport(context);
  if (priceFailure) return fail("INVALID_RESULT", priceFailure, false);
  if (!dependencies.modelInvoker && !dependencies.createModelInvoker) {
    return fail("UNAVAILABLE", "MODEL_INVOKER_UNAVAILABLE", true);
  }

  const timeoutSignal = AbortSignal.timeout(MAX_OUTREACH_DEADLINE_MS);
  const signal = AbortSignal.any([dependencies.signal, timeoutSignal]);
  let selector: RecoveryOutreachMcpSelectorService | null = null;
  let primaryError: unknown;
  let result: InitialOutreachAgentResult | null = null;
  let modelSteps = 0;
  let toolCalls = 0;
  try {
    selector = (dependencies.createSelector ?? ((input) => new RecoveryOutreachMcpSelectorService(input)))({
      shopId: context.shopId,
      signal,
    });
    const graph = createInitialOutreachOfferGraph({
      context,
      selector,
      modelInvoker: dependencies.createModelInvoker ?? dependencies.modelInvoker!,
      signal,
      startedAt,
      ...(dependencies.now ? { now: dependencies.now } : {}),
      onEvent(event, details) {
        if (event === "model_step") {
          modelSteps = typeof details.modelStep === "number" ? details.modelStep : modelSteps;
          safeLog(logger, "info", "outreach.offer_agent.model_step", { ...identifiers, ...details });
        } else {
          toolCalls = typeof details.callNumber === "number" ? details.callNumber : toolCalls;
          safeLog(logger, "info", "outreach.offer_agent.tool_called", { ...identifiers, ...details });
        }
      },
    });
    const state = await graph.invoke();
    result = state.finalDecision ?? fail("INVALID_RESULT", "FINAL_DECISION_MISSING", false);
    if (state.failure) {
      safeLog(logger, "error", "outreach.offer_agent.failed", {
        ...identifiers,
        operation: "graph.execute",
        reasonCode: state.failure.reasonCode,
        ...(state.failure.error instanceof Error && state.failure.error.name === "CommerceHostError" &&
            "sourceFailure" in state.failure.error && state.failure.error.sourceFailure &&
            typeof state.failure.error.sourceFailure === "object"
          ? state.failure.error.sourceFailure as Record<string, unknown> : {}),
        sourceErrorName: state.failure.error instanceof Error ? state.failure.error.name : undefined,
        selectedOutcome: result.kind,
        modelSteps: state.modelSteps,
        toolCalls: state.mcpCalls,
        durationMs: Math.max(0, (dependencies.now?.() ?? new Date()).getTime() - startedAt),
      });
    }
    if (result.kind === "FAILURE") {
      safeLog(logger, "error", "outreach.offer_agent.failed", {
        ...identifiers,
        operation: "finalize",
        reasonCode: result.reasonCode,
        selectedOutcome: result.kind,
        modelSteps: state.modelSteps,
        toolCalls: state.mcpCalls,
        durationMs: Math.max(0, (dependencies.now?.() ?? new Date()).getTime() - startedAt),
      });
      return result;
    }
  } catch (error) {
    primaryError = error;
    const code = error instanceof Error && error.name === "TimeoutError" ? "DEADLINE"
      : dependencies.signal.aborted ? "CANCELLED" : "UNAVAILABLE";
    safeLog(logger, "error", "outreach.offer_agent.failed", {
      ...identifiers,
      operation: "agent.run",
      origin: "internal",
      reasonCode: code === "DEADLINE" ? "OUTREACH_DEADLINE" : code === "CANCELLED" ? "OUTREACH_CANCELLED" : "OUTREACH_UNEXPECTED_FAILURE",
      sourceErrorName: error instanceof Error ? error.name : "NonErrorThrown",
      durationMs: Math.max(0, (dependencies.now?.() ?? new Date()).getTime() - startedAt),
    });
    throw error;
  } finally {
    if (selector) {
      try { await selector.close(); }
      catch (closeError) {
        safeLog(logger, "error", "outreach.offer_agent.failed", {
          ...identifiers,
          operation: "mcp.close",
          reasonCode: "MCP_CLIENT_CLOSE_FAILED",
          ...safeExceptionFields(closeError),
          primaryFailurePresent: primaryError !== undefined || result?.kind === "FAILURE",
        });
      }
    }
  }

  if (!result) return fail("INVALID_RESULT", "FINAL_DECISION_MISSING", false);
  safeLog(logger, "info", "outreach.offer_agent.completed", {
    ...identifiers,
    selectedOutcome: result.kind,
    reasonCode: result.kind === "NO_VERIFIED_OFFER" ? result.reason : undefined,
    modelSteps,
    toolCalls,
    durationMs: Math.max(0, (dependencies.now?.() ?? new Date()).getTime() - startedAt),
  });
  return result;
}