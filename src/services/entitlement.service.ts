import type { EntitlementFeature, UsageMetric } from "../domain/types.js";
import {
  EffectiveBillingPolicyError,
  effectiveBillingPolicyResolver,
} from "./effective-billing-policy.service.js";

const featureMap: Record<
  EntitlementFeature,
  "CHECKOUT_RECOVERY" | "ORDER_SUPPORT" | "PRODUCT_SEARCH" | "AI_CONVERSATIONS"
> = {
  checkout_recovery: "CHECKOUT_RECOVERY",
  order_support: "ORDER_SUPPORT",
  product_search: "PRODUCT_SEARCH",
  ai_conversations: "AI_CONVERSATIONS",
};

export class EntitlementError extends Error {
  constructor(
    public readonly code:
      | "NO_ACTIVE_SUBSCRIPTION"
      | "FEATURE_NOT_AVAILABLE"
      | "USAGE_LIMIT_EXCEEDED",
    message: string,
  ) {
    super(message);
    this.name = "EntitlementError";
  }
}

class EntitlementService {
  async hasFeature(shopId: string, feature: EntitlementFeature): Promise<boolean> {
    try {
      const policy = await effectiveBillingPolicyResolver.resolve(shopId);
      return policy.features[featureMap[feature]] === true;
    } catch (error) {
      if (error instanceof EffectiveBillingPolicyError) return false;
      throw error;
    }
  }

  async assertFeature(shopId: string, feature: EntitlementFeature): Promise<void> {
    let policy;
    try {
      policy = await effectiveBillingPolicyResolver.resolve(shopId);
    } catch (error) {
      if (error instanceof EffectiveBillingPolicyError) {
        throw new EntitlementError(
          "NO_ACTIVE_SUBSCRIPTION",
          `Shop ${shopId} does not have an active subscription`,
        );
      }
      throw error;
    }

    if (!policy.features[featureMap[feature]]) {
      throw new EntitlementError(
        "FEATURE_NOT_AVAILABLE",
        `Feature '${feature}' is not available for shop ${shopId}`,
      );
    }
  }

  async getLimit(shopId: string, metric: UsageMetric): Promise<number | null> {
    const policy = await effectiveBillingPolicyResolver.resolve(shopId);
    return metric === "monthly_conversations" && policy.freeAllowance
      ? policy.freeAllowance.effective
      : null;
  }

  async assertUsageAvailable(
    shopId: string,
    metric: UsageMetric,
    quantity = 1,
  ): Promise<void> {
    const policy = await effectiveBillingPolicyResolver.resolve(shopId);
    if (metric !== "monthly_conversations" || !policy.freeAllowance) return;

    if (policy.freeAllowance.remaining < quantity) {
      throw new EntitlementError(
        "USAGE_LIMIT_EXCEEDED",
        `Usage limit '${metric}' has been exceeded for shop ${shopId}`,
      );
    }
  }
}

export const entitlementService = new EntitlementService();
