import { BillingPlanKind, SubscriptionProjectionStatus } from "@prisma/client";

import type { PartnerSubscription } from "../../providers/shopify-partner-billing.provider.js";
import type { CurrentBillingPeriodPlanProjection } from "../current-billing-period-projection.service.js";

export type ObservedBillingPlan = CurrentBillingPeriodPlanProjection & {
  active: boolean;
  shopifyUsageEventHandle: string | null;
  shopifyRecoveryCreditPackEventHandle: string | null;
  recoveryCreditPackEnabled: boolean;
};

export type ObservedPlanProjection = {
  planUsable: boolean;
  meterUsable: boolean;
  executableMapped: boolean;
  status: SubscriptionProjectionStatus;
  syncErrorCode: "UNMAPPED_PLAN_HANDLE" | "MISSING_USAGE_METER" | null;
};

export function classifyObservedPlanProjection(
  provider: PartnerSubscription,
  plan: ObservedBillingPlan | null,
): ObservedPlanProjection {
  const planUsable = Boolean(plan?.active);
  const meterUsable = plan?.kind !== BillingPlanKind.PAID_METERED
    || Boolean(plan?.shopifyUsageEventHandle && provider.usageEventHandles.includes(plan.shopifyUsageEventHandle));
  const status = !planUsable
    ? SubscriptionProjectionStatus.UNMAPPED
    : !meterUsable
      ? SubscriptionProjectionStatus.SYNC_ERROR
      : provider.status === "TRIALING"
        ? SubscriptionProjectionStatus.TRIALING
        : SubscriptionProjectionStatus.ACTIVE;
  const syncErrorCode = status === SubscriptionProjectionStatus.UNMAPPED
    ? "UNMAPPED_PLAN_HANDLE"
    : status === SubscriptionProjectionStatus.SYNC_ERROR
      ? "MISSING_USAGE_METER"
      : null;

  return {
    planUsable,
    meterUsable,
    executableMapped: planUsable
      && meterUsable
      && plan !== null
      && (status === SubscriptionProjectionStatus.ACTIVE || status === SubscriptionProjectionStatus.TRIALING),
    status,
    syncErrorCode,
  };
}

export function hasValidProviderBillingCycle(
  provider: PartnerSubscription,
): provider is PartnerSubscription & { currentPeriodStart: Date; currentPeriodEnd: Date } {
  return provider.currentPeriodStart !== null
    && provider.currentPeriodEnd !== null
    && provider.currentPeriodStart < provider.currentPeriodEnd;
}
