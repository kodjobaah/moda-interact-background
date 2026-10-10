import {
  BillingPlanKind,
  ShopPlatform,
  SubscriptionProjectionStatus,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";

import prisma from "../lib/db.js";
import { getSubscriptionReconciliationSnapshot, shopifyPartnerBillingApi, type PartnerSubscriptionReconciliationSnapshot, type ShopifyPartnerBillingProvider } from "../providers/shopify-partner-billing.provider.js";
import { recoveryCreditPurchaseService } from "./recovery-credit-purchase.service.js";
import { shopifyUsageEventPublisherService } from "./shopify-usage-event-publisher.service.js";
import { BillingSubscriptionReconciliationService } from "./billing-subscription-reconciliation.service.js";
import { ShopifySubscriptionLifecycleReconciliationService } from "./shopify-subscription-lifecycle-reconciliation.service.js";
import type { BackgroundRuntimeConfigSnapshot } from "../runtime/background-runtime-config.js";
import {
  ProviderUsageReconciliationService,
  type UsageDiscrepancy,
} from "./billing-reconciliation/provider-usage-reconciliation.service.js";
import {
  BillingReconciliationSchedulerService,
  type BillingReconciliationErrorCode,
} from "./billing-reconciliation/reconciliation-scheduler.service.js";
import { ProviderAbsenceReconciliationService } from "./billing-reconciliation/provider-absence-reconciliation.service.js";
import { EstablishedPlanObservationService } from "./billing-reconciliation/established-plan-observation.service.js";
import { SamePlanCurrentCycleReconciliationService } from "./billing-reconciliation/same-plan-current-cycle-reconciliation.service.js";
import { SamePlanPeriodProgressionService } from "./billing-reconciliation/same-plan-period-progression.service.js";
import { GenericSubscriptionProjectionService } from "./billing-reconciliation/generic-subscription-projection.service.js";
import { classifyObservedPlanProjection } from "./billing-reconciliation/observed-plan-projection.js";

export type { UsageDiscrepancy } from "./billing-reconciliation/provider-usage-reconciliation.service.js";

const MAX_SHOP_PAGE_SIZE = 200;

type BillingReconciliationDatabase = PrismaClient;
type UsagePublisher = Pick<typeof shopifyUsageEventPublisherService, "publishDue">;
type PurchaseReconciler = Pick<typeof recoveryCreditPurchaseService, "reconcileProviderConfirmed">;
type SubscriptionQueue = Pick<Queue, "add">;
export type BillingReconciliationResult = {
  published: Awaited<ReturnType<UsagePublisher["publishDue"]>>;
  purchasesActivated: number;
  subscriptionsScanned: number;
  subscriptionsSynced: number;
  subscriptionErrors: number;
  discrepancies: UsageDiscrepancy[];
};

export class BillingReconciliationService {
  private lastScannedShopId: string | undefined;

  private readonly providerUsageReconciliation: ProviderUsageReconciliationService;
  private readonly reconciliationScheduler: BillingReconciliationSchedulerService;
  private readonly providerAbsenceReconciliation: ProviderAbsenceReconciliationService;
  private readonly establishedPlanObservation: EstablishedPlanObservationService;
  private readonly samePlanCurrentCycleReconciliation: SamePlanCurrentCycleReconciliationService;
  private readonly samePlanPeriodProgression: SamePlanPeriodProgressionService;
  private readonly genericSubscriptionProjection: GenericSubscriptionProjectionService;

  constructor(
    private readonly database: BillingReconciliationDatabase = prisma,
    private readonly partner: ShopifyPartnerBillingProvider = shopifyPartnerBillingApi,
    private readonly publisher: UsagePublisher = shopifyUsageEventPublisherService,
    purchases: PurchaseReconciler = recoveryCreditPurchaseService,
    private readonly logger: StructuredLogger = createLogger({
      serviceName: "moda-billing-worker",
      environment: resolveDeploymentEnvironmentName(),
    }),
    private readonly now: () => Date = () => new Date(),
    private readonly subscriptionQueue?: SubscriptionQueue,
    private readonly discountQueue?: SubscriptionQueue,
  ) {
    this.providerUsageReconciliation = new ProviderUsageReconciliationService(
      this.database,
      purchases,
      this.logger,
    );
    this.reconciliationScheduler = new BillingReconciliationSchedulerService(
      this.database,
      this.subscriptionQueue,
      this.logger,
      this.now,
    );
    this.providerAbsenceReconciliation = new ProviderAbsenceReconciliationService(
      this.database,
      this.reconciliationScheduler,
    );
    this.establishedPlanObservation = new EstablishedPlanObservationService(
      this.database,
      this.reconciliationScheduler,
      this.logger,
    );
    this.samePlanCurrentCycleReconciliation = new SamePlanCurrentCycleReconciliationService(
      this.database,
      this.reconciliationScheduler,
      this.logger,
    );
    this.samePlanPeriodProgression = new SamePlanPeriodProgressionService(
      this.database,
      this.reconciliationScheduler,
      this.logger,
    );
    this.genericSubscriptionProjection = new GenericSubscriptionProjectionService(
      this.database,
      this.reconciliationScheduler,
      this.logger,
    );
  }

  async reconcileOnce(runtimeConfigOrShopBatchSize?: Pick<BackgroundRuntimeConfigSnapshot, "billingReconciliationShopBatchSize" | "shopifyUsagePublishBatchSize" | "shopifyUsageRetryBaseSeconds" | "shopifyUsageRetryMaxSeconds" | "billingFrozenRecheckSeconds" | "billingProviderRetrySeconds"> | number): Promise<BillingReconciliationResult> {
    const runtimeConfig = typeof runtimeConfigOrShopBatchSize === "number" ? undefined : runtimeConfigOrShopBatchSize;
    const shopBatchSize = typeof runtimeConfigOrShopBatchSize === "number"
      ? runtimeConfigOrShopBatchSize
      : runtimeConfig?.billingReconciliationShopBatchSize ?? 50;
    const published = await this.publisher.publishDue(runtimeConfig ? { runtimeConfig } : {});
    const shops = await this.selectRotatingShopPage(boundedLimit(shopBatchSize));

    const result: BillingReconciliationResult = {
      published,
      purchasesActivated: 0,
      subscriptionsScanned: shops.length,
      subscriptionsSynced: 0,
      subscriptionErrors: 0,
      discrepancies: [],
    };
    for (const shop of shops) {
      let errorCode: BillingReconciliationErrorCode = "PARTNER_API_ERROR";
      try {
        const snapshot = await getSubscriptionReconciliationSnapshot(this.partner, shop.shopifyShopId!);
        errorCode = "INTERNAL_RECONCILIATION_ERROR";
        const projection = await this.applySubscription(shop.id, snapshot, runtimeConfig);
        result.subscriptionsSynced += 1;
        const providerUsage = await this.providerUsageReconciliation.reconcile(
          shop.id,
          snapshot.activeSubscription,
          projection,
        );
        result.purchasesActivated += providerUsage.purchasesActivated;
        result.discrepancies.push(...providerUsage.discrepancies);
      } catch (error) {
        result.subscriptionErrors += 1;
        await this.reconciliationScheduler.markSyncError(shop.id, errorCode, error, runtimeConfig);
      }
    }
    return result;
  }


  private async selectRotatingShopPage(limit: number) {
    const baseQuery = {
      where: {
        platform: ShopPlatform.SHOPIFY,
        shopifyShopId: { not: null },
        status: "ACTIVE" as const,
      },
      orderBy: { id: "asc" as const },
      take: limit,
      select: { id: true, shopifyShopId: true },
    };
    const afterCursor = this.lastScannedShopId
      ? await this.database.shop.findMany({
          ...baseQuery,
          where: { ...baseQuery.where, id: { gt: this.lastScannedShopId } },
        })
      : [];
    const shops = afterCursor.length > 0
      ? afterCursor
      : await this.database.shop.findMany(baseQuery);

    const lastShop = shops.at(-1);
    if (lastShop) this.lastScannedShopId = lastShop.id;
    return shops;
  }

  private async applySubscription(shopId: string, snapshot: PartnerSubscriptionReconciliationSnapshot, runtimeConfig?: Pick<BackgroundRuntimeConfigSnapshot, "billingFrozenRecheckSeconds" | "billingProviderRetrySeconds">): Promise<{ billingPeriodId: string | null; packMeterHandle: string | null }> {
    const provider = snapshot.activeSubscription;
    const now = this.now();
    if (!provider) {
      return this.providerAbsenceReconciliation.reconcile(shopId, snapshot, now, runtimeConfig);
    }

    const plan = await this.database.billingPlan.findUnique({
      where: { shopifyPlanHandle: provider.planHandle },
      select: {
        id: true,
        active: true,
        name: true,
        kind: true,
        shopifyPlanHandle: true,
        shopifyUsageEventHandle: true,
        shopifyRecoveryCreditPackEventHandle: true,
        recoveryCreditPackEnabled: true,
        includedRecoveryConversationAllowance: true,
      },
    });
    let existing = await this.database.subscription.findUnique({
      where: { shopId },
      select: {
        id: true,
        status: true,
        planId: true,
        pendingPlanId: true,
        pendingShopifyPlanHandle: true,
        pendingEffectiveAt: true,
        billingPeriodId: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        cancelAtPeriodEnd: true,
        nextReconcileAt: true,
      },
    });
    if (existing && existing.status !== SubscriptionProjectionStatus.NO_CONTRACT
      && (snapshot.latestLifecycleEvent || existing.status === SubscriptionProjectionStatus.FROZEN)) {
      const lifecycleResult = await new ShopifySubscriptionLifecycleReconciliationService(this.database, undefined, undefined, runtimeConfig).reconcile(
        shopId,
        existing.id,
        snapshot,
        now,
      );
      if (lifecycleResult === "handled") {
        await this.reconciliationScheduler.publishCommittedLifecycleSchedule(shopId, existing.id);
        return { billingPeriodId: existing.billingPeriodId, packMeterHandle: null };
      }
      if (lifecycleResult === "restored") {
        await this.reconciliationScheduler.publishCommittedLifecycleSchedule(shopId, existing.id);
        const restored = await this.database.subscription.findUnique({
          where: { shopId },
          select: {
            id: true,
            status: true,
            planId: true,
            pendingPlanId: true,
            pendingShopifyPlanHandle: true,
            pendingEffectiveAt: true,
            billingPeriodId: true,
            currentPeriodStart: true,
            currentPeriodEnd: true,
            cancelAtPeriodEnd: true,
            nextReconcileAt: true,
          },
        });
        if (!restored) return { billingPeriodId: null, packMeterHandle: null };
        existing = restored;
      }
    }
    if (
      existing?.status === SubscriptionProjectionStatus.NO_CONTRACT
      && existing.planId === null
      && existing.pendingPlanId !== null
      && plan?.active
      && plan.kind === BillingPlanKind.PAID_METERED
      && plan.id === existing.pendingPlanId
      && (
        provider.planHandle !== existing.pendingShopifyPlanHandle
        || plan.shopifyPlanHandle !== existing.pendingShopifyPlanHandle
      )
    ) {
      return { billingPeriodId: null, packMeterHandle: null };
    }
    if (
      existing?.status === SubscriptionProjectionStatus.NO_CONTRACT
      && existing.planId === null
      && existing.pendingPlanId !== null
      && existing.pendingShopifyPlanHandle === provider.planHandle
    ) {
      if (plan?.active && plan.id === existing.pendingPlanId && plan.kind === BillingPlanKind.PAID_METERED) {
        await new BillingSubscriptionReconciliationService(
          this.database,
          this.partner,
          this.subscriptionQueue,
          this.logger,
          this.now,
          undefined,
          this.discountQueue,
        ).activateInitialPaid(
          shopId,
          existing.id,
          provider,
          plan,
          {
            subscriptionId: existing.id,
            pendingPlanId: existing.pendingPlanId,
            pendingShopifyPlanHandle: existing.pendingShopifyPlanHandle,
            pendingEffectiveAt: existing.pendingEffectiveAt!,
            nextReconcileAt: existing.nextReconcileAt,
          },
        );
      }
      return { billingPeriodId: null, packMeterHandle: null };
    }
    const projection = classifyObservedPlanProjection(provider, plan);
    const establishedPlanResult = await this.establishedPlanObservation.reconcile({
      shopId,
      provider,
      observedPlan: plan,
      existing,
      now,
    });
    if (establishedPlanResult.kind === "handled") {
      return {
        billingPeriodId: establishedPlanResult.billingPeriodId,
        packMeterHandle: establishedPlanResult.packMeterHandle,
      };
    }
    if (existing?.id && plan?.active && existing.planId === plan.id) {
      const samePlanInput = { shopId, provider, plan, existing, now };
      const currentCycleResult = await this.samePlanCurrentCycleReconciliation.reconcile({
        ...samePlanInput,
        status: projection.status,
        syncErrorCode: projection.syncErrorCode,
      });
      if (currentCycleResult.kind === "handled") {
        return {
          billingPeriodId: currentCycleResult.billingPeriodId,
          packMeterHandle: currentCycleResult.packMeterHandle,
        };
      }
      return this.samePlanPeriodProgression.reconcile(samePlanInput);
    }
    return this.genericSubscriptionProjection.reconcile({
      shopId,
      provider,
      plan,
      existing,
      projection,
      now,
    });
  }


}

export function createBillingReconciliationService(subscriptionQueue?: SubscriptionQueue, discountQueue?: SubscriptionQueue): BillingReconciliationService {
  return new BillingReconciliationService(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    subscriptionQueue,
    discountQueue,
  );
}

function boundedLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_SHOP_PAGE_SIZE) {
    throw new Error("Billing reconciliation shop batch size is outside the database range.");
  }
  return value;
}

export const billingReconciliationService = createBillingReconciliationService();
