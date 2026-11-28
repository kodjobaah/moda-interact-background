import { SubscriptionProjectionStatus } from "@prisma/client";

import type { PartnerSubscription } from "../../providers/shopify-partner-billing.provider.js";
import type { CurrentBillingPeriodPlanProjection } from "../current-billing-period-projection.service.js";

export type ObservedBillingPlan = CurrentBillingPeriodPlanProjection & {
  active: boolean;
  shopifyRecoveryCreditPackEventHandle: string | null;
  recoveryCreditPackEnabled: boolean;
};

export type ObservedPlanProjection = {
  planUsable: boolean;
  executableMapped: boolean;
  status: SubscriptionProjectionStatus;
  syncErrorCode: "UNMAPPED_PLAN_HANDLE" | null;
};

export function classifyObservedPlanProjection(
  provider: PartnerSubscription,
  plan: ObservedBillingPlan | null,
): ObservedPlanProjection {
  const planUsable = Boolean(plan?.active);
  const status = !planUsable
    ? SubscriptionProjectionStatus.UNMAPPED
    : provider.status === "TRIALING"
      ? SubscriptionProjectionStatus.TRIALING
      : SubscriptionProjectionStatus.ACTIVE;

  return {
    planUsable,
    executableMapped:
      planUsable &&
      plan !== null &&
      (status === SubscriptionProjectionStatus.ACTIVE ||
        status === SubscriptionProjectionStatus.TRIALING),
    status,
    syncErrorCode: plan && !plan.active ? "UNMAPPED_PLAN_HANDLE" : null,
  };
}

export function hasValidProviderBillingCycle(
  provider: PartnerSubscription,
): provider is PartnerSubscription & {
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
} {
  return (
    provider.currentPeriodStart !== null &&
    provider.currentPeriodEnd !== null &&
    provider.currentPeriodStart < provider.currentPeriodEnd
  );
}
