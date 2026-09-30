import { SubscriptionProjectionStatus, type PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MerchantKnowledgeEntitlementService } from "../../../src/services/merchant-knowledge-entitlement.service.js";

const configuration = {
  schemaVersion: 1,
  maxKnowledgeSources: 2,
  maxContentUnitsPerSource: 8_000,
  allowedSourceTypes: [
    { purposeKey: "PRODUCT_INFORMATION", dataFormatKey: "WEB_PAGE" },
    { purposeKey: "FAQ", dataFormatKey: "CSV" },
  ],
};

function createHarness() {
  const subscriptionFindUnique = vi.fn();
  const sourceFindUnique = vi.fn();
  const sourceFindMany = vi.fn();
  const database = {
    subscription: { findUnique: subscriptionFindUnique },
    merchantKnowledgeSource: {
      findUnique: sourceFindUnique,
      findMany: sourceFindMany,
    },
  } as unknown as PrismaClient;
  return {
    service: new MerchantKnowledgeEntitlementService(database),
    subscriptionFindUnique,
    sourceFindUnique,
    sourceFindMany,
  };
}

describe("MerchantKnowledgeEntitlementService", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  it("resolves entitlement from the active current plan, ignoring any pending next plan", async () => {
    harness.subscriptionFindUnique.mockResolvedValue({
      status: SubscriptionProjectionStatus.ACTIVE,
      planId: "current-plan",
      pendingPlanId: "pending-plan",
      plan: {
        features: [{ configuration }],
      },
    });

    await expect(harness.service.resolveCurrentEntitlement("shop-1")).resolves.toEqual({
      shopId: "shop-1",
      billingPlanId: "current-plan",
      maxKnowledgeSources: 2,
      maxContentUnitsPerSource: 8_000,
      allowedSourceTypes: configuration.allowedSourceTypes,
    });
    expect(harness.subscriptionFindUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { shopId: "shop-1" },
      select: expect.not.objectContaining({ pendingPlanId: true }),
    }));
  });

  it.each([
    { status: SubscriptionProjectionStatus.NO_CONTRACT, planId: "plan-1", plan: { features: [{ configuration }] } },
    { status: SubscriptionProjectionStatus.ACTIVE, planId: null, plan: null },
    null,
  ])("returns no entitlement without a qualifying current subscription", async (subscription) => {
    harness.subscriptionFindUnique.mockResolvedValue(subscription);

    await expect(harness.service.resolveCurrentEntitlement("shop-1")).resolves.toBeNull();
  });

  it("fails closed when the current feature configuration is malformed", async () => {
    harness.subscriptionFindUnique.mockResolvedValue({
      status: SubscriptionProjectionStatus.TRIALING,
      planId: "current-plan",
      plan: { features: [{ configuration: { maxKnowledgeSources: 100 } }] },
    });

    await expect(harness.service.resolveCurrentEntitlement("shop-1")).rejects.toThrow();
  });

  it("requires an active globally supported pair and counts only currently allowed source types", async () => {
    harness.sourceFindUnique.mockResolvedValue({
      id: "source-2",
      shopId: "shop-1",
      purpose: { key: "PRODUCT_INFORMATION", active: true },
      dataFormat: { key: "WEB_PAGE", active: true },
      purposeDataFormat: { purposeId: "purpose-1", dataFormatId: "format-1" },
    });
    harness.subscriptionFindUnique.mockResolvedValue({
      status: SubscriptionProjectionStatus.ACTIVE,
      planId: "current-plan",
      plan: { features: [{ configuration }] },
    });
    harness.sourceFindMany.mockResolvedValue([{ id: "source-1" }, { id: "source-2" }]);

    await expect(harness.service.resolveSourceEligibility("source-2")).resolves.toMatchObject({
      globallySupported: true,
      sourceTypeAllowed: true,
      withinSourceAllowance: true,
      eligible: true,
    });
    expect(harness.sourceFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [
          { purpose: { is: { key: "PRODUCT_INFORMATION", active: true } }, dataFormat: { is: { key: "WEB_PAGE", active: true } } },
          { purpose: { is: { key: "FAQ", active: true } }, dataFormat: { is: { key: "CSV", active: true } } },
        ],
      }),
      orderBy: [{ position: "asc" }, { id: "asc" }],
    }));
  });

  it("does not count a disallowed or inactive source against the allowance", async () => {
    harness.sourceFindUnique.mockResolvedValue({
      id: "source-3",
      shopId: "shop-1",
      purpose: { key: "PRODUCT_INFORMATION", active: false },
      dataFormat: { key: "WEB_PAGE", active: true },
      purposeDataFormat: { purposeId: "purpose-1", dataFormatId: "format-1" },
    });
    harness.subscriptionFindUnique.mockResolvedValue({
      status: SubscriptionProjectionStatus.ACTIVE,
      planId: "current-plan",
      plan: { features: [{ configuration }] },
    });

    await expect(harness.service.resolveSourceEligibility("source-3")).resolves.toMatchObject({
      globallySupported: false,
      sourceTypeAllowed: true,
      withinSourceAllowance: false,
      eligible: false,
    });
    expect(harness.sourceFindMany).not.toHaveBeenCalled();
  });
});