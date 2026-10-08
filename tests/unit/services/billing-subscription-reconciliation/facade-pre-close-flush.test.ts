import { describe, expect, it, vi } from "vitest";
import { shopifyUsageEventPublisherService } from "../../../../src/services/shopify-usage-event-publisher.service.js";
import { harness, payload, cycleRow, cyclePlan } from "./facade-test-fixtures.js";

describe("BillingSubscriptionReconciliationService", () => {
  it("reschedules an early rollover job to the exact drain start", async () => {
    const periodStart = new Date("2026-09-01T00:00:00.000Z");
    const periodEnd = new Date("2026-10-01T00:00:00.000Z");
    const oldNext = new Date("2026-09-30T22:00:00.000Z");
    const preCloseAt = new Date("2026-09-30T23:55:00.000Z");
    const row = cycleRow({ subscription: { ...cycleRow().subscription, planId: "plan-paid", billingPeriodId: "period-old", currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, nextReconcileAt: oldNext } });
    const test = harness({
      row,
      plan: { id: "plan-paid", active: true, name: "Paid", kind: "PAID_METERED", shopifyPlanHandle: "paid-2026", recoveryCreditPackEnabled: true, shopifyUsageEventHandle: "recovery-meter", shopifyRecoveryCreditPackEventHandle: null, includedRecoveryConversationAllowance: 100 },
      nowValue: new Date("2026-09-30T22:30:00.000Z"),
    });
    test.database.subscription.findUnique.mockResolvedValue({
      id: "subscription-1", status: "ACTIVE", planId: "plan-paid", billingPeriodId: "period-old",
      currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, nextReconcileAt: oldNext,
    });

    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: oldNext.toISOString() });

    expect(test.partner.getActiveSubscription).toHaveBeenCalledOnce();
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "subscription-1",
        status: { in: ["ACTIVE", "TRIALING"] },
        planId: "plan-paid",
        billingPeriodId: "period-old",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        nextReconcileAt: oldNext,
      },
      data: { nextReconcileAt: preCloseAt },
    }));
    expect(test.queue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ expectedNextReconcileAt: preCloseAt.toISOString() }),
      expect.objectContaining({ delay: 85 * 60 * 1000 }),
    );
    expect(test.database.subscription.updateMany).toHaveBeenCalledTimes(1);
  });

  it("uses the exact source projection CAS when rescheduling an early rollover job", async () => {
    const periodStart = new Date("2026-09-01T00:00:00.000Z");
    const periodEnd = new Date("2026-10-01T00:00:00.000Z");
    const expectedNext = new Date("2026-09-30T23:00:00.000Z");
    const row = cycleRow({
      subscription: {
        ...cycleRow().subscription,
        planId: "plan-paid",
        billingPeriodId: "period-old",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        nextReconcileAt: expectedNext,
      },
    });
    const test = harness({
      row,
      plan: {
        id: "plan-paid",
        active: true,
        name: "Paid",
        kind: "PAID_METERED",
        shopifyPlanHandle: "paid-2026",
        recoveryCreditPackEnabled: true,
        shopifyUsageEventHandle: "recovery-meter",
        shopifyRecoveryCreditPackEventHandle: null,
        includedRecoveryConversationAllowance: 100,
      },
      nowValue: new Date("2026-09-30T23:01:00.000Z"),
    });
    test.database.subscription.findUnique.mockResolvedValue({
      id: "subscription-1",
      status: "ACTIVE",
      planId: "plan-paid",
      billingPeriodId: "period-old",
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      nextReconcileAt: expectedNext,
    });
    test.database.subscription.updateMany.mockResolvedValue({ count: 0 });
    const publishDue = vi.spyOn(shopifyUsageEventPublisherService, "publishDue").mockResolvedValue({
      selected: 0,
      claimed: 0,
      reported: 0,
      retryable: 0,
      needsAttention: 0,
    });

    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: expectedNext.toISOString() });

    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "subscription-1",
        status: { in: ["ACTIVE", "TRIALING"] },
        planId: "plan-paid",
        billingPeriodId: "period-old",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        nextReconcileAt: expectedNext,
      },
    }));
    expect(test.queue.add).not.toHaveBeenCalled();
    publishDue.mockRestore();
  });

  it("flushes only the scheduled BillingPeriod and schedules the exact boundary", async () => {
    const periodStart = new Date("2026-09-01T00:00:00.000Z");
    const periodEnd = new Date("2026-10-01T00:00:00.000Z");
    const preCloseAt = new Date("2026-09-30T23:55:00.000Z");
    const row = cycleRow({
      subscription: {
        ...cycleRow().subscription,
        planId: "plan-paid",
        billingPeriodId: "period-old",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        nextReconcileAt: preCloseAt,
      },
    });
    const test = harness({
      row,
      plan: {
        id: "plan-paid", active: true, name: "Paid", kind: "PAID_METERED",
        shopifyPlanHandle: "paid-2026", recoveryCreditPackEnabled: true,
        shopifyUsageEventHandle: "recovery-meter", shopifyRecoveryCreditPackEventHandle: "pack-meter",
        includedRecoveryConversationAllowance: 100,
      },
      nowValue: new Date("2026-09-30T23:56:00.000Z"),
    });
    test.database.subscription.findUnique.mockResolvedValue({
      id: "subscription-1", status: "ACTIVE", planId: "plan-paid", billingPeriodId: "period-old",
      currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, nextReconcileAt: preCloseAt,
    });
    const publishDue = vi.spyOn(shopifyUsageEventPublisherService, "publishDue").mockResolvedValue({
      selected: 2, claimed: 2, reported: 2, retryable: 0, needsAttention: 0,
    });

    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: preCloseAt.toISOString() });

    expect(publishDue).toHaveBeenCalledWith({ billingPeriodId: "period-old", runtimeConfig: test.runtimeConfig });
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ nextReconcileAt: periodEnd, lastSyncErrorCode: null, lastSyncErrorAt: null }),
    }));
    expect(test.queue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ expectedNextReconcileAt: periodEnd.toISOString() }),
      expect.objectContaining({ jobId: expect.any(String), delay: 4 * 60 * 1000 }),
    );
    publishDue.mockRestore();
  });

  it("records and retries a thrown pre-close flush failure before the boundary", async () => {
    const periodStart = new Date("2026-09-01T00:00:00.000Z");
    const periodEnd = new Date("2026-10-01T00:00:00.000Z");
    const preCloseAt = new Date("2026-09-30T23:55:00.000Z");
    const retryNow = new Date("2026-09-30T23:56:00.000Z");
    const retryAt = new Date("2026-09-30T23:57:00.000Z");
    const row = cycleRow({ subscription: { ...cycleRow().subscription, planId: "plan-paid", billingPeriodId: "period-old", currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, nextReconcileAt: preCloseAt } });
    const test = harness({ row, plan: { ...cyclePlan, id: "plan-paid", name: "Paid", kind: "PAID_METERED", shopifyPlanHandle: "paid-2026", recoveryCreditPackEnabled: true, shopifyUsageEventHandle: "recovery-meter", shopifyRecoveryCreditPackEventHandle: "pack-meter", includedRecoveryConversationAllowance: 100 }, nowValue: retryNow });
    test.database.subscription.findUnique.mockResolvedValue({ id: "subscription-1", status: "ACTIVE", planId: "plan-paid", billingPeriodId: "period-old", currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, nextReconcileAt: preCloseAt });
    const publishDue = vi.spyOn(shopifyUsageEventPublisherService, "publishDue").mockRejectedValue(new Error("publisher unavailable"));

    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: preCloseAt.toISOString() });

    expect(publishDue).toHaveBeenCalledWith({ billingPeriodId: "period-old", runtimeConfig: test.runtimeConfig });
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ nextReconcileAt: retryAt, lastSyncErrorCode: "PRE_CLOSE_USAGE_FLUSH_FAILED", lastSyncErrorAt: retryNow }),
    }));
    expect(test.queue.add).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ expectedNextReconcileAt: retryAt.toISOString() }), expect.any(Object));
    publishDue.mockRestore();
  });

  it("keeps pre-close failure evidence and schedules the boundary in the final minute", async () => {
    const periodStart = new Date("2026-09-01T00:00:00.000Z");
    const periodEnd = new Date("2026-10-01T00:00:00.000Z");
    const preCloseAt = new Date("2026-09-30T23:55:00.000Z");
    const finalMinute = new Date("2026-09-30T23:59:30.000Z");
    const row = cycleRow({ subscription: { ...cycleRow().subscription, planId: "plan-paid", billingPeriodId: "period-old", currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, nextReconcileAt: preCloseAt } });
    const test = harness({ row, plan: { ...cyclePlan, id: "plan-paid", name: "Paid", kind: "PAID_METERED", shopifyPlanHandle: "paid-2026", recoveryCreditPackEnabled: true, shopifyUsageEventHandle: "recovery-meter", shopifyRecoveryCreditPackEventHandle: "pack-meter", includedRecoveryConversationAllowance: 100 }, nowValue: finalMinute });
    test.database.subscription.findUnique.mockResolvedValue({ id: "subscription-1", status: "ACTIVE", planId: "plan-paid", billingPeriodId: "period-old", currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, nextReconcileAt: preCloseAt });
    const publishDue = vi.spyOn(shopifyUsageEventPublisherService, "publishDue").mockRejectedValue(new Error("publisher unavailable"));

    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: preCloseAt.toISOString() });

    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ nextReconcileAt: periodEnd, lastSyncErrorCode: "PRE_CLOSE_USAGE_FLUSH_FAILED", lastSyncErrorAt: finalMinute }),
    }));
    expect(test.queue.add).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ expectedNextReconcileAt: periodEnd.toISOString() }), expect.any(Object));
    publishDue.mockRestore();
  });

  it("successfully retries a failed pre-close flush and clears its failure metadata", async () => {
    const periodStart = new Date("2026-09-01T00:00:00.000Z");
    const periodEnd = new Date("2026-10-01T00:00:00.000Z");
    const preCloseAt = new Date("2026-09-30T23:55:00.000Z");
    const retryNow = new Date("2026-09-30T23:57:00.000Z");
    const row = cycleRow({ subscription: { ...cycleRow().subscription, planId: "plan-paid", billingPeriodId: "period-old", currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, nextReconcileAt: retryNow } });
    const test = harness({
      row,
      plan: { id: "plan-paid", active: true, name: "Paid", kind: "PAID_METERED", shopifyPlanHandle: "paid-2026", recoveryCreditPackEnabled: true, shopifyUsageEventHandle: "recovery-meter", shopifyRecoveryCreditPackEventHandle: null, includedRecoveryConversationAllowance: 100 },
      nowValue: retryNow,
    });
    test.database.subscription.findUnique.mockResolvedValue({
      id: "subscription-1", status: "ACTIVE", planId: "plan-paid", billingPeriodId: "period-old",
      currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, nextReconcileAt: retryNow,
    });
    const publishDue = vi.spyOn(shopifyUsageEventPublisherService, "publishDue").mockResolvedValue({ selected: 1, claimed: 1, reported: 1, retryable: 0, needsAttention: 0 });

    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: retryNow.toISOString() });

    expect(publishDue).toHaveBeenCalledWith({ billingPeriodId: "period-old", runtimeConfig: test.runtimeConfig });
    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { nextReconcileAt: periodEnd, lastSyncedAt: retryNow, lastSyncErrorCode: null, lastSyncErrorAt: null },
    }));
    expect(test.queue.add).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ expectedNextReconcileAt: periodEnd.toISOString() }), expect.any(Object));
    publishDue.mockRestore();
  });

  it("does not publish or schedule when the pre-close source projection CAS is stale", async () => {
    const periodStart = new Date("2026-09-01T00:00:00.000Z");
    const periodEnd = new Date("2026-10-01T00:00:00.000Z");
    const preCloseAt = new Date("2026-09-30T23:55:00.000Z");
    const row = cycleRow({ subscription: { ...cycleRow().subscription, planId: "plan-paid", billingPeriodId: "period-old", currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, nextReconcileAt: preCloseAt } });
    const test = harness({ row, plan: { ...cyclePlan, id: "plan-paid", name: "Paid", kind: "PAID_METERED", shopifyPlanHandle: "paid-2026", recoveryCreditPackEnabled: true, shopifyUsageEventHandle: "recovery-meter", shopifyRecoveryCreditPackEventHandle: "pack-meter", includedRecoveryConversationAllowance: 100 }, nowValue: new Date("2026-09-30T23:56:00.000Z") });
    test.database.subscription.findUnique.mockResolvedValue({ id: "subscription-1", status: "ACTIVE", planId: "plan-paid", billingPeriodId: "period-new", currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, nextReconcileAt: preCloseAt });
    const publishDue = vi.spyOn(shopifyUsageEventPublisherService, "publishDue").mockResolvedValue({ selected: 0, claimed: 0, reported: 0, retryable: 0, needsAttention: 0 });

    await test.service.reconcileJob({ ...payload, expectedNextReconcileAt: preCloseAt.toISOString() });

    expect(publishDue).not.toHaveBeenCalled();
    expect(test.database.subscription.updateMany).not.toHaveBeenCalled();
    expect(test.queue.add).not.toHaveBeenCalled();
    publishDue.mockRestore();
  });
});
