import { describe, expect, it, vi } from "vitest";
import { ShopPlatform } from "@prisma/client";
import {
  BILLING_SUBSCRIPTION_RECONCILE_JOB_NAME,
  createBillingSubscriptionReconcileJobId,
} from "@modainteract/moda-interact-shared/billing";
import { ReconciliationQueueService } from "../../../../src/services/billing-subscription-reconciliation/reconciliation-queue.service.js";

const now = new Date("2026-10-02T12:00:00.000Z");
const next = new Date("2026-10-02T12:05:00.000Z");

function harness(
  options: { queue?: { add: ReturnType<typeof vi.fn> }; rows?: any[] } = {},
) {
  const queue =
    "queue" in options ? options.queue : { add: vi.fn().mockResolvedValue({}) };
  const { rows = [] } = options;
  const database = {
    shop: { findMany: vi.fn().mockResolvedValue(rows) },
    subscription: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  const logger = { error: vi.fn(), info: vi.fn() };
  const clock = vi.fn(() => now);
  const incidentSink = { report: vi.fn().mockResolvedValue(undefined) };
  const service = new ReconciliationQueueService(
    database as never,
    queue as never,
    logger as never,
    clock,
    incidentSink,
  );
  return { database, queue, logger, clock, service, incidentSink };
}

describe("ReconciliationQueueService", () => {
  it("publishes a deterministic job with the established queue options and clamps negative delays", async () => {
    const test = harness();
    const job = {
      schemaVersion: 1 as const,
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      expectedNextReconcileAt: next.toISOString(),
    };

    await test.service.enqueue(job, -500);

    expect(test.queue.add).toHaveBeenCalledWith(
      BILLING_SUBSCRIPTION_RECONCILE_JOB_NAME,
      job,
      {
        jobId: createBillingSubscriptionReconcileJobId(
          job.subscriptionId,
          job.expectedNextReconcileAt,
        ),
        delay: 0,
        removeOnComplete: 100,
        removeOnFail: true,
      },
    );
  });

  it("preserves future delays and publishes overdue schedules immediately", async () => {
    const test = harness({
      rows: [
        {
          id: "future-shop",
          subscription: { id: "future-sub", nextReconcileAt: next },
        },
        {
          id: "overdue-shop",
          subscription: {
            id: "overdue-sub",
            nextReconcileAt: new Date(now.getTime() - 1),
          },
        },
      ],
    });

    await expect(test.service.reconstruct()).resolves.toBe(2);

    expect(
      test.queue.add.mock.calls.map(([, , options]) => options.delay),
    ).toEqual([5 * 60 * 1000, 0]);
    expect(test.clock).toHaveBeenCalledTimes(2);
  });

  it("publishes an ordinary committed billing incident without scheduling an extra job", async () => {
    const test = harness();
    test.database.subscription.findUnique.mockResolvedValueOnce({
      id: "subscription-1",
      status: "SYNC_ERROR",
      observedShopifyPlanHandle: "growth",
      billingPeriodId: null,
      lastSyncErrorCode: "MISSING_BILLING_CYCLE",
      lastSyncErrorAt: now,
      lastSyncedAt: now,
    });
    await test.service.publishCommittedFailure("shop-1", "subscription-1");
    expect(test.incidentSink.report).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({
        lastSyncErrorCode: "MISSING_BILLING_CYCLE",
      }),
    );
    expect(test.queue?.add).not.toHaveBeenCalled();
  });

  it("keeps enqueue a no-op when no queue is configured", async () => {
    const test = harness({ queue: undefined });

    await expect(
      test.service.enqueue({
        schemaVersion: 1,
        shopId: "shop-1",
        subscriptionId: "subscription-1",
        expectedNextReconcileAt: next.toISOString(),
      }),
    ).resolves.toBeUndefined();

    expect(test.clock).not.toHaveBeenCalled();
  });

  it("counts successful delegated enqueue calls during reconstruction without a queue", async () => {
    const test = harness({
      queue: undefined,
      rows: [
        { id: "shop-1", subscription: { id: "sub-1", nextReconcileAt: next } },
        { id: "shop-2", subscription: { id: "sub-2", nextReconcileAt: next } },
      ],
    });

    await expect(test.service.reconstruct()).resolves.toBe(2);
    expect(test.queue).toBeUndefined();
    expect(test.logger.info).toHaveBeenLastCalledWith(
      "billing.subscription_reconciliation.reconstruction_finished",
      {
        eligibleShops: 2,
        enqueued: 2,
      },
    );
  });

  it("retains every startup reconstruction eligibility branch", async () => {
    const test = harness();

    await test.service.reconstruct();

    const where = test.database.shop.findMany.mock.calls[0][0].where;
    expect(where.platform).toBe(ShopPlatform.SHOPIFY);
    expect(where.AND[0].OR).toEqual([
      { status: "ACTIVE" },
      { status: "UNINSTALLED", reinstallPendingAt: { not: null } },
    ]);
    expect(where.AND[1].OR).toHaveLength(6);
    expect(where.AND[1].OR[0]).toEqual({
      subscription: {
        is: { pendingPlanId: { not: null }, nextReconcileAt: { not: null } },
      },
    });
    expect(where.AND[1].OR[1]).toEqual({
      subscription: {
        is: { status: "FROZEN", nextReconcileAt: { not: null } },
      },
    });
    expect(where.AND[1].OR[2]).toEqual({
      onboardingCompleted: true,
      subscription: {
        is: {
          status: "SYNC_ERROR",
          lastSyncErrorCode: {
            in: [
              "UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT",
              "UNFREEZE_LIFETIME_FREE_COUNTER_HISTORY_CONFLICT",
              "UNFREEZE_PRE_CLOSE_USAGE_FLUSH_FAILED",
            ],
          },
          planId: { not: null },
          nextReconcileAt: { not: null },
        },
      },
    });
    expect(where.AND[1].OR[3]).toEqual(
      expect.objectContaining({
        onboardingCompleted: true,
        subscription: {
          is: expect.objectContaining({
            billingPeriodId: null,
            plan: {
              is: {
                active: true,
                kind: "FREE",
                recoveryCreditPackEnabled: true,
              },
            },
          }),
        },
      }),
    );
    expect(where.AND[1].OR[4]).toEqual(
      expect.objectContaining({
        subscription: {
          is: expect.objectContaining({
            billingPeriodId: { not: null },
            plan: {
              is: {
                active: true,
                OR: [
                  { kind: "PAID_METERED" },
                  { kind: "FREE", recoveryCreditPackEnabled: true },
                ],
              },
            },
          }),
        },
      }),
    );
    expect(where.AND[1].OR[5]).toEqual({
      status: "UNINSTALLED",
      reinstallPendingAt: { not: null },
      subscription: { is: { nextReconcileAt: { not: null } } },
    });
  });

  it("isolates per-row enqueue failures and continues reconstructing", async () => {
    const queue = {
      add: vi
        .fn()
        .mockRejectedValueOnce(new Error("queue unavailable"))
        .mockResolvedValueOnce({}),
    };
    const test = harness({
      queue,
      rows: [
        {
          id: "failed-shop",
          subscription: { id: "failed-sub", nextReconcileAt: next },
        },
        {
          id: "ok-shop",
          subscription: { id: "ok-sub", nextReconcileAt: next },
        },
      ],
    });

    await expect(test.service.reconstruct()).resolves.toBe(1);
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(test.logger.error).toHaveBeenCalledWith(
      "billing.subscription_reconciliation.enqueue_failed",
      {
        shopId: "failed-shop",
        subscriptionId: "failed-sub",
        errorMessage: "queue unavailable",
        error: expect.objectContaining({ message: "queue unavailable" }),
      },
    );
  });
});

describe("Billing lifecycle incident handoff", () => {
  it("reports a committed billing error before scheduling its retry", async () => {
    const test = harness();
    test.database.subscription.findUnique.mockResolvedValueOnce({
      id: "subscription-1",
      status: "SYNC_ERROR",
      observedShopifyPlanHandle: "growth",
      billingPeriodId: "period-1",
      lastSyncErrorCode: "UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT",
      lastSyncErrorAt: now,
      lastSyncedAt: now,
      nextReconcileAt: next,
    });
    await test.service.publishCommittedLifecycleSchedule(
      "shop-1",
      "subscription-1",
    );
    expect(test.database.subscription.findUnique).toHaveBeenCalledOnce();
    expect(test.incidentSink.report).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({
        id: "subscription-1",
        lastSyncErrorCode: "UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT",
      }),
    );
    expect(test.queue?.add).toHaveBeenCalledOnce();
  });
});
