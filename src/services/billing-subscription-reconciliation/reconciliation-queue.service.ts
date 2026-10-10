import {
  BILLING_SUBSCRIPTION_RECONCILE_JOB_NAME,
  BILLING_SUBSCRIPTION_RECONCILE_SCHEMA_VERSION,
  createBillingSubscriptionReconcileJobId,
  type BillingSubscriptionReconcileJob,
} from "@modainteract/moda-interact-shared/billing";
import { BillingPlanKind, ShopPlatform, SubscriptionProjectionStatus, type PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";

type SubscriptionQueue = Pick<Queue, "add">;
type BillingDatabase = PrismaClient;

export function createSubscriptionReconcilePayload(
  shopId: string,
  subscriptionId: string,
  expectedNextReconcileAt: Date,
): BillingSubscriptionReconcileJob {
  return {
    schemaVersion: BILLING_SUBSCRIPTION_RECONCILE_SCHEMA_VERSION,
    shopId,
    subscriptionId,
    expectedNextReconcileAt: expectedNextReconcileAt.toISOString(),
  };
}

export class ReconciliationQueueService {
  constructor(
    private readonly database: BillingDatabase,
    private readonly queue: SubscriptionQueue | undefined,
    private readonly logger: StructuredLogger,
    private readonly now: () => Date,
  ) {}

  async enqueue(job: BillingSubscriptionReconcileJob, delay = 0): Promise<void> {
    if (!this.queue) return;
    await this.queue.add(BILLING_SUBSCRIPTION_RECONCILE_JOB_NAME, job, {
      jobId: createBillingSubscriptionReconcileJobId(job.subscriptionId, job.expectedNextReconcileAt),
      delay: Math.max(0, delay),
      removeOnComplete: 100,
      removeOnFail: true,
    });
  }

  async reconstruct(): Promise<number> {
    const rows = await this.database.shop.findMany({
      where: {
        platform: ShopPlatform.SHOPIFY,
        AND: [
          { OR: [
            { status: "ACTIVE" },
            { status: "UNINSTALLED", reinstallPendingAt: { not: null } },
          ] },
          { OR: [
          { subscription: { is: { pendingPlanId: { not: null }, nextReconcileAt: { not: null } } } },
          { subscription: { is: { status: "FROZEN", nextReconcileAt: { not: null } } } },
          {
            onboardingCompleted: true,
            subscription: { is: {
              status: { in: [SubscriptionProjectionStatus.ACTIVE, SubscriptionProjectionStatus.TRIALING] },
              planId: { not: null },
              billingPeriodId: null,
              pendingPlanId: null,
              pendingShopifyPlanHandle: null,
              pendingEffectiveAt: null,
              nextReconcileAt: { not: null },
              plan: { is: { active: true, kind: BillingPlanKind.FREE, recoveryCreditPackEnabled: true } },
            } },
          },
          {
            subscription: { is: {
              status: { in: [SubscriptionProjectionStatus.ACTIVE, SubscriptionProjectionStatus.TRIALING] },
              planId: { not: null },
              billingPeriodId: { not: null },
              pendingPlanId: null,
              pendingShopifyPlanHandle: null,
              pendingEffectiveAt: null,
              nextReconcileAt: { not: null },
              plan: { is: {
                active: true,
                OR: [
                  { kind: BillingPlanKind.PAID_METERED },
                  { kind: BillingPlanKind.FREE, recoveryCreditPackEnabled: true },
                ],
              } },
            } },
          },
          {
            status: "UNINSTALLED",
            reinstallPendingAt: { not: null },
            subscription: { is: { nextReconcileAt: { not: null } } },
          },
          ] },
        ],
      },
      select: {
        id: true,
        reinstallPendingAt: true,
        subscription: { select: { id: true, nextReconcileAt: true } },
      },
    });
    this.logger.info("billing.subscription_reconciliation.reconstruction_started", {
      eligibleShops: rows.length,
    });
    let enqueued = 0;
    for (const row of rows) {
      if (!row.subscription?.nextReconcileAt) continue;
      const job = createSubscriptionReconcilePayload(row.id, row.subscription.id, row.subscription.nextReconcileAt);
      try {
        await this.enqueue(job, Math.max(0, row.subscription.nextReconcileAt.getTime() - this.now().getTime()));
        enqueued += 1;
      } catch (error) {
        this.logger.error("billing.subscription_reconciliation.enqueue_failed", {
          shopId: row.id,
          subscriptionId: row.subscription.id,
          errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure",
        });
      }
    }
    this.logger.info("billing.subscription_reconciliation.reconstruction_finished", {
      eligibleShops: rows.length,
      enqueued,
    });
    return enqueued;
  }

  async publishNext(shopId: string, subscriptionId: string, next: Date): Promise<void> {
    try {
      await this.enqueue(createSubscriptionReconcilePayload(shopId, subscriptionId, next), Math.max(0, next.getTime() - this.now().getTime()));
    } catch (error) {
      this.logger.error("billing.subscription_reconciliation.enqueue_failed", {
        shopId,
        subscriptionId,
        errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure",
      });
    }
  }

  async publishCommittedLifecycleSchedule(shopId: string, subscriptionId: string): Promise<void> {
    const current = await this.database.subscription.findUnique({
      where: { id: subscriptionId },
      select: { nextReconcileAt: true },
    });
    if (current?.nextReconcileAt) await this.publishNext(shopId, subscriptionId, current.nextReconcileAt);
  }
}