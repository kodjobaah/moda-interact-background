import { Prisma, type PrismaClient } from "@prisma/client";
import {
  CommerceEnvironmentSchema,
  CommerceModelAvailabilitySchema,
  CommerceModelCatalogueEntrySchema,
  CommerceModelSelectionSourceSchema,
  CommercePricingPlanModelAssignmentSchema,
  ResolvedCommerceModelSchema,
  type CommerceEnvironment,
  type CommerceModelSelectionSource,
  type ResolvedCommerceModel,
} from "@modainteract/moda-interact-shared/commerce/model";

export type ResolvedProductionCommerceModel = {
  selectionSource: CommerceModelSelectionSource;
  selectionShopId: string | null;
  merchantPricingPlanId: string | null;
  shopifyPlanHandle: string | null;
  model: ResolvedCommerceModel;
};

const UNAVAILABLE = "Commerce model is unavailable";

export async function resolveProductionCommerceModel(input: {
  db: PrismaClient;
  environment: CommerceEnvironment;
  shopId: string;
}): Promise<ResolvedProductionCommerceModel> {
  const environment = CommerceEnvironmentSchema.parse(input.environment);
  return await input.db.$transaction(
    async (transaction) => {
      const shop = await transaction.shop.findUnique({
        where: { id: input.shopId },
        select: { id: true },
      });
      if (!shop) throw new Error(UNAVAILABLE);

      const shopConfiguration = await transaction.commerceAgentConfiguration.findFirst({
        where: { environment, scope: "SHOP", shopId: input.shopId },
        select: { modelId: true },
      });
      if (shopConfiguration?.modelId) {
        const model = await readResolvedModel(
          transaction,
          shopConfiguration.modelId,
          environment,
          input.shopId,
          "SHOP",
        );
        return result("SHOP", input.shopId, null, null, model);
      }

      const subscription = await transaction.subscription.findUnique({
        where: { shopId: shop.id },
        select: {
          status: true,
          planId: true,
          plan: { select: { shopifyPlanHandle: true } },
        },
      });
      if (
        subscription &&
        (subscription.status === "ACTIVE" || subscription.status === "TRIALING") &&
        subscription.planId &&
        subscription.plan
      ) {
        const plan = await transaction.merchantPricingPlan.findUnique({
          where: { shopifyPlanHandle: subscription.plan.shopifyPlanHandle },
          select: { id: true, shopifyPlanHandle: true, commerceModelId: true },
        });
        if (plan) {
          const assignment = CommercePricingPlanModelAssignmentSchema.parse({
            merchantPricingPlanId: plan.id,
            shopifyPlanHandle: plan.shopifyPlanHandle,
            modelId: plan.commerceModelId,
          });
          if (assignment.modelId !== null) {
            const model = await readResolvedModel(
              transaction,
              assignment.modelId,
              environment,
              input.shopId,
              "PLATFORM",
            );
            return result(
              "PRICING_PLAN",
              input.shopId,
              assignment.merchantPricingPlanId,
              assignment.shopifyPlanHandle,
              model,
            );
          }
        }
      }

      const platformConfiguration = await transaction.commerceAgentConfiguration.findFirst({
        where: { environment, scope: "PLATFORM", shopId: null },
        select: { modelId: true },
      });
      if (!platformConfiguration?.modelId) throw new Error(UNAVAILABLE);
      const model = await readResolvedModel(
        transaction,
        platformConfiguration.modelId,
        environment,
        input.shopId,
        "PLATFORM",
      );
      return result("PLATFORM", null, null, null, model);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

type Transaction = Prisma.TransactionClient;
type SelectionScope = "SHOP" | "PLATFORM";

async function readResolvedModel(
  transaction: Transaction,
  modelId: string,
  environment: CommerceEnvironment,
  shopId: string,
  selectionScope: SelectionScope,
): Promise<ResolvedCommerceModel> {
  const row = await transaction.commerceModelCatalogueEntry.findUnique({
    where: { id: modelId },
    include: { availability: true },
  });
  if (!row) throw new Error(UNAVAILABLE);

  const availability = CommerceModelAvailabilitySchema.parse({
    id: row.availability.id,
    scope: row.availability.scope,
    shopId: row.availability.shopId,
    enabled: row.availability.enabled,
    editVersion: row.availability.editVersion,
  });
  const entry = CommerceModelCatalogueEntrySchema.parse({
    id: row.id,
    availabilityId: row.availabilityId,
    provider: row.provider,
    providerModelId: row.providerModelId,
    displayName: row.displayName,
    description: row.description,
    configurationSchemaVersion: row.configurationSchemaVersion,
    configuration: row.configuration,
    enabled: row.enabled,
    editVersion: row.editVersion,
  });
  if (!entry.enabled || !availability.enabled) throw new Error(UNAVAILABLE);

  const platformAvailable =
    availability.scope === "PLATFORM" && availability.shopId === null;
  const ownShopAvailable =
    availability.scope === "SHOP" && availability.shopId === shopId;
  if (
    !platformAvailable &&
    !(selectionScope === "SHOP" && ownShopAvailable)
  )
    throw new Error(UNAVAILABLE);

  return ResolvedCommerceModelSchema.parse({
    environment,
    sourceScope: availability.scope,
    sourceShopId: availability.shopId,
    catalogueEntryId: entry.id,
    provider: entry.provider,
    providerModelId: entry.providerModelId,
    configurationSchemaVersion: entry.configurationSchemaVersion,
    configuration: entry.configuration,
  });
}

function result(
  selectionSource: CommerceModelSelectionSource,
  selectionShopId: string | null,
  merchantPricingPlanId: string | null,
  shopifyPlanHandle: string | null,
  model: ResolvedCommerceModel,
): ResolvedProductionCommerceModel {
  return {
    selectionSource: CommerceModelSelectionSourceSchema.parse(selectionSource),
    selectionShopId,
    merchantPricingPlanId,
    shopifyPlanHandle,
    model,
  };
}
