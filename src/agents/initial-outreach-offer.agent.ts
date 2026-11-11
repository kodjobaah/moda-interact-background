import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { CommerceModelInvoker } from "@modainteract/moda-interact-shared/commerce/runner";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import { createInitialOutreachOfferGraph, DEFAULT_MAX_MCP_CALLS, MAX_OUTREACH_DEADLINE_MS, type InitialOutreachExecutionLimits } from "./initial-outreach-offer.graph.js";
import { InitialOutreachAgentContextSchema, type InitialOutreachAgentResult } from "./initial-outreach-offer.types.js";
import { RecoveryOutreachMcpSelectorService } from "../services/recovery-offers/recovery-outreach-mcp-selector.service.js";
export type RunInitialOutreachOfferAgentDependencies = Readonly<{
 signal: AbortSignal; modelInvoker?: CommerceModelInvoker; createModelInvoker?: () => Promise<CommerceModelInvoker>;
 createSelector?: (input: { shopId: string; signal: AbortSignal; maxCalls?: number; maxProductDetailReads?: number; maxToolResultBytes?: number }) => RecoveryOutreachMcpSelectorService;
 maxMcpCalls?: number;
 executionLimits?: InitialOutreachExecutionLimits;
 logger?: Pick<StructuredLogger, "info" | "warn" | "error">; now?: () => Date;
}>;
export async function runInitialOutreachOfferAgent(rawContext: unknown, deps: RunInitialOutreachOfferAgentDependencies): Promise<InitialOutreachAgentResult> {
 const parsed = InitialOutreachAgentContextSchema.safeParse(rawContext);
 if (!parsed.success) return { kind: "FAILURE", code: "INVALID_RESULT", reasonCode: "TRUSTED_CONTEXT_INVALID", retryable: false };
 const context = parsed.data;
 const logger = deps.logger ?? createLogger({ serviceName: "moda-recovery-worker", environment: resolveDeploymentEnvironmentName() });
 const executionLimits = deps.executionLimits;
 const signal = AbortSignal.any([deps.signal, AbortSignal.timeout(executionLimits?.deadlineMs ?? MAX_OUTREACH_DEADLINE_MS)]);
 const maxMcpCalls = deps.maxMcpCalls ?? executionLimits?.toolCalls ?? DEFAULT_MAX_MCP_CALLS;
 const selector = (deps.createSelector ?? (input => new RecoveryOutreachMcpSelectorService(input)))({ shopId: context.shopId, signal, maxCalls: maxMcpCalls,
  ...(executionLimits ? { maxProductDetailReads: executionLimits.maxProductDetailReads, maxToolResultBytes: executionLimits.maxToolResultBytes } : {}) });
 try {
  const result = await createInitialOutreachOfferGraph({ context, selector, maxMcpCalls, ...(executionLimits ? { executionLimits } : {}), signal, startedAt: (deps.now?.() ?? new Date()).getTime(),
   ...(deps.now ? { now: deps.now } : {}), modelInvoker: deps.modelInvoker ?? deps.createModelInvoker ?? { invoke: async () => { throw Error("MODEL_INVOKER_UNAVAILABLE"); } },
  }).invoke();
  try { logger.info("outreach.offer_agent.completed", { shopId: context.shopId, recoveryId: context.checkoutRecoveryId,
   outreachAttemptId: context.outreachAttemptId, selectedOutcome: result.finalDecision.kind,
   toolCalls: result.mcpCalls, toolCallBudget: maxMcpCalls, modelSteps: result.modelSteps }); } catch { /* shared logger failure cannot change decisions */ }
  return result.finalDecision;
 } finally { await selector.close(); }
}
