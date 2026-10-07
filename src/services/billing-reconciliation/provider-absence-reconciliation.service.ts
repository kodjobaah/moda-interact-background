import { SubscriptionProjectionStatus } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import type { PartnerSubscriptionReconciliationSnapshot } from "../../providers/shopify-partner-billing.provider.js";
import type { BackgroundRuntimeConfigSnapshot } from "../../runtime/background-runtime-config.js";
import { ShopifySubscriptionLifecycleReconciliationService } from "../shopify-subscription-lifecycle-reconciliation.service.js";
import type { BillingReconciliationSchedulerService } from "./reconciliation-scheduler.service.js";

type ProviderAbsenceDatabase = Pick<PrismaClient, "$transaction" | "subscription">;
type ReconciliationScheduler = Pick<BillingReconciliationSchedulerService, "publishCommittedLifecycleSchedule">;
type ProviderAbsenceProjection = { billingPeriodId: string | null; packMeterHandle: string | null };

export class ProviderAbsenceReconciliationService {
  constructor(
    private readonly database: ProviderAbsenceDatabase,
    private readonly scheduler: ReconciliationScheduler,
  ) {}

  async reconcile(
    shopId: string,
    snapshot: PartnerSubscriptionReconciliationSnapshot,
    now: Date,
    runtimeConfig?: Pick<BackgroundRuntimeConfigSnapshot, "billingFrozenRecheckSeconds" | "billingProviderRetrySeconds">,
  ): Promise<ProviderAbsenceProjection> {
    const existing = await this.database.subscription.findUnique({
      where: { shopId },
      select: {
        id: true,
        status: true,
        billingPeriodId: true,
        nextReconcileAt: true,
        pendingShopifyPlanHandle: true,
        pendingPlanId: true,
        pendingEffectiveAt: true,
        plan: { select: { shopifyRecoveryCreditPackEventHandle: true } },
      },
    });

    if (
      existing
      && existing.status !== SubscriptionProjectionStatus.NO_CONTRACT
      && (snapshot.latestLifecycleEvent || existing.status === SubscriptionProjectionStatus.FROZEN)
    ) {
      const lifecycleResult = await new ShopifySubscriptionLifecycleReconciliationService(
        this.database,
        undefined,
        undefined,
        runtimeConfig,
      ).reconcile(shopId, existing.id, snapshot, now);
      if (lifecycleResult === "handled" || lifecycleResult === "restored") {
        await this.scheduler.publishCommittedLifecycleSchedule(shopId, existing.id);
        if (lifecycleResult === "restored") {
          const restored = await this.database.subscription.findUnique({
            where: { id: existing.id },
            select: { billingPeriodId: true },
          });
          return { billingPeriodId: restored?.billingPeriodId ?? null, packMeterHandle: null };
        }
        return { billingPeriodId: existing.billingPeriodId, packMeterHandle: null };
      }
    }

    const pending = existing?.pendingPlanId && existing.pendingShopifyPlanHandle
      ? {
          pendingShopifyPlanHandle: existing.pendingShopifyPlanHandle,
          pendingPlanId: existing.pendingPlanId,
          pendingEffectiveAt: existing.pendingEffectiveAt,
        }
      : {
          pendingShopifyPlanHandle: null,
          pendingPlanId: null,
          pendingEffectiveAt: null,
        };

    if (existing) {
      const nextReconcileAt = new Date(
        now.getTime() + (runtimeConfig?.billingProviderRetrySeconds ?? 300) * 1000,
      );
      await this.database.subscription.updateMany({
        where: { id: existing.id, nextReconcileAt: existing.nextReconcileAt },
        data: { nextReconcileAt, lastSyncedAt: now },
      });
      return {
        billingPeriodId: existing.billingPeriodId,
        packMeterHandle: existing.plan?.shopifyRecoveryCreditPackEventHandle ?? null,
      };
    }

    await this.database.subscription.upsert({
      where: { shopId },
      update: {
        planId: null,
        observedShopifyPlanHandle: null,
        status: SubscriptionProjectionStatus.NO_CONTRACT,
        billingPeriodId: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        trialEndsAt: null,
        cancelAtPeriodEnd: false,
        providerSubscriptionId: null,
        lastSyncedAt: now,
        lastSyncErrorCode: null,
        lastSyncErrorAt: null,
        ...pending,
      },
      create: { shopId, status: SubscriptionProjectionStatus.NO_CONTRACT, lastSyncedAt: now },
    });
    return { billingPeriodId: null, packMeterHandle: null };
  }
}
