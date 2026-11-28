import { describe, expect, it } from "vitest";

import {
  currentCycleEnd,
  currentCycleStart,
  currentPlan,
  establishedPlanObservationHarness as harness,
  existing,
  freePrerequisiteCases,
  now,
  paidPrerequisiteCases,
  provider,
  targetPlan,
} from "./established-plan-observation.test-support.js";

describe("EstablishedPlanObservationService", () => {
  it("returns not-applicable when the provider still maps to the locally current plan", async () => {
    const test = harness();

    const result = await test.service.reconcile({
      shopId: "shop-1",
      provider: { ...provider, planHandle: currentPlan.shopifyPlanHandle },
      observedPlan: currentPlan,
      existing,
      now,
    });

    expect(result).toEqual({ kind: "not-applicable" });
    expect(test.database.billingPlan.findUnique).not.toHaveBeenCalled();
    expect(test.transaction.subscription.updateMany).not.toHaveBeenCalled();
  });

  it("persists provider usage-event mapping when Shopify still reports the current established plan", async () => {
    const test = harness();
    const result = await test.service.reconcile({
      shopId: "shop-1",
      provider: { ...provider, planHandle: currentPlan.shopifyPlanHandle },
      observedPlan: targetPlan,
      existing,
      now,
    });

    expect(result.kind).toBe("handled");
    expect(test.transaction.subscription.update).toHaveBeenCalledWith({
      where: { id: existing.id },
      data: { unmappedShopifyUsageEventHandles: [] },
    });
  });

  it("fails closed when the expected target appears inside the unchanged billing cycle", async () => {
    const test = harness();

    const result = await test.service.reconcile({
      shopId: "shop-1",
      provider: {
        ...provider,
        currentPeriodStart: currentCycleStart,
        currentPeriodEnd: currentCycleEnd,
      },
      observedPlan: targetPlan,
      existing,
      now,
    });

    expect(result).toEqual({
      kind: "handled",
      billingPeriodId: "period-old",
      packMeterHandle: null,
    });
    expect(test.transaction.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SYNC_ERROR",
          lastSyncErrorCode: "UNEXPECTED_IMMEDIATE_PLAN_CHANGE",
          nextReconcileAt: new Date("2026-09-12T12:01:00.000Z"),
        }),
      }),
    );
    expect(test.scheduler.enqueue).toHaveBeenCalledWith(
      "shop-1",
      "subscription-1",
      new Date("2026-09-12T12:01:00.000Z"),
      now,
    );
    expect(test.transition.transition).not.toHaveBeenCalled();
  });

  it("keeps the established projection unchanged when the expected target appears before its boundary", async () => {
    const test = harness();

    const result = await test.service.reconcile({
      shopId: "shop-1",
      provider,
      observedPlan: targetPlan,
      existing: {
        ...existing,
        pendingEffectiveAt: new Date("2026-10-01T00:00:00.000Z"),
      },
      now,
    });

    expect(result).toEqual({
      kind: "handled",
      billingPeriodId: "period-old",
      packMeterHandle: null,
    });
    expect(test.transaction.subscription.updateMany).not.toHaveBeenCalled();
    expect(test.scheduler.enqueue).not.toHaveBeenCalled();
    expect(test.transition.transition).not.toHaveBeenCalled();
  });

  it.each([
    ["missing cycle", { currentPeriodStart: null, currentPeriodEnd: null }],
    [
      "invalid cycle",
      {
        currentPeriodStart: currentCycleEnd,
        currentPeriodEnd: currentCycleEnd,
      },
    ],
  ] as const)(
    "fails closed for the expected target with %s",
    async (_label, cycle) => {
      const test = harness();

      await test.service.reconcile({
        shopId: "shop-1",
        provider: { ...provider, ...cycle },
        observedPlan: targetPlan,
        existing,
        now,
      });

      expect(test.transaction.subscription.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "SYNC_ERROR",
            lastSyncErrorCode: "MISSING_BILLING_CYCLE",
          }),
        }),
      );
      expect(test.scheduler.enqueue).toHaveBeenCalledOnce();
      expect(test.transition.transition).not.toHaveBeenCalled();
    },
  );

  it.each(paidPrerequisiteCases)(
    "fails closed for target prerequisite: %s",
    async (_label, expectedCode, mutation) => {
      const test = harness();
      const { providerUsageEventHandles, ...planMutation } =
        mutation as typeof mutation & { providerUsageEventHandles?: string[] };

      await test.service.reconcile({
        shopId: "shop-1",
        provider: {
          ...provider,
          usageEventHandles:
            providerUsageEventHandles ?? provider.usageEventHandles,
        },
        observedPlan: { ...targetPlan, ...planMutation },
        existing,
        now,
      });

      expect(test.transaction.subscription.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "SYNC_ERROR",
            lastSyncErrorCode: expectedCode,
          }),
        }),
      );
      expect(test.scheduler.enqueue).toHaveBeenCalledOnce();
      expect(test.transition.transition).not.toHaveBeenCalled();
    },
  );

  it.each(freePrerequisiteCases)(
    "fails closed for Free target prerequisite: %s",
    async (_label, mutation) => {
      const test = harness();
      const freePlan = {
        ...targetPlan,
        kind: "FREE" as const,
        shopifyUsageEventHandle: null,
        recoveryCreditPackEnabled: true,
        includedRecoveryConversationAllowance: null,
        shopifyRecoveryCreditPackEventHandle:
          mutation.shopifyRecoveryCreditPackEventHandle,
      };

      await test.service.reconcile({
        shopId: "shop-1",
        provider: {
          ...provider,
          usageEventHandles: mutation.providerUsageEventHandles,
        },
        observedPlan: freePlan,
        existing,
        now,
      });

      expect(test.transaction.subscription.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "SYNC_ERROR",
            lastSyncErrorCode: "MISSING_USAGE_METER",
          }),
        }),
      );
      expect(test.transition.transition).not.toHaveBeenCalled();
    },
  );

  it("applies the canonical transition and schedules Paid recovery-capacity resume", async () => {
    const test = harness();
    const nextReconcileAt = new Date("2026-10-01T00:01:00.000Z");
    test.transition.transition.mockResolvedValue({
      kind: "transitioned",
      billingPeriodId: "period-new",
      nextReconcileAt,
      planKind: "PAID_METERED",
    });

    const result = await test.service.reconcile({
      shopId: "shop-1",
      provider,
      observedPlan: targetPlan,
      existing,
      now,
    });

    expect(result).toEqual({
      kind: "handled",
      billingPeriodId: "period-new",
      packMeterHandle: "pack-new",
    });
    expect(test.transition.transition).toHaveBeenCalledWith({
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      provider,
      plan: targetPlan,
      expectedCurrentPlanId: "plan-current",
      now,
    });
    expect(test.scheduler.enqueue).toHaveBeenCalledWith(
      "shop-1",
      "subscription-1",
      nextReconcileAt,
      now,
    );
    expect(test.capacityResume.schedule).toHaveBeenCalledWith({
      shopId: "shop-1",
      trigger: "plan-change",
    });
  });

  it("warns but keeps a successful Paid transition when capacity-resume publication fails", async () => {
    const test = harness();
    test.capacityResume.schedule.mockRejectedValue(
      new Error("Redis unavailable"),
    );

    await expect(
      test.service.reconcile({
        shopId: "shop-1",
        provider,
        observedPlan: targetPlan,
        existing,
        now,
      }),
    ).resolves.toMatchObject({
      kind: "handled",
      billingPeriodId: "period-new",
    });

    expect(test.logger.warn).toHaveBeenCalledWith(
      "billing.recovery_capacity_resume.enqueue_failed",
      expect.objectContaining({
        shopId: "shop-1",
        errorMessage: "Redis unavailable",
      }),
    );
  });

  it("does not schedule capacity resume after a successful Free transition", async () => {
    const test = harness();
    const freePlan = {
      ...targetPlan,
      kind: "FREE" as const,
      shopifyUsageEventHandle: null,
      shopifyRecoveryCreditPackEventHandle: null,
      recoveryCreditPackEnabled: false,
      includedRecoveryConversationAllowance: null,
    };
    test.transition.transition.mockResolvedValue({
      kind: "transitioned",
      billingPeriodId: null,
      nextReconcileAt: null,
      planKind: "FREE",
    });

    const result = await test.service.reconcile({
      shopId: "shop-1",
      provider: { ...provider, usageEventHandles: [] },
      observedPlan: freePlan,
      existing,
      now,
    });

    expect(result).toEqual({
      kind: "handled",
      billingPeriodId: null,
      packMeterHandle: null,
    });
    expect(test.capacityResume.schedule).not.toHaveBeenCalled();
  });

  it("fails closed when the canonical target transition reports not-applicable", async () => {
    const test = harness();
    test.transition.transition.mockResolvedValue({ kind: "not-applicable" });

    const result = await test.service.reconcile({
      shopId: "shop-1",
      provider,
      observedPlan: targetPlan,
      existing,
      now,
    });

    expect(result).toEqual({
      kind: "handled",
      billingPeriodId: "period-old",
      packMeterHandle: null,
    });
    expect(test.transaction.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SYNC_ERROR",
          lastSyncErrorCode: "UNEXPECTED_IMMEDIATE_PLAN_CHANGE",
        }),
      }),
    );
    expect(test.scheduler.enqueue).toHaveBeenCalledOnce();
  });

  it("fails closed for a different mapped provider plan and records the observed handle", async () => {
    const test = harness();
    const thirdPlan = {
      ...targetPlan,
      id: "plan-third",
      shopifyPlanHandle: "pro-2028",
    };

    const result = await test.service.reconcile({
      shopId: "shop-1",
      provider: { ...provider, planHandle: "pro-2028" },
      observedPlan: thirdPlan,
      existing,
      now,
    });

    expect(result).toEqual({
      kind: "handled",
      billingPeriodId: "period-old",
      packMeterHandle: null,
    });
    expect(test.transaction.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SYNC_ERROR",
          observedShopifyPlanHandle: "pro-2028",
          lastSyncErrorCode: "UNEXPECTED_IMMEDIATE_PLAN_CHANGE",
        }),
      }),
    );
    expect(test.transition.transition).not.toHaveBeenCalled();
  });

  it("marks an unmapped provider plan without scheduling a retry", async () => {
    const test = harness();

    const result = await test.service.reconcile({
      shopId: "shop-1",
      provider: { ...provider, planHandle: "missing-plan" },
      observedPlan: null,
      existing,
      now,
    });

    expect(result.kind).toBe("handled");
    expect(test.transaction.subscription.update).toHaveBeenCalledWith({
      where: { id: "subscription-1" },
      data: expect.objectContaining({
        planId: null,
        status: "UNMAPPED",
        observedShopifyPlanHandle: "missing-plan",
        unmappedShopifyUsageEventHandles: expect.any(Array),
        nextReconcileAt: null,
        lastSyncedAt: now,
        lastSyncErrorCode: null,
        lastSyncErrorAt: null,
      }),
    });
    expect(test.scheduler.enqueue).not.toHaveBeenCalled();
  });
  it("closes the old open period atomically when an established pending target is unknown", async () => {
    const test = harness();
    test.transaction.billingPeriod.findUnique.mockResolvedValue({
      id: "period-old",
      subscriptionId: existing.id,
      status: "OPEN",
      planKindSnapshot: "PAID_METERED",
    });
    test.transaction.billingPeriodEntitlementCounter.findUnique
      .mockResolvedValueOnce({
        id: "counter-1",
        grantedQuantity: 8,
        committedQuantity: 4,
        reservedQuantity: 0,
        forfeitedQuantity: 0,
        version: 2,
      })
      .mockResolvedValueOnce({
        id: "counter-1",
        grantedQuantity: 8,
        committedQuantity: 4,
        reservedQuantity: 0,
        forfeitedQuantity: 4,
        version: 3,
      });
    const result = await test.service.reconcile({
      shopId: "shop-1",
      provider: { ...provider, planHandle: "unknown" },
      observedPlan: null,
      existing,
      now,
    });
    expect(result).toEqual({
      kind: "handled",
      billingPeriodId: null,
      packMeterHandle: null,
    });
    expect(test.transaction.billingPeriod.updateMany).toHaveBeenCalledOnce();
    expect(test.transaction.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          planId: null,
          billingPeriodId: null,
          currentPeriodStart: null,
          status: "UNMAPPED",
        }),
      }),
    );
  });
});
