import type { SubscriptionProjectionStatus } from "@prisma/client";

import type { PartnerSubscription } from "../../providers/shopify-partner-billing.provider.js";
import type { SamePlanRolloverPlan } from "../same-plan-billing-period-rollover.service.js";

export type SamePlanExistingSubscription = {
  id: string;
  status: SubscriptionProjectionStatus;
  planId: string | null;
  pendingPlanId: string | null;
  pendingShopifyPlanHandle: string | null;
  pendingEffectiveAt: Date | null;
  billingPeriodId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  nextReconcileAt: Date | null;
};

export type SamePlanReconciliationInput = {
  shopId: string;
  provider: PartnerSubscription;
  plan: SamePlanRolloverPlan;
  existing: SamePlanExistingSubscription;
  now: Date;
};

export type SamePlanProjection = {
  billingPeriodId: string | null;
  packMeterHandle: string | null;
};
