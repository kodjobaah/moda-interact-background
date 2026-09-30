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
  activationModeEligible: boolean;
  merchantEnabled: boolean;
  globallySupported: boolean;
  sourceTypeAllowed: boolean;
  withinSourceAllowance: boolean;
  eligible: boolean;
}

type EntitlementDatabase = Pick<PrismaClient, "subscription" | "merchantKnowledgeSource">;

interface CurrentEntitlementResolution {
  entitlement: MerchantKnowledgeEntitlement | null;
  activationModeEligible: boolean;
  merchantEnabled: boolean;
}

export class MerchantKnowledgeEntitlementService {
  constructor(private readonly database: EntitlementDatabase = prisma) {}

  async resolveCurrentEntitlement(
    shopId: string,
  ): Promise<MerchantKnowledgeEntitlement | null> {
    return (await this.resolveCurrentEntitlementAndActivation(shopId)).entitlement;
  }

  private async resolveCurrentEntitlementAndActivation(
    shopId: string,
  ): Promise<CurrentEntitlementResolution> {
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
              select: {
                configuration: true,
                feature: {
                  select: {
                    activationMode: true,
                    shopPreferences: {
                      where: { shopId },
                      select: { enabled: true },
                    },
                  },
                },
              },
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
      return {
        entitlement: null,
        activationModeEligible: false,
        merchantEnabled: false,
      };
    }

    const feature = subscription.plan.features[0];
    if (!feature) {
      return {
        entitlement: null,
        activationModeEligible: false,
        merchantEnabled: false,
      };
    }

    const configuration = MerchantKnowledgeFeatureConfigurationSchema.parse(
      feature.configuration,
    );

    return {
      entitlement: {
        shopId,
        billingPlanId: subscription.planId,
        maxKnowledgeSources: configuration.maxKnowledgeSources,
        maxContentUnitsPerSource: configuration.maxContentUnitsPerSource,
        allowedSourceTypes: configuration.allowedSourceTypes,
      },
      activationModeEligible: feature.feature.activationMode === "MERCHANT_OPT_IN",
      merchantEnabled: feature.feature.shopPreferences[0]?.enabled === true,
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
        activationModeEligible: false,
        merchantEnabled: false,
        globallySupported: false,
        sourceTypeAllowed: false,
        withinSourceAllowance: false,
        eligible: false,
      };
    }

    const currentEntitlement = await this.resolveCurrentEntitlementAndActivation(source.shopId);
    const { entitlement, activationModeEligible, merchantEnabled } = currentEntitlement;
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
    if (
      entitlement
      && activationModeEligible
      && merchantEnabled
      && globallySupported
      && sourceTypeAllowed
    ) {
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
      activationModeEligible,
      merchantEnabled,
      globallySupported,
      sourceTypeAllowed,
      withinSourceAllowance,
      eligible: entitlement !== null
        && activationModeEligible
        && merchantEnabled
        && globallySupported
        && sourceTypeAllowed
        && withinSourceAllowance,
    };
  }
}

export const merchantKnowledgeEntitlementService =
  new MerchantKnowledgeEntitlementService();