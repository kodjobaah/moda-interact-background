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
type PurchaseReconciler = Pick<typeof recoveryCreditPurchaseService, "reconcileProviderConfirmed">;

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
  kind?: "under" | "over" | "ambiguous" | "invalid-provider-units" | "invalid-scope";
  detail?: string;
};

export class BillingReconciliationService {
  private lastScannedShopId: string | undefined;

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
    const shops = await this.selectRotatingShopPage(boundedLimit(limit));

    const result: BillingReconciliationResult = {
      published,
      purchasesActivated: 0,
      subscriptionsScanned: shops.length,
      subscriptionsSynced: 0,
      subscriptionErrors: 0,
      discrepancies: [],
    };
    for (const shop of shops) {
      try {
        const subscription = await this.partner.getActiveSubscription(shop.shopifyShopId!);
        const projection = await this.applySubscription(shop.id, subscription);
        result.subscriptionsSynced += 1;
        const purchaseReconciliation = await this.reconcilePackPurchases(shop.id, subscription, projection);
        result.purchasesActivated += purchaseReconciliation.activatedCount;
        if (purchaseReconciliation.discrepancy) {
          result.discrepancies.push({
            shopId: shop.id,
            billingPeriodId: purchaseReconciliation.discrepancy.billingPeriodId,
            meterHandle: purchaseReconciliation.discrepancy.packMeterHandle,
            modaQuantity: purchaseReconciliation.discrepancy.alreadyMatchedUnits
              + purchaseReconciliation.discrepancy.eligibleCandidateCount,
            shopifyQuantity: purchaseReconciliation.discrepancy.providerUnits,
            kind: purchaseReconciliation.discrepancy.kind,
            ...(purchaseReconciliation.discrepancy.detail
              ? { detail: purchaseReconciliation.discrepancy.detail }
              : {}),
          });
          this.logger.warn("billing.recovery_credit_reconciliation.discrepancy", purchaseReconciliation.discrepancy);
        }
        const discrepancy = await this.compareUsage(shop.id, subscription);
        if (discrepancy) result.discrepancies.push(discrepancy);
      } catch (error) {
        result.subscriptionErrors += 1;
        await this.markSyncError(shop.id, error);
      }
    }
    return result;
  }

  private async reconcilePackPurchases(
    shopId: string,
    provider: PartnerSubscription | null,
    projection: { billingPeriodId: string | null; packMeterHandle: string | null },
  ) {
    if (!provider) {
      return { activatedCount: 0, discrepancy: null };
    }
    if (!provider.currentPeriodStart || !provider.currentPeriodEnd) {
      return {
        activatedCount: 0,
        discrepancy: {
          kind: "invalid-scope" as const,
          shopId,
          billingPeriodId: projection.billingPeriodId ?? "",
          providerPlanHandle: provider.planHandle,
          packMeterHandle: projection.packMeterHandle ?? "",
          providerUnits: 0,
          alreadyMatchedUnits: 0,
          eligibleCandidateCount: 0,
          confirmedDelta: 0,
          detail: "Present Partner subscription has no exact current billing cycle",
        },
      };
    }
    const packMeterHandle = projection.packMeterHandle;
    if (!packMeterHandle || !projection.billingPeriodId) {
      return {
        activatedCount: 0,
        discrepancy: {
          kind: "invalid-scope" as const,
          shopId,
          billingPeriodId: projection.billingPeriodId ?? "",
          providerPlanHandle: provider.planHandle,
          packMeterHandle: packMeterHandle ?? "",
          providerUnits: 0,
          alreadyMatchedUnits: 0,
          eligibleCandidateCount: 0,
          confirmedDelta: 0,
          detail: "Exact current billing period and pack meter are required",
        },
      };
    }
    const providerUnits = provider.providerUsageSnapshot.find((usage) => usage.handle === packMeterHandle)?.quantity;
    const reconciliation = await this.purchases.reconcileProviderConfirmed({
      shopId,
      billingPeriodId: projection.billingPeriodId,
      providerPlanHandle: provider.planHandle,
      packMeterHandle,
      providerUnits: providerUnits ?? Number.NaN,
    });
    return reconciliation;
  }

  private async selectRotatingShopPage(limit: number) {
    const baseQuery = {
      where: {
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

  private async applySubscription(shopId: string, provider: PartnerSubscription | null): Promise<{ billingPeriodId: string | null; packMeterHandle: string | null }> {
    const now = this.now();
    if (!provider) {
      const existing = await this.database.subscription.findUnique({
        where: { shopId },
        select: {
          pendingShopifyPlanHandle: true,
          pendingPlanId: true,
          pendingEffectiveAt: true,
        },
      });
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

    const plan = await this.database.billingPlan.findUnique({
      where: { shopifyPlanHandle: provider.planHandle },
      select: {
        id: true,
        active: true,
        kind: true,
        shopifyUsageEventHandle: true,
        shopifyRecoveryCreditPackEventHandle: true,
      },
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
            subscriptionId: (await this.database.subscription.findUniqueOrThrow({ where: { shopId }, select: { id: true } })).id,
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
    return {
      billingPeriodId: billingPeriod?.id ?? null,
      packMeterHandle: plan?.active ? plan.shopifyRecoveryCreditPackEventHandle ?? null : null,
    };
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
        lastSyncErrorCode: "PARTNER_API_ERROR",
        lastSyncErrorAt: this.now(),
      },
      create: {
        shopId,
        status: SubscriptionProjectionStatus.NO_CONTRACT,
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