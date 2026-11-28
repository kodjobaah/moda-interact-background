import { describe, expect, it } from "vitest";

import { SubscriptionProjectionStatus } from "@prisma/client";
import { classifyObservedPlanProjection } from "../../../../src/services/billing-reconciliation/observed-plan-projection.js";

const provider = {
  planHandle: "paid-2026",
  usageEventHandles: ["provider-event"],
  status: "ACTIVE" as const,
};

const activePlan = {
  id: "plan-1",
  active: true,
  kind: "PAID_METERED" as const,
  shopifyPlanHandle: "paid-2026",
  shopifyUsageEventHandle: null,
  shopifyRecoveryCreditPackEventHandle: null,
  includedRecoveryConversationAllowance: 100,
};

describe("classifyObservedPlanProjection", () => {
  it("treats a missing local plan mapping as administrative UNMAPPED without a sync error", () => {
    expect(classifyObservedPlanProjection(provider as never, null)).toEqual({
      planUsable: false,
      executableMapped: false,
      status: SubscriptionProjectionStatus.UNMAPPED,
      syncErrorCode: null,
    });
  });

  it("preserves the existing inactive-plan diagnostic while removing reporting-handle validation", () => {
    expect(
      classifyObservedPlanProjection(
        provider as never,
        { ...activePlan, active: false } as never,
      ),
    ).toEqual({
      planUsable: false,
      executableMapped: false,
      status: SubscriptionProjectionStatus.UNMAPPED,
      syncErrorCode: "UNMAPPED_PLAN_HANDLE",
    });
  });

  it("accepts an active Paid plan even when its optional App Events reporting handle is absent", () => {
    expect(
      classifyObservedPlanProjection(provider as never, activePlan as never),
    ).toEqual({
      planUsable: true,
      executableMapped: true,
      status: SubscriptionProjectionStatus.ACTIVE,
      syncErrorCode: null,
    });
  });
});
