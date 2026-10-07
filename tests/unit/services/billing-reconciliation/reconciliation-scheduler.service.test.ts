import { describe, expect, it, vi } from "vitest";

import { BillingReconciliationSchedulerService } from "../../../../src/services/billing-reconciliation/reconciliation-scheduler.service.js";

function harness({
  status = "ACTIVE",
  nextReconcileAt = new Date("2026-09-12T11:00:00.000Z"),
  queue = { add: vi.fn().mockResolvedValue({}) },
} = {}) {
  const database = {
    subscription: {
      findUnique: vi.fn().mockResolvedValue({
        id: "subscription-1",
        status,
        planId: "plan-1",
        billingPeriodId: "period-1",
        nextReconcileAt,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const logger = { warn: vi.fn(), error: vi.fn() };
  const now = () => new Date("2026-09-12T12:00:00.000Z");
  const service = new BillingReconciliationSchedulerService(
    database as never,
    queue,
    logger as never,
    now,
  );
  return { database, queue, logger, service, now };
}

describe("BillingReconciliationSchedulerService", () => {
  it("enqueues the deterministic subscription reconciliation job with the remaining delay", async () => {
    const test = harness();
    const next = new Date("2026-09-12T12:01:00.000Z");

    await test.service.enqueue("shop-1", "subscription-1", next, test.now());

    expect(test.queue.add).toHaveBeenCalledWith(
      "reconcile-subscription",
      expect.objectContaining({
        shopId: "shop-1",
        subscriptionId: "subscription-1",
        expectedNextReconcileAt: "2026-09-12T12:01:00.000Z",
      }),
      expect.objectContaining({
        jobId: expect.any(String),
        delay: 60_000,
        removeOnComplete: 100,
        removeOnFail: true,
      }),
    );
  });

  it("keeps periodic reconciliation successful when queue publication fails", async () => {
    const queue = { add: vi.fn().mockRejectedValue(new Error("Redis unavailable")) };
    const test = harness({ queue });

    await expect(test.service.enqueue(
      "shop-1",
      "subscription-1",
      new Date("2026-09-12T12:01:00.000Z"),
      test.now(),
    )).resolves.toBeUndefined();

    expect(test.logger.warn).toHaveBeenCalledWith(
      "billing.subscription_reconciliation.enqueue_failed",
      {
        shopId: "shop-1",
        subscriptionId: "subscription-1",
        errorMessage: "Redis unavailable",
      },
    );
  });

  it("records provider failures and schedules the normal provider retry", async () => {
    const test = harness();

    await test.service.markSyncError(
      "shop-1",
      "PARTNER_API_ERROR",
      new Error("Partner unavailable"),
      { billingFrozenRecheckSeconds: 3600, billingProviderRetrySeconds: 300 },
    );

    expect(test.database.subscription.updateMany).toHaveBeenCalledWith({
      where: {
        id: "subscription-1",
        status: "ACTIVE",
        planId: "plan-1",
        billingPeriodId: "period-1",
        nextReconcileAt: new Date("2026-09-12T11:00:00.000Z"),
      },
      data: {
        lastSyncErrorCode: "PARTNER_API_ERROR",
        lastSyncErrorAt: new Date("2026-09-12T12:00:00.000Z"),
        lastSyncedAt: new Date("2026-09-12T12:00:00.000Z"),
        nextReconcileAt: new Date("2026-09-12T12:05:00.000Z"),
      },
    });
    expect(test.logger.error).toHaveBeenCalledWith(
      "billing.subscription_reconciliation.error",
      { shopId: "shop-1", errorCode: "PARTNER_API_ERROR", error: "Partner unavailable" },
    );
    expect(test.queue.add).toHaveBeenCalledWith(
      "reconcile-subscription",
      expect.any(Object),
      expect.objectContaining({ delay: 300_000 }),
    );
  });

  it("uses the frozen recheck cadence for frozen subscriptions", async () => {
    const test = harness({ status: "FROZEN" });

    await test.service.markSyncError(
      "shop-1",
      "INTERNAL_RECONCILIATION_ERROR",
      new Error("Projection failed"),
      { billingFrozenRecheckSeconds: 900, billingProviderRetrySeconds: 300 },
    );

    expect(test.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        nextReconcileAt: new Date("2026-09-12T12:15:00.000Z"),
      }),
    }));
    expect(test.queue.add).toHaveBeenCalledWith(
      "reconcile-subscription",
      expect.any(Object),
      expect.objectContaining({ delay: 900_000 }),
    );
  });

  it("publishes a committed lifecycle schedule from durable subscription state", async () => {
    const test = harness({ nextReconcileAt: new Date("2026-09-12T12:02:00.000Z") });

    await test.service.publishCommittedLifecycleSchedule("shop-1", "subscription-1");

    expect(test.database.subscription.findUnique).toHaveBeenCalledWith({
      where: { id: "subscription-1" },
      select: { nextReconcileAt: true },
    });
    expect(test.queue.add).toHaveBeenCalledWith(
      "reconcile-subscription",
      expect.any(Object),
      expect.objectContaining({ delay: 120_000 }),
    );
  });
});
