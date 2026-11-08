import { INITIAL_OUTREACH_HOST_INVARIANTS } from "./initial-outreach-offer.instructions.js";
import { evaluateInitialOutreach, type InitialOutreachEvaluationInput } from "@modainteract/moda-interact-shared/commerce/outreach";
import type { CommerceModelInvoker } from "@modainteract/moda-interact-shared/commerce/runner";
import type { InitialOutreachAgentContext, InitialOutreachAgentResult } from "./initial-outreach-offer.types.js";
import type { RecoveryOutreachMcpSelectorService } from "../services/recovery-offers/recovery-outreach-mcp-selector.service.js";

export const MAX_MODEL_STEPS = 8;
export const MAX_MCP_CALLS = 16;
export const MAX_PRODUCT_SEARCHES = 3; // historical caller compatibility; new checkout evaluator never searches
export const MAX_PRODUCT_DETAIL_READS = 5;
export const MAX_OUTREACH_DEADLINE_MS = 45_000;
export const MAX_TOOL_RESULT_BYTES = 32 * 1024;
export const MAX_TOOL_MESSAGES_BYTES = 128 * 1024;
export type InitialOutreachOfferGraphDependencies = Readonly<{
 context: InitialOutreachAgentContext; selector: RecoveryOutreachMcpSelectorService;
 modelInvoker: CommerceModelInvoker | (() => Promise<CommerceModelInvoker>); signal: AbortSignal;
 startedAt: number; now?: () => Date;
 onEvent?: (event: "model_step" | "tool_called", details: Readonly<Record<string, unknown>>) => void;
}>;
/** Compatibility facade only. All checkout read/selection/revalidation decisions live in Shared. */
export function createInitialOutreachOfferGraph(deps: InitialOutreachOfferGraphDependencies) {
 return { async invoke() {
  const context = deps.context;
  let connected = false;
  let listed = new Set<string>();
  let model: CommerceModelInvoker | undefined;
  let publishedBehaviourPrompt = "";
  let modelSteps = 0, mcpCalls = 0;
  const raw = {
   schemaVersion: 1, runId: context.outreachAttemptId, shopId: context.shopId, platform: context.platform, environment: context.environment,
   checkout: { id: context.checkoutRecoveryId, generation: context.basket.generation, currency: context.basket.currency,
    url: context.checkoutUrl, lines: context.basket.items.map((line, i) => ({ lineKey: line.lineKey, productId: line.productId,
     variantId: line.variantId, quantity: line.quantity, checkoutUnitPrice: line.checkoutUnitPrice ?? context.priceReconciliation?.lines[i]?.checkoutUnitPrice ?? null })) },
   policy: { mode: context.mode, authorisedDiscountIds: context.authorisedDiscountIds },
   instructions: { platformText: context.platformInstructions, platformRevisionId: context.platformInstructionRevisionId,
    merchantText: context.merchantInstructions, merchantRevisionId: context.merchantInstructionRevisionId,
    purposeText: "Evaluate only the real checkout items. Never propose another product or grant send admission.", purposeProfileRevisionId: "background-checkout-outreach-policy-v1" },
   limits: { deadlineMs: Math.max(1, MAX_OUTREACH_DEADLINE_MS - ((deps.now?.() ?? new Date()).getTime() - deps.startedAt)), modelSteps: MAX_MODEL_STEPS, remoteCalls: MAX_MCP_CALLS, outputTokens: 512 },
  } as InitialOutreachEvaluationInput;
  const evaluation = await evaluateInitialOutreach(raw, {
   signal: deps.signal, now: deps.now ?? (() => new Date()),
   callTool: async call => {
    if (!connected) { await deps.selector.connect(); listed = new Set((await deps.selector.tools()).map(tool => tool.name));
      publishedBehaviourPrompt = deps.selector.profile?.()?.behaviourPrompt ?? "";
      connected = true; }
    if (!listed.has(call.name)) throw Object.assign(new Error("OUTREACH_TOOL_NOT_LISTED"), { code: "DENIED", retryable: false });
    mcpCalls++; deps.onEvent?.("tool_called", { toolName: call.name, callNumber: mcpCalls });
    const result = await deps.selector.call(call.name, call.arguments, call.signal);
    if (result.status === "ERROR") throw Object.assign(new Error("OUTREACH_PROVIDER_REFUSAL"), { code: result.code, retryable: result.retryable });
    return result.data;
   },
   modelInvoker: { invoke: async (request, signal) => {
    model ??= typeof deps.modelInvoker === "function" ? await deps.modelInvoker() : deps.modelInvoker;
    modelSteps++; deps.onEvent?.("model_step", { modelStep: modelSteps });
    const trustedRequest = { ...request, instructions: [...request.instructions, INITIAL_OUTREACH_HOST_INVARIANTS,
      ...(publishedBehaviourPrompt ? [publishedBehaviourPrompt] : [])] };
    if (Buffer.byteLength(JSON.stringify(trustedRequest), "utf8") > MAX_TOOL_MESSAGES_BYTES) throw Object.assign(new Error("OUTREACH_MESSAGE_BUDGET_EXHAUSTED"), { code: "BUDGET_EXHAUSTED" });
    return model.invoke(trustedRequest, signal);
   } },
   log: () => {},
  });
  let finalDecision: InitialOutreachAgentResult;
  if (evaluation.kind === "refused") {
   const code = (["DENIED", "CANCELLED", "DEADLINE", "BUDGET_EXHAUSTED"] as string[]).includes(evaluation.reasonCode)
    ? evaluation.reasonCode as "DENIED" | "CANCELLED" | "DEADLINE" | "BUDGET_EXHAUSTED" : "INVALID_RESULT";
   finalDecision = { kind: "FAILURE", code, reasonCode: `OUTREACH_EVALUATION_${evaluation.reasonCode}`, retryable: false };
  } else if (evaluation.offerDecision.kind === "NO_VERIFIED_OFFER") {
   finalDecision = { kind: "NO_VERIFIED_OFFER", reason: evaluation.offerDecision.reasonCode, discoveryIncomplete: evaluation.offerDecision.discoveryIncomplete, evaluation };
  } else {
   finalDecision = { ...evaluation.offerDecision, shopId: context.shopId, checkoutRecoveryId: context.checkoutRecoveryId,
    outreachAttemptId: context.outreachAttemptId, generation: context.basket.generation, fingerprint: context.basket.fingerprint,
    priceReconciliation: {
      shopId: context.shopId, checkoutRecoveryId: context.checkoutRecoveryId, outreachAttemptId: context.outreachAttemptId,
      generation: context.basket.generation, basketFingerprint: context.basket.fingerprint, evaluatedAt: evaluation.evaluatedAt,
      currentMerchandiseSubtotal: evaluation.currentMerchandiseSubtotal, completeness: "COMPLETE", reasonCodes: [],
      lines: evaluation.lines.map(line => ({ lineKey: line.lineKey, productId: line.productId, variantId: line.variantId,
        quantity: line.quantity, checkoutUnitPrice: line.checkoutUnitPrice, checkoutCurrency: context.basket.currency,
        catalogueUnitPrice: line.currentProduct.unitPrice, catalogueCurrency: line.currentProduct.currency,
        catalogueObservedAt: line.currentProduct.observedAt, catalogueComparison: line.comparison,
        checkoutPriceChange: "UNVERIFIABLE", reasonCodes: [] })),
    }, evaluation };
  }
  return { finalDecision, modelSteps, mcpCalls, failure: finalDecision.kind === "FAILURE" ? { code: finalDecision.code, reasonCode: finalDecision.reasonCode } : null };
 } };
}
