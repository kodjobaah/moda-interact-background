import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { CommerceModelInvoker } from "@modainteract/moda-interact-shared/commerce/runner";
import { observeAgentInvocation } from "@modainteract/moda-interact-shared/observability/genai";
import prisma from "../lib/db.js";
import { executeCommerceHost } from "../commerce/host.js";
import { readCommerceCredentialKeyring } from "../commerce/credential-keyring.js";
import { resolveCommerceEnvironment } from "../commerce/model-environment.js";
import {
  createOpenRouterCredentialResolver,
  type OpenRouterCredentialResolver,
} from "../commerce/openrouter-credential.js";
import { createProductionCommerceModelInvoker } from "../commerce/production-model.js";
import type { RecoveryAgentContext } from "./types.js";
export type CommerceAgentDependencies = {
  model?: CommerceModelInvoker;
  signal?: AbortSignal;
  logger?: StructuredLogger;
  db?: typeof prisma;
  credentialResolver?: OpenRouterCredentialResolver;
};
export async function runCommerceAgent(
  context: RecoveryAgentContext,
  dependencies: CommerceAgentDependencies = {},
) {
  return observeAgentInvocation(
    { agentName: "commerce-agent" },
    async () => {
      const environment = resolveCommerceEnvironment();
      const db = dependencies.db ?? prisma;
      let model = dependencies.model;
      let modelSelection;
      if (!model) {
        const credentialResolver =
          dependencies.credentialResolver ??
          createOpenRouterCredentialResolver({
            db,
            keyring: readCommerceCredentialKeyring(),
          });
        const productionModel = await createProductionCommerceModelInvoker({
          db,
          environment,
          shopId: context.shopId,
          credentialResolver,
        });
        model = productionModel;
        modelSelection = productionModel.selection;
      }
      const logger = dependencies.logger ?? createLogger({
        serviceName: "moda-messaging-worker",
        environment,
      });
      return executeCommerceHost(context, {
        model,
        logger,
        ...(modelSelection ? { modelSelection } : {}),
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
