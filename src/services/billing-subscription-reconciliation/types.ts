import type { BillingPlanKind } from "@prisma/client";

export type InitialActivationPlan = {
  id: string;
  active: boolean;
  name: string;
  kind: BillingPlanKind;
  shopifyPlanHandle: string;
  shopifyUsageEventHandle: string | null;
  includedRecoveryConversationAllowance: number | null;
};

export type OtherCurrentPlan = {
  id: string;
  active: boolean;
  name: string;
  kind: BillingPlanKind;
  shopifyPlanHandle: string;
  shopifyUsageEventHandle: string | null;
  includedRecoveryConversationAllowance: number | null;
};