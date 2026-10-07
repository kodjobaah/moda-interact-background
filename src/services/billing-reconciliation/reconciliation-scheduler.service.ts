import { SubscriptionProjectionStatus } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import {
  BILLING_SUBSCRIPTION_RECONCILE_JOB_NAME,
  createBillingSubscriptionReconcileJobId,
} from "@modainteract/moda-interact-shared/billing";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";

import type { BackgroundRuntimeConfigSnapshot } from "../../runtime/background-runtime-config.js";
import { createSubscriptionReconcilePayload } from "../billing-subscription-reconciliation/reconciliation-queue.service.js";

type SchedulerDatabase = Pick<PrismaClient, "subscription">;
type SubscriptionQueue = Pick<Queue, "add">;

export type BillingReconciliationErrorCode = "PARTNER_API_ERROR" | "INTERNAL_RECONCILIATION_ERROR";

export class BillingReconciliationSchedulerService {
  constructor(
    private readonly database: SchedulerDatabase,
    private readonly subscriptionQueue: SubscriptionQueue | undefined,
    private readonly logger: StructuredLogger,
    private readonly now: () => Date,
  ) {}

  async markSyncError(
    shopId: string,
    errorCode: BillingReconciliationErrorCode,
    error: unknown,
    runtimeConfig?: Pick<BackgroundRuntimeConfigSnapshot, "billingFrozenRecheckSeconds" | "billingProviderRetrySeconds">,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error("billing.subscription_reconciliation.error", { shopId, errorCode, error: message });
    const now = this.now();
    const subscription = await this.database.subscription.findUnique({
      where: { shopId },
      select: { id: true, status: true, planId: true, billingPeriodId: true, nextReconcileAt: true },
    });
    if (!subscription) return;
    const nextReconcileAt = subscription.status === SubscriptionProjectionStatus.FROZEN
      ? new Date(now.getTime() + (runtimeConfig?.billingFrozenRecheckSeconds ?? 3600) * 1000)
      : new Date(now.getTime() + (runtimeConfig?.billingProviderRetrySeconds ?? 300) * 1000);
    const updated = await this.database.subscription.updateMany({
      where: {
        id: subscription.id,
        status: subscription.status,
        planId: subscription.planId,
        billingPeriodId: subscription.billingPeriodId,
        nextReconcileAt: subscription.nextReconcileAt,
      },
      data: {
        lastSyncErrorCode: errorCode,
        lastSyncErrorAt: now,
        lastSyncedAt: now,
        nextReconcileAt,
      },
    });
    if (updated.count > 0) await this.enqueue(shopId, subscription.id, nextReconcileAt, now);
  }

  async enqueue(
    shopId: string,
    subscriptionId: string,
    nextReconcileAt: Date,
    now = this.now(),
  ): Promise<void> {
    if (!this.subscriptionQueue) return;
    try {
      const job = createSubscriptionReconcilePayload(shopId, subscriptionId, nextReconcileAt);
      await this.subscriptionQueue.add(BILLING_SUBSCRIPTION_RECONCILE_JOB_NAME, job, {
        jobId: createBillingSubscriptionReconcileJobId(subscriptionId, nextReconcileAt.toISOString()),
        delay: Math.max(0, nextReconcileAt.getTime() - now.getTime()),
        removeOnComplete: 100,
        removeOnFail: true,
      });
    } catch (error) {
      this.logger.warn("billing.subscription_reconciliation.enqueue_failed", {
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
    if (current?.nextReconcileAt) {
      await this.enqueue(shopId, subscriptionId, current.nextReconcileAt);
    }
  }
}
