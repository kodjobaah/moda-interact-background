import type { PrismaClient } from "@prisma/client";
import {
  OpenRouterModelClient,
  type OpenRouterModelClientOptions,
} from "@modainteract/moda-interact-shared/commerce/model/node";
import type {
  CommerceEnvironment,
  ResolvedCommerceModel,
} from "@modainteract/moda-interact-shared/commerce/model";
import {
  CommerceModelInvocationFailure,
  type CommerceModelInvoker,
} from "@modainteract/moda-interact-shared/commerce/runner";
import type { LogFields, StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import {
  resolveProductionCommerceModel,
  type ResolvedProductionCommerceModel,
} from "./model-resolution.js";
import { OpenRouterCredentialResolutionFailure } from "./openrouter-credential-failure.js";
import type { OpenRouterCredentialResolver } from "./openrouter-credential.js";

export type ProductionOpenRouterModelFactory = (
  options: OpenRouterModelClientOptions,
) => CommerceModelInvoker;

export type ProductionCommerceModelInvoker = CommerceModelInvoker & {
  readonly selection: Pick<
    ResolvedProductionCommerceModel,
    "selectionSource" | "selectionShopId" | "merchantPricingPlanId" | "shopifyPlanHandle"
  >;
};

function safeModelLog(
  logger: StructuredLogger | undefined,
  event: string,
  fields: LogFields,
): void {
  try {
    logger?.warn(event, fields);
  } catch {
    // An injected logging sink must not alter Commerce execution.
  }
}

function cancelled(logger: StructuredLogger | undefined, fields: LogFields): Error {
  safeModelLog(logger, "commerce.model.operation_aborted", {
    ...fields,
    stage: "model.invoke",
    reasonCode: "MODEL_OPERATION_SIGNAL_ABORTED",
    reasonMessage: "The model invocation stopped because its AbortSignal was triggered.",
    operatorAction: "Inspect the runner cancellation and deadline events to identify the source.",
  });
  // The runner's existing AbortSignal handling remains authoritative for CANCELLED/DEADLINE.
  return new Error("Commerce model invocation failed");
}

function logInvocationFailure(
  logger: StructuredLogger | undefined,
  fields: LogFields,
  failure: CommerceModelInvocationFailure,
): void {
  safeModelLog(logger, "commerce.model.invocation_failed", {
    ...fields,
    ...failure.diagnostic,
  });
}

export async function createProductionCommerceModelInvoker(input: {
  db: PrismaClient;
  environment: CommerceEnvironment;
  shopId: string;
  credentialResolver: OpenRouterCredentialResolver;
  logger?: StructuredLogger;
  conversationId?: string;
  inboundVersion?: number;
  createClient?: ProductionOpenRouterModelFactory;
}): Promise<ProductionCommerceModelInvoker> {
  const correlation = {
    shopId: input.shopId,
    environment: input.environment,
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    ...(input.inboundVersion === undefined ? {} : { inboundVersion: input.inboundVersion }),
  };
  const resolved = await resolveProductionCommerceModel({
    db: input.db,
    environment: input.environment,
    shopId: input.shopId,
  });
  const model: ResolvedCommerceModel = resolved.model;
  const createClient = input.createClient ?? ((options) => new OpenRouterModelClient(options));
  const fields = {
    ...correlation,
    selectionSource: resolved.selectionSource,
    modelProvider: model.provider,
    modelCatalogueEntryId: model.catalogueEntryId,
  };

  return {
    selection: {
      selectionSource: resolved.selectionSource,
      selectionShopId: resolved.selectionShopId,
      merchantPricingPlanId: resolved.merchantPricingPlanId,
      shopifyPlanHandle: resolved.shopifyPlanHandle,
    },
    async invoke(request, signal) {
      if (signal.aborted) throw cancelled(input.logger, fields);
      let credential: string;
      try {
        credential = await input.credentialResolver.resolve({
          environment: input.environment,
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw cancelled(input.logger, fields);
        const failure = error instanceof OpenRouterCredentialResolutionFailure
          ? error
          : new OpenRouterCredentialResolutionFailure("CREDENTIAL_RESOLVER_FAILED", error);
        safeModelLog(input.logger, "commerce.model.credential_failed", {
          ...fields,
          stage: failure.stage,
          reasonCode: failure.reasonCode,
          reasonMessage: failure.reasonMessage,
          operatorAction: failure.operatorAction,
        });
        // Shared owns the public diagnostic vocabulary; Background logs the more
        // precise credential failure reason without changing the runner contract.
        throw new CommerceModelInvocationFailure({
          stage: "model.invoke",
          reasonCode: failure.reasonCode === "CREDENTIAL_LOOKUP_FAILED" ||
            failure.reasonCode === "CREDENTIAL_RESOLVER_FAILED"
            ? "MODEL_INVOCATION_FAILED"
            : "MODEL_CREDENTIAL_INVALID",
        }, failure);
      }
      if (signal.aborted) throw cancelled(input.logger, fields);

      let client: CommerceModelInvoker;
      try {
        client = createClient({
          provider: model.provider,
          providerModelId: model.providerModelId,
          configurationSchemaVersion: model.configurationSchemaVersion,
          configuration: model.configuration,
          credential,
          onDiagnostic(diagnostic) {
            // Shared sanitizes codes and constructs fixed safe operator explanations.
            const safe = new CommerceModelInvocationFailure({
              stage: "model.invoke",
              reasonCode: diagnostic.reason,
              providerStage: diagnostic.stage,
              ...(diagnostic.statusCode === undefined ? {} : { statusCode: diagnostic.statusCode }),
              ...(diagnostic.providerCode === undefined ? {} : { providerCode: diagnostic.providerCode }),
              ...(diagnostic.transportCode === undefined ? {} : { transportCode: diagnostic.transportCode }),
            }).diagnostic;
            safeModelLog(input.logger, "commerce.model.provider_diagnostic", {
              ...fields,
              ...safe,
            });
          },
        });
      } catch (error) {
        if (signal.aborted) throw cancelled(input.logger, fields);
        const failure = error instanceof CommerceModelInvocationFailure
          ? error
          : new CommerceModelInvocationFailure({
              stage: "model.invoke",
              reasonCode: "MODEL_ADAPTER_INITIALIZATION_FAILED",
              providerStage: "request",
            }, error);
        logInvocationFailure(input.logger, fields, failure);
        throw failure;
      }

      try {
        return await client.invoke(request, signal);
      } catch (error) {
        if (signal.aborted) throw cancelled(input.logger, fields);
        const failure = error instanceof CommerceModelInvocationFailure
          ? error
          : new CommerceModelInvocationFailure({
              stage: "model.invoke",
              reasonCode: "MODEL_INVOCATION_FAILED",
            }, error);
        logInvocationFailure(input.logger, fields, failure);
        throw failure;
      }
    },
  };
}
