import type { PrismaClient } from "@prisma/client";
import {
  OpenRouterModelClient,
  type OpenRouterModelClientOptions,
} from "@modainteract/moda-interact-shared/commerce/model/node";
import type {
  CommerceEnvironment,
  ResolvedCommerceModel,
} from "@modainteract/moda-interact-shared/commerce/model";
import type { CommerceModelInvoker } from "@modainteract/moda-interact-shared/commerce/runner";
import {
  resolveProductionCommerceModel,
  type ResolvedProductionCommerceModel,
} from "./model-resolution.js";
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

export async function createProductionCommerceModelInvoker(input: {
  db: PrismaClient;
  environment: CommerceEnvironment;
  shopId: string;
  credentialResolver: OpenRouterCredentialResolver;
  createClient?: ProductionOpenRouterModelFactory;
}): Promise<ProductionCommerceModelInvoker> {
  const resolved = await resolveProductionCommerceModel({
    db: input.db,
    environment: input.environment,
    shopId: input.shopId,
  });
  const model: ResolvedCommerceModel = resolved.model;
  const createClient = input.createClient ?? ((options) => new OpenRouterModelClient(options));

  return {
    selection: {
      selectionSource: resolved.selectionSource,
      selectionShopId: resolved.selectionShopId,
      merchantPricingPlanId: resolved.merchantPricingPlanId,
      shopifyPlanHandle: resolved.shopifyPlanHandle,
    },
    async invoke(request, signal) {
      if (signal.aborted) throw new Error("Commerce model invocation failed");
      try {
        const credential = await input.credentialResolver.resolve({
          environment: input.environment,
          signal,
        });
        if (signal.aborted) throw new Error("Commerce model invocation failed");
        const client = createClient({
          provider: model.provider,
          providerModelId: model.providerModelId,
          configurationSchemaVersion: model.configurationSchemaVersion,
          configuration: model.configuration,
          credential,
        });
        return await client.invoke(request, signal);
      } catch {
        throw new Error("Commerce model invocation failed");
      }
    },
  };
}