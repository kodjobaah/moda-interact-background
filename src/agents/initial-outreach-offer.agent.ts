import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { CommerceModelInvoker } from "@modainteract/moda-interact-shared/commerce/runner";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import { createInitialOutreachOfferGraph, MAX_OUTREACH_DEADLINE_MS } from "./initial-outreach-offer.graph.js";
import { InitialOutreachAgentContextSchema, type InitialOutreachAgentResult } from "./initial-outreach-offer.types.js";
import { RecoveryOutreachMcpSelectorService } from "../services/recovery-offers/recovery-outreach-mcp-selector.service.js";
export type RunInitialOutreachOfferAgentDependencies = Readonly<{
 signal: AbortSignal; modelInvoker?: CommerceModelInvoker; createModelInvoker?: () => Promise<CommerceModelInvoker>;
 createSelector?: (input: { shopId: string; signal: AbortSignal }) => RecoveryOutreachMcpSelectorService;
 logger?: Pick<StructuredLogger, "info" | "warn" | "error">; now?: () => Date;
}>;
export async function runInitialOutreachOfferAgent(rawContext: unknown, deps: RunInitialOutreachOfferAgentDependencies): Promise<InitialOutreachAgentResult> {
 const parsed = InitialOutreachAgentContextSchema.safeParse(rawContext);
 if (!parsed.success) return { kind: "FAILURE", code: "INVALID_RESULT", reasonCode: "TRUSTED_CONTEXT_INVALID", retryable: false };
 const context = parsed.data;
 const logger = deps.logger ?? createLogger({ serviceName: "moda-recovery-worker", environment: resolveDeploymentEnvironmentName() });
 const signal = AbortSignal.any([deps.signal, AbortSignal.timeout(MAX_OUTREACH_DEADLINE_MS)]);
 const selector = (deps.createSelector ?? (input => new RecoveryOutreachMcpSelectorService(input)))({ shopId: context.shopId, signal });
 try {
  const result = await createInitialOutreachOfferGraph({ context, selector, signal, startedAt: (deps.now?.() ?? new Date()).getTime(),
   ...(deps.now ? { now: deps.now } : {}), modelInvoker: deps.modelInvoker ?? deps.createModelInvoker ?? { invoke: async () => { throw Error("MODEL_INVOKER_UNAVAILABLE"); } },
  }).invoke();
  try { logger.info("outreach.offer_agent.completed", { shopId: context.shopId, recoveryId: context.checkoutRecoveryId,
   outreachAttemptId: context.outreachAttemptId, selectedOutcome: result.finalDecision.kind, toolCalls: result.mcpCalls, modelSteps: result.modelSteps }); } catch { /* shared logger failure cannot change decisions */ }
  return result.finalDecision;
 } finally { await selector.close(); }
}
