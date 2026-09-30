import { SubscriptionProjectionStatus, type PrismaClient } from "@prisma/client";
import {
  MerchantKnowledgeFeatureConfigurationSchema,
  type MerchantKnowledgeDataFormatKey,
  type MerchantKnowledgePurposeKey,
} from "@modainteract/moda-interact-shared/merchant-knowledge";

import prisma from "../lib/db.js";

export interface MerchantKnowledgeEntitlement {
  shopId: string;
  billingPlanId: string;
  maxKnowledgeSources: number;
  maxContentUnitsPerSource: number;
  allowedSourceTypes: ReadonlyArray<{
    purposeKey: MerchantKnowledgePurposeKey;
    dataFormatKey: MerchantKnowledgeDataFormatKey;
  }>;
}

export interface MerchantKnowledgeSourceEligibility {
  entitlement: MerchantKnowledgeEntitlement | null;
  globallySupported: boolean;
  sourceTypeAllowed: boolean;
  withinSourceAllowance: boolean;
  eligible: boolean;
}

type EntitlementDatabase = Pick<PrismaClient, "subscription" | "merchantKnowledgeSource">;

export class MerchantKnowledgeEntitlementService {
  constructor(private readonly database: EntitlementDatabase = prisma) {}

  async resolveCurrentEntitlement(
    shopId: string,
  ): Promise<MerchantKnowledgeEntitlement | null> {
    const subscription = await this.database.subscription.findUnique({
      where: { shopId },
      select: {
        planId: true,
        status: true,
        plan: {
          select: {
            features: {
              where: {
                enabled: true,
                feature: { is: { key: "merchant_knowledge", active: true } },
              },
              select: { configuration: true },
            },
          },
        },
      },
    });

    if (
      !subscription
      || !subscription.planId
      || !subscription.plan
      || (subscription.status !== SubscriptionProjectionStatus.ACTIVE
        && subscription.status !== SubscriptionProjectionStatus.TRIALING)
    ) {
      return null;
    }

    const feature = subscription.plan.features[0];
    if (!feature) return null;

    const configuration = MerchantKnowledgeFeatureConfigurationSchema.parse(
      feature.configuration,
    );

    return {
      shopId,
      billingPlanId: subscription.planId,
      maxKnowledgeSources: configuration.maxKnowledgeSources,
      maxContentUnitsPerSource: configuration.maxContentUnitsPerSource,
      allowedSourceTypes: configuration.allowedSourceTypes,
    };
  }

  async resolveSourceEligibility(
    sourceId: string,
  ): Promise<MerchantKnowledgeSourceEligibility> {
    const source = await this.database.merchantKnowledgeSource.findUnique({
      where: { id: sourceId },
      select: {
        id: true,
        shopId: true,
        purpose: { select: { key: true, active: true } },
        dataFormat: { select: { key: true, active: true } },
        purposeDataFormat: { select: { purposeId: true, dataFormatId: true } },
      },
    });

    if (!source) {
      return {
        entitlement: null,
        globallySupported: false,
        sourceTypeAllowed: false,
        withinSourceAllowance: false,
        eligible: false,
      };
    }

    const entitlement = await this.resolveCurrentEntitlement(source.shopId);
    const globallySupported = Boolean(
      source.purpose.active && source.dataFormat.active && source.purposeDataFormat,
    );
    const sourceTypeAllowed = Boolean(
      entitlement?.allowedSourceTypes.some(
        ({ purposeKey, dataFormatKey }) =>
          purposeKey === source.purpose.key && dataFormatKey === source.dataFormat.key,
      ),
    );

    let withinSourceAllowance = false;
    if (entitlement && globallySupported && sourceTypeAllowed) {
      const candidates = await this.database.merchantKnowledgeSource.findMany({
        where: {
          shopId: source.shopId,
          OR: entitlement.allowedSourceTypes.map(({ purposeKey, dataFormatKey }) => ({
            purpose: { is: { key: purposeKey, active: true } },
            dataFormat: { is: { key: dataFormatKey, active: true } },
          })),
        },
        select: { id: true },
        orderBy: [{ position: "asc" }, { id: "asc" }],
      });
      const sourceIndex = candidates.findIndex(({ id }) => id === source.id);
      withinSourceAllowance = sourceIndex >= 0
        && sourceIndex < entitlement.maxKnowledgeSources;
    }

    return {
      entitlement,
      globallySupported,
      sourceTypeAllowed,
      withinSourceAllowance,
      eligible: entitlement !== null
        && globallySupported
        && sourceTypeAllowed
        && withinSourceAllowance,
    };
  }
}

export const merchantKnowledgeEntitlementService =
  new MerchantKnowledgeEntitlementService();