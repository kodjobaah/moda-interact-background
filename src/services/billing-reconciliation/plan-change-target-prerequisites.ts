import { BillingPlanKind } from "@prisma/client";

import type { PartnerSubscription } from "../../providers/shopify-partner-billing.provider.js";
import type { ShopifyPlanChangePlan } from "../shopify-plan-change-transition.service.js";

export type PlanChangeTargetFailureCode =
  | "MISSING_BILLING_CYCLE"
  | "MISSING_USAGE_METER"
  | "INVALID_INCLUDED_ALLOWANCE";

export function planChangeTargetPrerequisiteFailure(
  provider: PartnerSubscription,
  plan: ShopifyPlanChangePlan,
): PlanChangeTargetFailureCode | null {
  const requiresExactCycle = plan.kind === BillingPlanKind.PAID_METERED
    || (plan.kind === BillingPlanKind.FREE && plan.recoveryCreditPackEnabled === true);
  if (
    requiresExactCycle
    && (!provider.currentPeriodStart
      || !provider.currentPeriodEnd
      || provider.currentPeriodStart >= provider.currentPeriodEnd)
  ) {
    return "MISSING_BILLING_CYCLE";
  }
  if (
    plan.kind === BillingPlanKind.PAID_METERED
    && (!Number.isSafeInteger(plan.includedRecoveryConversationAllowance)
      || (plan.includedRecoveryConversationAllowance ?? -1) < 0)
  ) {
    return "INVALID_INCLUDED_ALLOWANCE";
  }
  if (
    plan.kind === BillingPlanKind.PAID_METERED
    && (!plan.shopifyUsageEventHandle
      || !provider.usageEventHandles.includes(plan.shopifyUsageEventHandle))
  ) {
    return "MISSING_USAGE_METER";
  }
  if (
    plan.recoveryCreditPackEnabled
    && (!plan.shopifyRecoveryCreditPackEventHandle
      || !provider.usageEventHandles.includes(plan.shopifyRecoveryCreditPackEventHandle))
  ) {
    return "MISSING_USAGE_METER";
  }
  return null;
}
