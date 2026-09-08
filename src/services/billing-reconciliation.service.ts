import {
  BillingPeriodStatus,
  BillingPlanKind,
  Prisma,
  ShopifyReportState,
  SubscriptionProjectionStatus,
  UsageMetric,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";

import prisma from "../lib/db.js";
import { shopifyPartnerBillingApi, type PartnerSubscription, type ShopifyPartnerBillingProvider } from "../providers/shopify-partner-billing.provider.js";
import { recoveryCreditPurchaseService } from "./recovery-credit-purchase.service.js";
import { shopifyUsageEventPublisherService } from "./shopify-usage-event-publisher.service.js";

const DEFAULT_SHOP_PAGE_SIZE = 50;
const MAX_SHOP_PAGE_SIZE = 200;

type BillingReconciliationDatabase = PrismaClient;
type UsagePublisher = Pick<typeof shopifyUsageEventPublisherService, "publishDue">;
type PurchaseReconciler = Pick<typeof recoveryCreditPurchaseService, "reconcilePending">;

export type BillingReconciliationResult = {
  published: Awaited<ReturnType<UsagePublisher["publishDue"]>>;
  purchasesActivated: number;
  subscriptionsScanned: number;
  subscriptionsSynced: number;
  subscriptionErrors: number;
  discrepancies: UsageDiscrepancy[];
};

export type UsageDiscrepancy = {
  shopId: string;
  billingPeriodId: string;
  meterHandle: string;
  modaQuantity: number;
  shopifyQuantity: number;
};

export class BillingReconciliationService {
  constructor(
    private readonly database: BillingReconciliationDatabase = prisma,
    private readonly partner: ShopifyPartnerBillingProvider = shopifyPartnerBillingApi,
    private readonly publisher: UsagePublisher = shopifyUsageEventPublisherService,
    private readonly purchases: PurchaseReconciler = recoveryCreditPurchaseService,
    private readonly logger: StructuredLogger = createLogger({
      serviceName: "moda-billing-worker",
      environment: process.env.NODE_ENV ?? "development",
    }),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reconcileOnce(limit = DEFAULT_SHOP_PAGE_SIZE): Promise<BillingReconciliationResult> {
    const published = await this.publisher.publishDue();
    const purchaseResults = await this.purchases.reconcilePending();
    const shops = await this.database.shop.findMany({
      where: {
        shopifyShopId: { not: null },
        status: "ACTIVE",
      },
      orderBy: { id: "asc" },
      take: boundedLimit(limit),
      select: { id: true, shopifyShopId: true },
    });

    const result: BillingReconciliationResult = {
      published,
      purchasesActivated: purchaseResults.filter((entry) => entry.result.kind === "activated").length,
      subscriptionsScanned: shops.length,
      subscriptionsSynced: 0,
      subscriptionErrors: 0,
      discrepancies: [],
    };
    for (const shop of shops) {
      try {
        const subscription = await this.partner.getActiveSubscription(shop.shopifyShopId!);
        await this.applySubscription(shop.id, subscription);
        result.subscriptionsSynced += 1;
        const discrepancy = await this.compareUsage(shop.id, subscription);
        if (discrepancy) result.discrepancies.push(discrepancy);
      } catch (error) {
        result.subscriptionErrors += 1;
        await this.markSyncError(shop.id, error);
      }
    }
    return result;
  }

  private async applySubscription(shopId: string, provider: PartnerSubscription | null): Promise<void> {
    const now = this.now();
    if (!provider) {
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
          pendingShopifyPlanHandle: null,
          pendingPlanId: null,
          pendingEffectiveAt: null,
        },
        create: { shopId, status: SubscriptionProjectionStatus.NO_CONTRACT, lastSyncedAt: now },
      });
      return;
    }

    const plan = await this.database.billingPlan.findUnique({
      where: { shopifyPlanHandle: provider.planHandle },
      select: { id: true, active: true, kind: true, shopifyUsageEventHandle: true },
    });
    const planUsable = Boolean(plan?.active);
    const meterUsable = plan?.kind !== BillingPlanKind.PAID_METERED ||
      Boolean(plan?.shopifyUsageEventHandle && provider.usageEventHandles.includes(plan.shopifyUsageEventHandle));
    const status = !planUsable
      ? SubscriptionProjectionStatus.UNMAPPED
      : !meterUsable
        ? SubscriptionProjectionStatus.SYNC_ERROR
        : provider.status === "TRIALING"
          ? SubscriptionProjectionStatus.TRIALING
          : SubscriptionProjectionStatus.ACTIVE;
    const syncErrorCode = status === SubscriptionProjectionStatus.UNMAPPED
      ? "UNMAPPED_PLAN_HANDLE"
      : status === SubscriptionProjectionStatus.SYNC_ERROR
        ? "MISSING_USAGE_METER"
        : null;
    const billingPeriod = provider.currentPeriodStart && provider.currentPeriodEnd
      ? await this.database.billingPeriod.upsert({
          where: {
            shopId_periodStart_periodEnd: {
              shopId,
              periodStart: provider.currentPeriodStart,
              periodEnd: provider.currentPeriodEnd,
            },
          },
          update: { status: BillingPeriodStatus.OPEN },
          create: {
            shopId,
            periodStart: provider.currentPeriodStart,
            periodEnd: provider.currentPeriodEnd,
            status: BillingPeriodStatus.OPEN,
          },
        })
      : null;
    const pendingPlan = provider.pendingPlanHandle
      ? await this.database.billingPlan.findUnique({
          where: { shopifyPlanHandle: provider.pendingPlanHandle },
          select: { id: true, active: true },
        })
      : null;
    await this.database.subscription.upsert({
      where: { shopId },
      update: {
        planId: planUsable ? plan?.id ?? null : null,
        observedShopifyPlanHandle: provider.planHandle,
        status,
        billingPeriodId: billingPeriod?.id ?? null,
        currentPeriodStart: provider.currentPeriodStart,
        currentPeriodEnd: provider.currentPeriodEnd,
        trialEndsAt: provider.trialEndsAt,
        cancelAtPeriodEnd: provider.cancelAtPeriodEnd,
        providerSubscriptionId: provider.providerSubscriptionId,
        lastSyncedAt: now,
        lastSyncErrorCode: syncErrorCode,
        lastSyncErrorAt: syncErrorCode ? now : null,
        pendingShopifyPlanHandle: provider.pendingPlanHandle,
        pendingPlanId: pendingPlan?.active ? pendingPlan.id : null,
        pendingEffectiveAt: provider.pendingEffectiveAt,
      },
      create: {
        shopId,
        planId: planUsable ? plan?.id ?? null : null,
        observedShopifyPlanHandle: provider.planHandle,
        status,
        billingPeriodId: billingPeriod?.id ?? null,
        currentPeriodStart: provider.currentPeriodStart,
        currentPeriodEnd: provider.currentPeriodEnd,
        trialEndsAt: provider.trialEndsAt,
        cancelAtPeriodEnd: provider.cancelAtPeriodEnd,
        providerSubscriptionId: provider.providerSubscriptionId,
        lastSyncedAt: now,
        lastSyncErrorCode: syncErrorCode,
        lastSyncErrorAt: syncErrorCode ? now : null,
        pendingShopifyPlanHandle: provider.pendingPlanHandle,
        pendingPlanId: pendingPlan?.active ? pendingPlan.id : null,
        pendingEffectiveAt: provider.pendingEffectiveAt,
      },
    });
  }

  private async compareUsage(shopId: string, provider: PartnerSubscription | null): Promise<UsageDiscrepancy | null> {
    if (!provider?.currentPeriodStart || !provider.currentPeriodEnd) return null;
    const subscription = await this.database.subscription.findUnique({
      where: { shopId },
      select: { billingPeriodId: true, plan: { select: { kind: true, shopifyUsageEventHandle: true } } },
    });
    const meterHandle = subscription?.plan?.kind === BillingPlanKind.PAID_METERED
      ? subscription.plan.shopifyUsageEventHandle
      : null;
    if (!subscription?.billingPeriodId || !meterHandle) return null;
    const shopifyQuantity = provider.providerUsageSnapshot.find((usage) => usage.handle === meterHandle)?.quantity;
    if (shopifyQuantity === null || shopifyQuantity === undefined) return null;
    const modaQuantity = Number((await this.database.usageEvent.aggregate({
      where: {
        shopId,
        billingPeriodId: subscription.billingPeriodId,
        metric: UsageMetric.RECOVERY_CONVERSATION,
        shopifyEventHandle: meterHandle,
        shopifyReportState: ShopifyReportState.REPORTED,
      },
      _sum: { quantity: true },
    }))._sum.quantity ?? 0);
    if (modaQuantity === shopifyQuantity) return null;
    const discrepancy = {
      shopId,
      billingPeriodId: subscription.billingPeriodId,
      meterHandle,
      modaQuantity,
      shopifyQuantity,
    };
    this.logger.warn("billing.usage_reconciliation.discrepancy", discrepancy);
    return discrepancy;
  }

  private async markSyncError(shopId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error("billing.subscription_reconciliation.error", { shopId, error: message });
    await this.database.subscription.upsert({
      where: { shopId },
      update: {
        status: SubscriptionProjectionStatus.SYNC_ERROR,
        lastSyncErrorCode: "PARTNER_API_ERROR",
        lastSyncErrorAt: this.now(),
      },
      create: {
        shopId,
        status: SubscriptionProjectionStatus.SYNC_ERROR,
        lastSyncErrorCode: "PARTNER_API_ERROR",
        lastSyncErrorAt: this.now(),
      },
    });
  }
}

function boundedLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1) return DEFAULT_SHOP_PAGE_SIZE;
  return Math.min(value, MAX_SHOP_PAGE_SIZE);
}

export const billingReconciliationService = new BillingReconciliationService();