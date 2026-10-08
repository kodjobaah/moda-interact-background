import { describe, expect, it, vi } from "vitest";
import { createSubscriptionReconcilePayload } from "../../../../src/services/billing-subscription-reconciliation.service.js";
import { shopifyUsageEventPublisherService } from "../../../../src/services/shopify-usage-event-publisher.service.js";
import { now, pendingEffectiveAt, harness, establishedCurrentPlan, establishedProvider, establishedRow } from "./facade-test-fixtures.js";

describe("BillingSubscriptionReconciliationService", () => {
  it("refreshes pending provider state in one guarded update", async () => {
    const test = harness({
      row: establishedRow(),
      providerResult: { ...establishedProvider, planHandle: "paid-current", pendingPlanHandle: "paid-next", pendingEffectiveAt: new Date("2026-10-01T00:00:00.000Z") },
      plan: establishedCurrentPlan,
    });
    test.database.billingPlan.findUnique
      .mockResolvedValueOnce(establishedCurrentPlan)
      .mockResolvedValueOnce(establishedCurrentPlan)
      .mockResolvedValueOnce({ id: "plan-next", active: true });

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now));

    expect(test.database.subscription.updateMany).toHaveBeenCalledOnce();
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "subscription-1", planId: "plan-current", pendingPlanId: "plan-target", pendingShopifyPlanHandle: "paid-2026", pendingEffectiveAt }),
      data: expect.objectContaining({ pendingPlanId: "plan-next", pendingShopifyPlanHandle: "paid-next", pendingEffectiveAt: new Date("2026-10-01T00:00:00.000Z") }),
    }));
    expect(test.database.subscription.updateMany.mock.calls[0][0].data.nextReconcileAt).toEqual(new Date("2026-10-01T00:00:00.000Z"));
    expect(test.database.subscription.update).not.toHaveBeenCalled();
    expect(test.queue.add).toHaveBeenCalledOnce();
    expect(test.queue.add).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ expectedNextReconcileAt: "2026-10-01T00:00:00.000Z" }), expect.objectContaining({ jobId: expect.any(String) }));
  });

  it("clears a withdrawn established pending update atomically", async () => {
    const test = harness({
      row: establishedRow(),
      providerResult: { ...establishedProvider, planHandle: "paid-current", pendingPlanHandle: null, pendingEffectiveAt: null },
      plan: establishedCurrentPlan,
    });
    test.database.billingPlan.findUnique.mockResolvedValueOnce(establishedCurrentPlan);

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now));

    expect(test.database.subscription.updateMany).toHaveBeenCalledOnce();
    const call = test.database.subscription.updateMany.mock.calls[0][0];
    expect(call.data).toEqual(expect.objectContaining({ pendingPlanId: null, pendingShopifyPlanHandle: null, pendingEffectiveAt: null, nextReconcileAt: new Date("2026-09-30T23:55:00.000Z") }));
    for (const field of ["status", "planId", "billingPeriodId", "currentPeriodStart", "currentPeriodEnd"]) expect(call.data).not.toHaveProperty(field);
    expect(test.database.subscription.update).not.toHaveBeenCalled();
    expect(test.queue.add).toHaveBeenCalledOnce();
    expect(test.queue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ expectedNextReconcileAt: "2026-09-30T23:55:00.000Z" }),
      expect.objectContaining({ jobId: expect.any(String) }),
    );
  });

  it("projects pending update even when outgoing cancelAtEndOfCycle is false", async () => {
    const test = harness({
      row: establishedRow({ subscription: {
        ...establishedRow().subscription,
        pendingPlanId: null,
        pendingShopifyPlanHandle: null,
        pendingEffectiveAt: null,
        cancelAtPeriodEnd: false,
      } }),
      providerResult: { ...establishedProvider, planHandle: "paid-current", pendingPlanHandle: "paid-next", pendingEffectiveAt: new Date("2026-10-01T00:00:00.000Z"), currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"), cancelAtEndOfCycle: false, cancelAtPeriodEnd: false },
      plan: establishedCurrentPlan,
    });
    test.database.billingPlan.findUnique
      .mockResolvedValueOnce(establishedCurrentPlan)
      .mockResolvedValueOnce({ id: "plan-next", active: true });

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now));

    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ pendingShopifyPlanHandle: "paid-next", pendingPlanId: "plan-next", cancelAtPeriodEnd: false }),
    }));
    expect(test.queue.add).toHaveBeenCalledOnce();
  });

  it("uses the exact drain boundary for pending update before the drain window", async () => {
    const test = harness({
      row: establishedRow({ subscription: {
        ...establishedRow().subscription,
        pendingPlanId: null,
        pendingShopifyPlanHandle: null,
        pendingEffectiveAt: null,
        cancelAtPeriodEnd: false,
      } }),
      providerResult: {
        ...establishedProvider,
        planHandle: "paid-current",
        pendingPlanHandle: "paid-next",
        pendingEffectiveAt: new Date("2026-10-01T00:00:00.000Z"),
        currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
        cancelAtEndOfCycle: false,
        cancelAtPeriodEnd: false,
      },
      plan: establishedCurrentPlan,
    });
    test.database.billingPlan.findUnique
      .mockResolvedValueOnce(establishedCurrentPlan)
      .mockResolvedValueOnce({ id: "plan-next", active: true });
    const publishDue = vi.spyOn(shopifyUsageEventPublisherService, "publishDue").mockResolvedValue(undefined);

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now));

    expect(publishDue).not.toHaveBeenCalled();
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        pendingShopifyPlanHandle: "paid-next",
        pendingPlanId: "plan-next",
        pendingEffectiveAt: new Date("2026-10-01T00:00:00.000Z"),
        nextReconcileAt: new Date("2026-09-30T23:55:00.000Z"),
      }),
    }));
    expect(test.queue.add).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ expectedNextReconcileAt: "2026-09-30T23:55:00.000Z" }), expect.anything());
    publishDue.mockRestore();
  });

  it("uses the exact period boundary for pending update inside the drain window", async () => {
    const insideDrain = new Date("2026-09-30T23:57:00.000Z");
    const test = harness({
      nowValue: insideDrain,
      row: establishedRow({ subscription: {
        ...establishedRow().subscription,
        pendingPlanId: null,
        pendingShopifyPlanHandle: null,
        pendingEffectiveAt: null,
        cancelAtPeriodEnd: false,
        nextReconcileAt: insideDrain,
      } }),
      providerResult: {
        ...establishedProvider,
        planHandle: "paid-current",
        pendingPlanHandle: "paid-next",
        pendingEffectiveAt: new Date("2026-10-01T00:00:00.000Z"),
        currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
        cancelAtEndOfCycle: false,
        cancelAtPeriodEnd: false,
      },
      plan: establishedCurrentPlan,
    });
    test.database.billingPlan.findUnique
      .mockResolvedValueOnce(establishedCurrentPlan)
      .mockResolvedValueOnce({ id: "plan-next", active: true });
    const publishDue = vi.spyOn(shopifyUsageEventPublisherService, "publishDue").mockResolvedValue(undefined);

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", insideDrain));

    expect(publishDue).toHaveBeenCalledOnce();
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        pendingEffectiveAt: new Date("2026-10-01T00:00:00.000Z"),
        nextReconcileAt: new Date("2026-10-01T00:00:00.000Z"),
      }),
    }));
    expect(test.queue.add).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ expectedNextReconcileAt: "2026-10-01T00:00:00.000Z" }), expect.anything());
    publishDue.mockRestore();
  });

  it("clears only PRE_CLOSE_USAGE_FLUSH_FAILED after a successful exact-cycle drain retry", async () => {
    const insideDrain = new Date("2026-09-30T23:57:00.000Z");
    const test = harness({
      nowValue: insideDrain,
      row: establishedRow({ subscription: {
        ...establishedRow().subscription,
        pendingPlanId: null,
        pendingShopifyPlanHandle: null,
        pendingEffectiveAt: null,
        cancelAtPeriodEnd: false,
        nextReconcileAt: insideDrain,
        lastSyncErrorCode: "PRE_CLOSE_USAGE_FLUSH_FAILED",
      } }),
      providerResult: {
        ...establishedProvider,
        planHandle: "paid-current",
        pendingPlanHandle: null,
        pendingEffectiveAt: null,
        currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
        cancelAtEndOfCycle: true,
        cancelAtPeriodEnd: true,
      },
      plan: establishedCurrentPlan,
    });
    test.database.billingPlan.findUnique.mockResolvedValueOnce(establishedCurrentPlan);
    const publishDue = vi.spyOn(shopifyUsageEventPublisherService, "publishDue").mockResolvedValue(undefined);

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", insideDrain));

    expect(publishDue).toHaveBeenCalledOnce();
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        cancelAtPeriodEnd: true,
        nextReconcileAt: new Date("2026-10-01T00:00:00.000Z"),
        lastSyncErrorCode: null,
        lastSyncErrorAt: null,
      }),
    }));
    publishDue.mockRestore();
  });

  it("preserves unrelated sync errors after a successful exact-cycle drain retry", async () => {
    const insideDrain = new Date("2026-09-30T23:57:00.000Z");
    const test = harness({
      nowValue: insideDrain,
      row: establishedRow({ subscription: {
        ...establishedRow().subscription,
        pendingPlanId: null,
        pendingShopifyPlanHandle: null,
        pendingEffectiveAt: null,
        cancelAtPeriodEnd: false,
        nextReconcileAt: insideDrain,
        lastSyncErrorCode: "MISSING_USAGE_METER",
      } }),
      providerResult: {
        ...establishedProvider,
        planHandle: "paid-current",
        pendingPlanHandle: null,
        pendingEffectiveAt: null,
        currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
        cancelAtEndOfCycle: true,
        cancelAtPeriodEnd: true,
      },
      plan: establishedCurrentPlan,
    });
    test.database.billingPlan.findUnique.mockResolvedValueOnce(establishedCurrentPlan);
    const publishDue = vi.spyOn(shopifyUsageEventPublisherService, "publishDue").mockResolvedValue(undefined);

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", insideDrain));

    expect(test.database.subscription.updateMany.mock.calls[0][0].data).not.toHaveProperty("lastSyncErrorCode");
    publishDue.mockRestore();
  });

  it("persists pending provider truth when pre-close drain fails", async () => {
    const insideDrain = new Date("2026-09-30T23:57:00.000Z");
    const test = harness({
      nowValue: insideDrain,
      row: establishedRow({ subscription: { ...establishedRow().subscription, pendingPlanId: null, pendingShopifyPlanHandle: null, pendingEffectiveAt: null, cancelAtPeriodEnd: false, nextReconcileAt: insideDrain } }),
      providerResult: { ...establishedProvider, planHandle: "paid-current", pendingPlanHandle: "paid-next", pendingEffectiveAt: new Date("2026-10-01T00:00:00.000Z"), currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"), cancelAtEndOfCycle: true, cancelAtPeriodEnd: true },
      plan: establishedCurrentPlan,
    });
    test.database.billingPlan.findUnique.mockResolvedValueOnce(establishedCurrentPlan).mockResolvedValueOnce({ id: "plan-next", active: true });
    const publishDue = vi.spyOn(shopifyUsageEventPublisherService, "publishDue").mockRejectedValue(new Error("flush failed"));

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", insideDrain));

    expect(publishDue).toHaveBeenCalledOnce();
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ pendingShopifyPlanHandle: "paid-next", pendingPlanId: "plan-next", pendingEffectiveAt: new Date("2026-10-01T00:00:00.000Z"), cancelAtPeriodEnd: false, lastSyncErrorCode: "PRE_CLOSE_USAGE_FLUSH_FAILED" }),
    }));
    expect(test.queue.add).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ expectedNextReconcileAt: "2026-09-30T23:58:00.000Z" }), expect.anything());
    publishDue.mockRestore();
  });

  it("uses the exact drain boundary for scheduled cancellation before the drain window", async () => {
    const test = harness({
      row: establishedRow({ subscription: {
        ...establishedRow().subscription,
        pendingPlanId: null,
        pendingShopifyPlanHandle: null,
        pendingEffectiveAt: null,
        cancelAtPeriodEnd: false,
      } }),
      providerResult: { ...establishedProvider, planHandle: "paid-current", pendingPlanHandle: null, pendingEffectiveAt: null, currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"), cancelAtEndOfCycle: true, cancelAtPeriodEnd: true },
      plan: establishedCurrentPlan,
    });
    test.database.billingPlan.findUnique.mockResolvedValueOnce(establishedCurrentPlan);
    const publishDue = vi.spyOn(shopifyUsageEventPublisherService, "publishDue").mockResolvedValue(undefined);

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", now));

    expect(publishDue).not.toHaveBeenCalled();
    expect(test.database.subscription.updateMany.mock.calls[0][0].data.nextReconcileAt).toEqual(new Date("2026-09-30T23:55:00.000Z"));
    expect(test.queue.add).toHaveBeenCalledOnce();
    publishDue.mockRestore();
  });

  it("uses the exact period boundary for scheduled cancellation inside the drain window", async () => {
    const insideDrain = new Date("2026-09-30T23:57:00.000Z");
    const test = harness({
      nowValue: insideDrain,
      row: establishedRow({ subscription: {
        ...establishedRow().subscription,
        pendingPlanId: null,
        pendingShopifyPlanHandle: null,
        pendingEffectiveAt: null,
        cancelAtPeriodEnd: false,
        nextReconcileAt: insideDrain,
      } }),
      providerResult: { ...establishedProvider, planHandle: "paid-current", pendingPlanHandle: null, pendingEffectiveAt: null, currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"), cancelAtEndOfCycle: true, cancelAtPeriodEnd: true },
      plan: establishedCurrentPlan,
    });
    test.database.billingPlan.findUnique.mockResolvedValueOnce(establishedCurrentPlan);
    const publishDue = vi.spyOn(shopifyUsageEventPublisherService, "publishDue").mockResolvedValue(undefined);

    await test.service.reconcileJob(createSubscriptionReconcilePayload("shop-1", "subscription-1", insideDrain));

    expect(publishDue).toHaveBeenCalledWith({ billingPeriodId: "period-current", runtimeConfig: test.runtimeConfig });
    expect(test.database.subscription.updateMany.mock.calls[0][0].data.nextReconcileAt).toEqual(new Date("2026-10-01T00:00:00.000Z"));
    expect(test.queue.add).toHaveBeenCalledOnce();
    publishDue.mockRestore();
  });
});
