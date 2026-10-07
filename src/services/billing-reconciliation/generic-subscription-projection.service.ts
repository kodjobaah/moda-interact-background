import { Prisma, SubscriptionProjectionStatus } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";

import type { PartnerSubscription } from "../../providers/shopify-partner-billing.provider.js";
import { ensureCurrentBillingPeriodProjection } from "../current-billing-period-projection.service.js";
import { ensureLifetimeFreeCounterForMappedSubscription } from "./lifetime-free-counter-repair.js";
import {
  readLockedGenericSubscription,
  type GenericExistingSubscription,
} from "./generic-subscription-lock.js";
import {
  hasValidProviderBillingCycle,
  type ObservedBillingPlan,
  type ObservedPlanProjection,
} from "./observed-plan-projection.js";
import type { BillingReconciliationSchedulerService } from "./reconciliation-scheduler.service.js";

const GENERIC_PROJECTION_RETRY_MS = 60 * 1000;

type GenericSubscriptionProjectionDatabase = Pick<PrismaClient, "$transaction" | "billingPlan" | "subscription">;
type ReconciliationScheduler = Pick<BillingReconciliationSchedulerService, "enqueue">;

type GenericSubscriptionProjectionInput = {
  shopId: string;
  provider: PartnerSubscription;
  plan: ObservedBillingPlan | null;
  existing: GenericExistingSubscription | null;
  projection: ObservedPlanProjection;
  now: Date;
};

export type GenericSubscriptionProjectionResult = {
  billingPeriodId: string | null;
  packMeterHandle: string | null;
};

export class GenericSubscriptionProjectionService {
  constructor(
    private readonly database: GenericSubscriptionProjectionDatabase,
    private readonly scheduler: ReconciliationScheduler,
    private readonly logger: StructuredLogger,
  ) {}

  async reconcile(input: GenericSubscriptionProjectionInput): Promise<GenericSubscriptionProjectionResult> {
    const { shopId, provider, plan, existing, projection, now } = input;
    const pendingPlan = provider.pendingPlanHandle
      ? await this.database.billingPlan.findUnique({
          where: { shopifyPlanHandle: provider.pendingPlanHandle },
          select: { id: true, active: true },
        })
      : null;

    if (projection.executableMapped && plan) {
      if (!hasValidProviderBillingCycle(provider)) {
        return this.recordMissingBillingCycle(shopId, existing, now);
      }
      return this.materialiseMappedProjection({
        shopId,
        provider,
        plan,
        existing,
        pendingPlan,
        projection,
        now,
      });
    }

    await this.database.subscription.upsert({
      where: { shopId },
      update: this.failClosedProjectionData(provider, plan, pendingPlan, projection, now),
      create: {
        shopId,
        ...this.failClosedProjectionData(provider, plan, pendingPlan, projection, now),
      },
    });

    return {
      billingPeriodId: null,
      packMeterHandle: plan?.active ? plan.shopifyRecoveryCreditPackEventHandle ?? null : null,
    };
  }

  private async recordMissingBillingCycle(
    shopId: string,
    existing: GenericExistingSubscription | null,
    now: Date,
  ): Promise<GenericSubscriptionProjectionResult> {
    const failed = await this.database.$transaction(async (transaction: Prisma.TransactionClient) => {
      const current = await readLockedGenericSubscription(transaction, shopId, existing);
      if (!current) return { kind: "stale" as const };

      const nextReconcileAt = new Date(now.getTime() + GENERIC_PROJECTION_RETRY_MS);
      await transaction.subscription.update({
        where: { id: current.id },
        data: {
          status: SubscriptionProjectionStatus.SYNC_ERROR,
          lastSyncErrorCode: "MISSING_BILLING_CYCLE",
          lastSyncErrorAt: now,
          lastSyncedAt: now,
          nextReconcileAt,
        },
      });
      return { kind: "failed" as const, subscriptionId: current.id, nextReconcileAt };
    });

    if (failed.kind === "failed") {
      await this.scheduler.enqueue(shopId, failed.subscriptionId, failed.nextReconcileAt, now);
    }
    return { billingPeriodId: existing?.billingPeriodId ?? null, packMeterHandle: null };
  }

  private async materialiseMappedProjection(input: {
    shopId: string;
    provider: PartnerSubscription & { currentPeriodStart: Date; currentPeriodEnd: Date };
    plan: ObservedBillingPlan;
    existing: GenericExistingSubscription | null;
    pendingPlan: { id: string; active: boolean } | null;
    projection: ObservedPlanProjection;
    now: Date;
  }): Promise<GenericSubscriptionProjectionResult> {
    const { shopId, provider, plan, existing, pendingPlan, projection, now } = input;
    const result = await this.database.$transaction(async (transaction: Prisma.TransactionClient) => {
      const current = await readLockedGenericSubscription(transaction, shopId, existing);
      if (!current) return { kind: "stale" as const };

      const lifetimeCounter = await ensureLifetimeFreeCounterForMappedSubscription(transaction, shopId);
      if (lifetimeCounter.kind === "history-conflict") {
        await transaction.subscription.update({
          where: { id: current.id },
          data: {
            status: SubscriptionProjectionStatus.SYNC_ERROR,
            lastSyncErrorCode: "LIFETIME_FREE_COUNTER_HISTORY_CONFLICT",
            lastSyncErrorAt: now,
            lastSyncedAt: now,
            nextReconcileAt: null,
          },
        });
        return { kind: "lifetime-counter-conflict" as const };
      }

      const period = await ensureCurrentBillingPeriodProjection(transaction, {
        shopId,
        subscriptionId: current.id,
        periodStart: provider.currentPeriodStart,
        periodEnd: provider.currentPeriodEnd,
        providerPlanHandle: provider.planHandle,
        plan,
      });
      if (period.kind === "CONFLICT") {
        const nextReconcileAt = new Date(now.getTime() + GENERIC_PROJECTION_RETRY_MS);
        await transaction.subscription.update({
          where: { id: current.id },
          data: {
            status: SubscriptionProjectionStatus.SYNC_ERROR,
            lastSyncErrorCode: "BILLING_PERIOD_PLAN_CONFLICT",
            lastSyncErrorAt: now,
            lastSyncedAt: now,
            nextReconcileAt,
          },
        });
        return { kind: "conflict" as const, subscriptionId: current.id, nextReconcileAt };
      }

      await transaction.subscription.update({
        where: { id: current.id },
        data: {
          planId: plan.id,
          observedShopifyPlanHandle: provider.planHandle,
          status: projection.status,
          billingPeriodId: period.billingPeriodId,
          currentPeriodStart: provider.currentPeriodStart,
          currentPeriodEnd: provider.currentPeriodEnd,
          trialEndsAt: provider.trialEndsAt,
          cancelAtPeriodEnd: provider.cancelAtPeriodEnd,
          providerSubscriptionId: provider.providerSubscriptionId,
          lastSyncedAt: now,
          lastSyncErrorCode: null,
          lastSyncErrorAt: null,
          pendingShopifyPlanHandle: provider.pendingPlanHandle,
          pendingPlanId: pendingPlan?.active ? pendingPlan.id : null,
          pendingEffectiveAt: provider.pendingEffectiveAt,
        },
      });
      return { kind: "ready" as const, billingPeriodId: period.billingPeriodId };
    });

    if (result.kind === "conflict") {
      await this.scheduler.enqueue(shopId, result.subscriptionId, result.nextReconcileAt, now);
      return { billingPeriodId: null, packMeterHandle: null };
    }
    if (result.kind === "lifetime-counter-conflict") {
      this.logger.warn("billing.subscription_reconciliation.lifetime_free_counter_history_conflict", { shopId });
      return { billingPeriodId: existing?.billingPeriodId ?? null, packMeterHandle: null };
    }
    if (result.kind === "ready") {
      return {
        billingPeriodId: result.billingPeriodId,
        packMeterHandle: plan.shopifyRecoveryCreditPackEventHandle ?? null,
      };
    }
    return {
      billingPeriodId: null,
      packMeterHandle: plan.shopifyRecoveryCreditPackEventHandle ?? null,
    };
  }

  private failClosedProjectionData(
    provider: PartnerSubscription,
    plan: ObservedBillingPlan | null,
    pendingPlan: { id: string; active: boolean } | null,
    projection: ObservedPlanProjection,
    now: Date,
  ) {
    return {
      planId: projection.planUsable ? plan?.id ?? null : null,
      observedShopifyPlanHandle: provider.planHandle,
      status: projection.status,
      billingPeriodId: null,
      currentPeriodStart: provider.currentPeriodStart,
      currentPeriodEnd: provider.currentPeriodEnd,
      trialEndsAt: provider.trialEndsAt,
      cancelAtPeriodEnd: provider.cancelAtPeriodEnd,
      providerSubscriptionId: provider.providerSubscriptionId,
      lastSyncedAt: now,
      lastSyncErrorCode: projection.syncErrorCode,
      lastSyncErrorAt: projection.syncErrorCode ? now : null,
      pendingShopifyPlanHandle: provider.pendingPlanHandle,
      pendingPlanId: pendingPlan?.active ? pendingPlan.id : null,
      pendingEffectiveAt: provider.pendingEffectiveAt,
    };
  }
}
