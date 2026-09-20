import type { LanguageModel } from "ai";
import { observeAgentInvocation } from "@modainteract/moda-interact-shared/observability/genai";
import { groq } from "../providers/groq.provider.js";
import { executeCommerceHost, modelAdapter } from "../commerce/host.js";
import type { RecoveryAgentContext } from "./types.js";
export type CommerceAgentDependencies = {
  model?: LanguageModel;
  signal?: AbortSignal;
};
export class CommerceAgentConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommerceAgentConfigurationError";
  }
}
export async function runCommerceAgent(
  context: RecoveryAgentContext,
  dependencies: CommerceAgentDependencies = {},
) {
  return observeAgentInvocation(
    { agentName: "commerce-agent" },
    async () => {
      const modelId = process.env.GROQ_COMMERCE_MODEL?.trim();
      if (!dependencies.model && !modelId)
        throw new CommerceAgentConfigurationError(
          "GROQ_COMMERCE_MODEL environment variable is not set",
        );
      return executeCommerceHost(context, {
        model: modelAdapter(dependencies.model ?? groq(modelId!)),
        ...(dependencies.signal ? { signal: dependencies.signal } : {}),
      });
    },
    {
      mapException: () => ({
        name: "CommerceAgentError",
        message: "Commerce agent invocation failed",
      }),
    },
  );
}
