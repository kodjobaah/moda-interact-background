import {
  BillingPeriodStatus,
  BillingPlanKind,
  Prisma,
  ShopifyReportState,
  SubscriptionProjectionStatus,
  UsageMetric,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import {
  APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS,
  BILLING_SUBSCRIPTION_RECONCILE_JOB_NAME,
  createBillingSubscriptionReconcileJobId,
  deriveShopifyProviderContextIdentity,
} from "@modainteract/moda-interact-shared/billing";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";

import prisma from "../lib/db.js";
import { getSubscriptionReconciliationSnapshot, shopifyPartnerBillingApi, type PartnerSubscription, type PartnerSubscriptionReconciliationSnapshot, type ShopifyPartnerBillingProvider } from "../providers/shopify-partner-billing.provider.js";
import { recoveryCreditPurchaseService } from "./recovery-credit-purchase.service.js";
import { recoveryCapacityResumeService } from "./recovery-capacity-resume.service.js";
import { SamePlanBillingPeriodRolloverService } from "./same-plan-billing-period-rollover.service.js";
import { ShopifyPlanChangeTransitionService } from "./shopify-plan-change-transition.service.js";
import { ensureCurrentBillingPeriodProjection } from "./current-billing-period-projection.service.js";
import { shopifyUsageEventPublisherService } from "./shopify-usage-event-publisher.service.js";
import { createSubscriptionReconcilePayload } from "./billing-subscription-reconciliation.service.js";
import { BillingSubscriptionReconciliationService } from "./billing-subscription-reconciliation.service.js";
import { ShopifySubscriptionLifecycleReconciliationService } from "./shopify-subscription-lifecycle-reconciliation.service.js";
import type { BackgroundRuntimeConfigSnapshot } from "../runtime/background-runtime-config.js";

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
      environment: resolveDeploymentEnvironmentName(),
    }),
    private readonly now: () => Date = () => new Date(),
    private readonly subscriptionQueue?: SubscriptionQueue,
    private readonly discountQueue?: SubscriptionQueue,
  ) {}

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
      try {
        const snapshot = await getSubscriptionReconciliationSnapshot(this.partner, shop.shopifyShopId!);
        const projection = await this.applySubscription(shop.id, snapshot, runtimeConfig);
        result.subscriptionsSynced += 1;
        const purchaseReconciliation = await this.reconcilePackPurchases(shop.id, snapshot.activeSubscription, projection);
        result.purchasesActivated += purchaseReconciliation.activatedCount;
        if (purchaseReconciliation.discrepancy) {
          result.discrepancies.push({
            shopId: shop.id,
            billingPeriodId: purchaseReconciliation.discrepancy.billingPeriodId,
            meterHandle: purchaseReconciliation.discrepancy.packMeterHandle,
            modaQuantity: Number(purchaseReconciliation.discrepancy.alreadyMatchedUnits)
              + purchaseReconciliation.discrepancy.eligibleCandidateCount,
            shopifyQuantity: Number(purchaseReconciliation.discrepancy.providerUnits),
            kind: purchaseReconciliation.discrepancy.kind,
            ...(purchaseReconciliation.discrepancy.detail
              ? { detail: purchaseReconciliation.discrepancy.detail }
              : {}),
          });
          this.logger.warn("billing.recovery_credit_reconciliation.discrepancy", purchaseReconciliation.discrepancy);
        }
        const discrepancy = await this.compareUsage(shop.id, snapshot.activeSubscription);
        if (discrepancy) result.discrepancies.push(discrepancy);
      } catch (error) {
        result.subscriptionErrors += 1;
        await this.markSyncError(shop.id, error, runtimeConfig);
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
    if (!provider.currentPeriodStart
      || !provider.currentPeriodEnd
      || provider.currentPeriodEnd.getTime() <= provider.currentPeriodStart.getTime()) {
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
    if (!projection.billingPeriodId) {
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
          detail: "Exact current billing period is required",
        },
      };
    }
    const providerContextIdentity = deriveShopifyProviderContextIdentity({
      providerSubscriptionId: provider.providerSubscriptionId,
      planHandle: provider.planHandle,
      currentPeriodStart: provider.currentPeriodStart,
      currentPeriodEnd: provider.currentPeriodEnd,
    });
    const reconciliation = await this.purchases.reconcileProviderConfirmed({
      shopId,
      billingPeriodId: projection.billingPeriodId,
      providerPlanHandle: provider.planHandle,
      packMeterHandle: projection.packMeterHandle ?? "",
      providerContextIdentity,
      providerUnits: Number.NaN,
      providerCostAmount: null,
      providerCostCurrency: null,
      providerUsageSnapshot: provider.providerUsageSnapshot,
      currentPeriodStart: provider.currentPeriodStart,
      currentPeriodEnd: provider.currentPeriodEnd,
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

  private async applySubscription(shopId: string, snapshot: PartnerSubscriptionReconciliationSnapshot, runtimeConfig?: Pick<BackgroundRuntimeConfigSnapshot, "billingFrozenRecheckSeconds" | "billingProviderRetrySeconds">): Promise<{ billingPeriodId: string | null; packMeterHandle: string | null }> {
    const provider = snapshot.activeSubscription;
    const now = this.now();
    if (!provider) {
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
      if (existing && existing.status !== SubscriptionProjectionStatus.NO_CONTRACT
        && (snapshot.latestLifecycleEvent || existing.status === SubscriptionProjectionStatus.FROZEN)) {
        const lifecycleResult = await new ShopifySubscriptionLifecycleReconciliationService(this.database, undefined, undefined, runtimeConfig).reconcile(
          shopId,
          existing.id,
          snapshot,
          now,
        );
        if (lifecycleResult === "handled" || lifecycleResult === "restored") {
          await this.publishCommittedLifecycleSchedule(shopId, existing.id);
          if (lifecycleResult === "restored") {
            const restored = await this.database.subscription.findUnique({ where: { id: existing.id }, select: { billingPeriodId: true } });
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
        const nextReconcileAt = new Date(now.getTime() + (runtimeConfig?.billingProviderRetrySeconds ?? 300) * 1000);
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
    const existing = await this.database.subscription.findUnique({
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
      if (lifecycleResult === "handled" || lifecycleResult === "restored") {
        await this.publishCommittedLifecycleSchedule(shopId, existing.id);
        if (lifecycleResult === "restored") {
          const restored = await this.database.subscription.findUnique({ where: { id: existing.id }, select: { billingPeriodId: true } });
          return { billingPeriodId: restored?.billingPeriodId ?? null, packMeterHandle: null };
        }
        return { billingPeriodId: existing.billingPeriodId, packMeterHandle: null };
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
    if (
      existing?.id
      && existing.planId
      && existing.pendingPlanId
      && existing.pendingShopifyPlanHandle
      && existing.pendingEffectiveAt
      && existing.planId !== plan?.id
    ) {
      const currentPlan = await this.database.billingPlan.findUnique({
        where: { id: existing.planId },
        select: { id: true, active: true, name: true, kind: true, shopifyPlanHandle: true, shopifyUsageEventHandle: true, shopifyRecoveryCreditPackEventHandle: true, recoveryCreditPackEnabled: true, includedRecoveryConversationAllowance: true },
      });
      if (currentPlan && provider.planHandle === currentPlan.shopifyPlanHandle) {
        return { billingPeriodId: existing.billingPeriodId, packMeterHandle: currentPlan.shopifyRecoveryCreditPackEventHandle ?? null };
      }
      if (plan?.active && provider.planHandle === existing.pendingShopifyPlanHandle && plan.id === existing.pendingPlanId) {
        const sameCycle = existing.currentPeriodStart !== null
          && existing.currentPeriodEnd !== null
          && provider.currentPeriodStart?.getTime() === existing.currentPeriodStart.getTime()
          && provider.currentPeriodEnd?.getTime() === existing.currentPeriodEnd.getTime();
        if (sameCycle) {
          const nextReconcileAt = new Date(now.getTime() + 60 * 1000);
          const updated = await this.database.subscription.updateMany({
            where: { id: existing.id, planId: existing.planId, pendingPlanId: existing.pendingPlanId, pendingShopifyPlanHandle: existing.pendingShopifyPlanHandle, pendingEffectiveAt: existing.pendingEffectiveAt },
            data: { status: SubscriptionProjectionStatus.SYNC_ERROR, nextReconcileAt, lastSyncedAt: now, lastSyncErrorCode: "UNEXPECTED_IMMEDIATE_PLAN_CHANGE", lastSyncErrorAt: now },
          });
          if (updated.count > 0) await this.enqueueSubscriptionReconcile(shopId, existing.id, nextReconcileAt, now);
          return { billingPeriodId: existing.billingPeriodId, packMeterHandle: null };
        }
        if (now < existing.pendingEffectiveAt) {
          return { billingPeriodId: existing.billingPeriodId, packMeterHandle: null };
        }
        const recordPlanChangeFailure = async (errorCode: "MISSING_BILLING_CYCLE" | "MISSING_USAGE_METER" | "INVALID_INCLUDED_ALLOWANCE" | "UNEXPECTED_IMMEDIATE_PLAN_CHANGE") => {
          const nextReconcileAt = new Date(now.getTime() + 60 * 1000);
          const updated = await this.database.subscription.updateMany({
            where: { id: existing.id, planId: existing.planId, pendingPlanId: existing.pendingPlanId, pendingShopifyPlanHandle: existing.pendingShopifyPlanHandle, pendingEffectiveAt: existing.pendingEffectiveAt },
            data: { status: SubscriptionProjectionStatus.SYNC_ERROR, nextReconcileAt, lastSyncedAt: now, lastSyncErrorCode: errorCode, lastSyncErrorAt: now },
          });
          if (updated.count > 0) await this.enqueueSubscriptionReconcile(shopId, existing.id, nextReconcileAt, now);
        };
        const requiresExactCycle = plan.kind === BillingPlanKind.PAID_METERED
          || (plan.kind === BillingPlanKind.FREE && plan.recoveryCreditPackEnabled === true);
        if (requiresExactCycle && (!provider.currentPeriodStart || !provider.currentPeriodEnd || provider.currentPeriodStart >= provider.currentPeriodEnd)) {
          await recordPlanChangeFailure("MISSING_BILLING_CYCLE");
          return { billingPeriodId: existing.billingPeriodId, packMeterHandle: null };
        }
        if (plan.kind === BillingPlanKind.PAID_METERED && (!Number.isSafeInteger(plan.includedRecoveryConversationAllowance) || (plan.includedRecoveryConversationAllowance ?? -1) < 0)) {
          await recordPlanChangeFailure("INVALID_INCLUDED_ALLOWANCE");
          return { billingPeriodId: existing.billingPeriodId, packMeterHandle: null };
        }
        if (plan.kind === BillingPlanKind.PAID_METERED && (!plan.shopifyUsageEventHandle || !provider.usageEventHandles.includes(plan.shopifyUsageEventHandle))) {
          await recordPlanChangeFailure("MISSING_USAGE_METER");
          return { billingPeriodId: existing.billingPeriodId, packMeterHandle: null };
        }
        if (plan.recoveryCreditPackEnabled && (!plan.shopifyRecoveryCreditPackEventHandle || !provider.usageEventHandles.includes(plan.shopifyRecoveryCreditPackEventHandle))) {
          await recordPlanChangeFailure("MISSING_USAGE_METER");
          return { billingPeriodId: existing.billingPeriodId, packMeterHandle: null };
        }
        const transition = await new ShopifyPlanChangeTransitionService(this.database).transition({
          shopId,
          subscriptionId: existing.id,
          provider,
          plan,
          expectedCurrentPlanId: existing.planId,
          now,
        });
        if (transition.kind === "transitioned") {
          if (transition.nextReconcileAt) await this.enqueueSubscriptionReconcile(shopId, existing.id, transition.nextReconcileAt, now);
          if (transition.planKind === BillingPlanKind.PAID_METERED) {
            try {
              await recoveryCapacityResumeService.schedule({ shopId, trigger: "plan-change" });
            } catch (error) {
              this.logger.warn("billing.recovery_capacity_resume.enqueue_failed", {
                shopId,
                errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure",
              });
            }
          }
        }
        if (transition.kind === "not-applicable") {
          await recordPlanChangeFailure("UNEXPECTED_IMMEDIATE_PLAN_CHANGE");
          return { billingPeriodId: existing.billingPeriodId, packMeterHandle: null };
        }
        return { billingPeriodId: transition.billingPeriodId, packMeterHandle: transition.kind === "transitioned" ? plan.shopifyRecoveryCreditPackEventHandle ?? null : null };
      }
      if (!plan?.active) {
        await this.database.subscription.updateMany({
          where: { id: existing.id, planId: existing.planId, pendingPlanId: existing.pendingPlanId, pendingShopifyPlanHandle: existing.pendingShopifyPlanHandle, pendingEffectiveAt: existing.pendingEffectiveAt },
          data: { planId: null, status: SubscriptionProjectionStatus.UNMAPPED, observedShopifyPlanHandle: provider.planHandle, nextReconcileAt: null, lastSyncedAt: now, lastSyncErrorCode: "UNMAPPED_PLAN_HANDLE", lastSyncErrorAt: now },
        });
        return { billingPeriodId: existing.billingPeriodId, packMeterHandle: null };
      }
      const nextReconcileAt = new Date(now.getTime() + 60 * 1000);
      const updated = await this.database.subscription.updateMany({
        where: { id: existing.id, planId: existing.planId, pendingPlanId: existing.pendingPlanId, pendingShopifyPlanHandle: existing.pendingShopifyPlanHandle, pendingEffectiveAt: existing.pendingEffectiveAt },
        data: { status: SubscriptionProjectionStatus.SYNC_ERROR, observedShopifyPlanHandle: provider.planHandle, nextReconcileAt, lastSyncedAt: now, lastSyncErrorCode: "UNEXPECTED_IMMEDIATE_PLAN_CHANGE", lastSyncErrorAt: now },
      });
      if (updated.count > 0) await this.enqueueSubscriptionReconcile(shopId, existing.id, nextReconcileAt, now);
      return { billingPeriodId: existing.billingPeriodId, packMeterHandle: null };
    }
    if (existing?.id && plan?.active && existing.planId === plan.id) {
      const providerMatchesCurrentCycle = Boolean(
        provider.currentPeriodStart
        && provider.currentPeriodEnd
        && existing.currentPeriodStart
        && existing.currentPeriodEnd
        && provider.currentPeriodStart.getTime() === existing.currentPeriodStart.getTime()
        && provider.currentPeriodEnd.getTime() === existing.currentPeriodEnd.getTime(),
      );
      if (providerMatchesCurrentCycle && provider.currentPeriodEnd! > now) {
        const projection = await this.database.$transaction(async (transaction: Prisma.TransactionClient) => {
          await transaction.$queryRaw(Prisma.sql`
            SELECT "id"
            FROM "billing"."Subscription"
            WHERE "id" = ${existing.id}
            FOR UPDATE
          `);
          const current = await transaction.subscription.findUnique({
            where: { id: existing.id },
            select: {
              id: true,
              status: true,
              planId: true,
              billingPeriodId: true,
              currentPeriodStart: true,
              currentPeriodEnd: true,
              nextReconcileAt: true,
            },
          });
          if (!current
            || current.status !== existing.status
            || current.planId !== existing.planId
            || current.billingPeriodId !== existing.billingPeriodId
            || current.currentPeriodStart?.getTime() !== existing.currentPeriodStart?.getTime()
            || current.currentPeriodEnd?.getTime() !== existing.currentPeriodEnd?.getTime()
            || current.nextReconcileAt?.getTime() !== existing.nextReconcileAt?.getTime()) {
            return { kind: "stale" as const };
          }
          const result = await ensureCurrentBillingPeriodProjection(transaction, {
            shopId,
            subscriptionId: existing.id,
            periodStart: provider.currentPeriodStart!,
            periodEnd: provider.currentPeriodEnd!,
            providerPlanHandle: provider.planHandle,
            plan,
          });
          if (result.kind === "CONFLICT") {
            const nextReconcileAt = new Date(now.getTime() + 60 * 1000);
            await transaction.subscription.update({
              where: { id: existing.id },
              data: {
                status: SubscriptionProjectionStatus.SYNC_ERROR,
                lastSyncErrorCode: "BILLING_PERIOD_PLAN_CONFLICT",
                lastSyncErrorAt: now,
                lastSyncedAt: now,
                nextReconcileAt,
              },
            });
            return { kind: "conflict" as const, nextReconcileAt };
          }
          await transaction.subscription.update({
            where: { id: existing.id },
            data: {
              billingPeriodId: result.billingPeriodId,
              currentPeriodStart: provider.currentPeriodStart,
              currentPeriodEnd: provider.currentPeriodEnd,
              lastSyncedAt: now,
            },
          });
          return { kind: "ready" as const };
        });
        if (projection.kind === "conflict") {
          await this.enqueueSubscriptionReconcile(shopId, existing.id, projection.nextReconcileAt, now);
          return { billingPeriodId: existing.billingPeriodId, packMeterHandle: null };
        }
        if (projection.kind === "stale") return { billingPeriodId: existing.billingPeriodId, packMeterHandle: null };
      }
      if ((provider.pendingPlanHandle !== null || provider.cancelAtPeriodEnd || existing.cancelAtPeriodEnd)
        && provider.currentPeriodEnd
        && provider.currentPeriodEnd > now
        && provider.currentPeriodStart?.getTime() === existing.currentPeriodStart?.getTime()
        && provider.currentPeriodEnd?.getTime() === existing.currentPeriodEnd?.getTime()) {
        const pendingPlan = provider.pendingPlanHandle
          ? await this.database.billingPlan.findUnique({ where: { shopifyPlanHandle: provider.pendingPlanHandle }, select: { id: true, active: true } })
          : null;
        const next = provider.pendingPlanHandle && provider.pendingEffectiveAt
          ? provider.pendingEffectiveAt
          : provider.currentPeriodEnd
            ? now < new Date(provider.currentPeriodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS)
              ? new Date(provider.currentPeriodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS)
              : provider.currentPeriodEnd
            : null;
        const updated = await this.database.subscription.updateMany({
          where: { id: existing.id, planId: existing.planId, billingPeriodId: existing.billingPeriodId, nextReconcileAt: existing.nextReconcileAt },
          data: {
            pendingShopifyPlanHandle: provider.pendingPlanHandle,
            pendingPlanId: pendingPlan?.active ? pendingPlan.id : null,
            pendingEffectiveAt: provider.pendingEffectiveAt,
            cancelAtPeriodEnd: provider.pendingPlanHandle ? false : provider.cancelAtPeriodEnd,
            currentPeriodEnd: provider.currentPeriodEnd,
            nextReconcileAt: next,
            lastSyncedAt: now,
          },
        });
        if (updated.count > 0 && next) await this.enqueueSubscriptionReconcile(shopId, existing.id, next, now);
        return { billingPeriodId: existing.billingPeriodId, packMeterHandle: plan.shopifyRecoveryCreditPackEventHandle ?? null };
      }
      const result = await new SamePlanBillingPeriodRolloverService(this.database, async (rolloverInput, rolloverResult) => {
        if (rolloverResult.planKind !== BillingPlanKind.PAID_METERED) return;
        try {
          await recoveryCapacityResumeService.schedule({ shopId: rolloverInput.shopId, trigger: "billing-period-rollover" });
        } catch (error) {
          this.logger.warn("billing.recovery_capacity_resume.enqueue_failed", {
            shopId: rolloverInput.shopId,
            errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure",
          });
        }
      }).transition({
        shopId,
        subscriptionId: existing.id,
        provider,
        plan,
        now,
      });
      if (result.kind === "transitioned" || result.kind === "unchanged") {
        return {
          billingPeriodId: result.billingPeriodId,
          packMeterHandle: plan.shopifyRecoveryCreditPackEventHandle ?? null,
        };
      }
      if (
        result.kind === "provider-cycle-lag"
        && existing.billingPeriodId
        && existing.currentPeriodStart
        && existing.currentPeriodEnd
        && (
          plan.kind === BillingPlanKind.PAID_METERED
          || (plan.kind === BillingPlanKind.FREE && plan.recoveryCreditPackEnabled === true)
        )
      ) {
        const nextReconcileAt = new Date(now.getTime() + 60 * 1000);
        const updated = await this.database.subscription.updateMany({
          where: {
            id: existing.id,
            status: { in: [SubscriptionProjectionStatus.ACTIVE, SubscriptionProjectionStatus.TRIALING] },
            planId: existing.planId,
            billingPeriodId: existing.billingPeriodId,
            currentPeriodStart: existing.currentPeriodStart,
            currentPeriodEnd: existing.currentPeriodEnd,
            nextReconcileAt: existing.nextReconcileAt,
          },
          data: {
            nextReconcileAt,
            lastSyncedAt: now,
            lastSyncErrorCode: "PROVIDER_CYCLE_LAG",
            lastSyncErrorAt: now,
          },
        });
        if (updated.count > 0) {
          try {
            if (this.subscriptionQueue) {
              const job = createSubscriptionReconcilePayload(shopId, existing.id, nextReconcileAt);
              await this.subscriptionQueue.add(BILLING_SUBSCRIPTION_RECONCILE_JOB_NAME, job, {
                jobId: createBillingSubscriptionReconcileJobId(existing.id, nextReconcileAt.toISOString()),
                delay: 60 * 1000,
                removeOnComplete: 100,
                removeOnFail: true,
              });
            }
          } catch (error) {
            this.logger.warn("billing.subscription_reconciliation.enqueue_failed", {
              shopId,
              subscriptionId: existing.id,
              errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure",
            });
          }
        }
      }
      const current = await this.database.subscription.findUnique({
        where: { id: existing.id },
        select: { billingPeriodId: true },
      });
      return {
        billingPeriodId: current?.billingPeriodId ?? null,
        packMeterHandle: plan.shopifyRecoveryCreditPackEventHandle ?? null,
      };
    }
    const pendingPlan = provider.pendingPlanHandle
      ? await this.database.billingPlan.findUnique({
          where: { shopifyPlanHandle: provider.pendingPlanHandle },
          select: { id: true, active: true },
        })
      : null;
    let billingPeriodId: string | null = null;
    let projectionConflict: { subscriptionId: string; nextReconcileAt: Date } | null = null;
    if (planUsable && (status === SubscriptionProjectionStatus.ACTIVE || status === SubscriptionProjectionStatus.TRIALING)
      && plan && provider.currentPeriodStart && provider.currentPeriodEnd) {
      const projection = await this.database.$transaction(async (transaction: Prisma.TransactionClient) => {
        const current = await transaction.subscription.findUnique({ where: { shopId }, select: { id: true } });
        if (!current) return { kind: "stale" as const };
        const result = await ensureCurrentBillingPeriodProjection(transaction, {
          shopId,
          subscriptionId: current.id,
          periodStart: provider.currentPeriodStart!,
          periodEnd: provider.currentPeriodEnd!,
          providerPlanHandle: provider.planHandle,
          plan,
        });
        if (result.kind === "CONFLICT") {
          const nextReconcileAt = new Date(now.getTime() + 60 * 1000);
          await transaction.subscription.update({
            where: { id: current.id },
            data: { status: SubscriptionProjectionStatus.SYNC_ERROR, lastSyncErrorCode: "BILLING_PERIOD_PLAN_CONFLICT", lastSyncErrorAt: now, lastSyncedAt: now, nextReconcileAt },
          });
          return { kind: "conflict" as const, subscriptionId: current.id, nextReconcileAt };
        }
        await transaction.subscription.update({
          where: { id: current.id },
          data: {
            planId: plan.id,
            observedShopifyPlanHandle: provider.planHandle,
            status,
            billingPeriodId: result.billingPeriodId,
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
        return { kind: "ready" as const, billingPeriodId: result.billingPeriodId };
      });
      if (projection.kind === "conflict") {
          projectionConflict = { subscriptionId: projection.subscriptionId, nextReconcileAt: projection.nextReconcileAt };
      } else if (projection.kind === "ready") {
        billingPeriodId = projection.billingPeriodId;
      }
    } else {
      await this.database.subscription.upsert({
        where: { shopId },
        update: {
          planId: planUsable ? plan?.id ?? null : null,
          observedShopifyPlanHandle: provider.planHandle,
          status,
          billingPeriodId: null,
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
          billingPeriodId: null,
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
    if (projectionConflict) {
      await this.enqueueSubscriptionReconcile(shopId, projectionConflict.subscriptionId, projectionConflict.nextReconcileAt, now);
      return { billingPeriodId: null, packMeterHandle: null };
    }
    return {
      billingPeriodId,
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
    if (new Prisma.Decimal(modaQuantity).equals(new Prisma.Decimal(shopifyQuantity))) return null;
    const discrepancy = {
      shopId,
      billingPeriodId: subscription.billingPeriodId,
      meterHandle,
      modaQuantity,
      shopifyQuantity: Number(shopifyQuantity),
    };
    this.logger.warn("billing.usage_reconciliation.discrepancy", discrepancy);
    return discrepancy;
  }

  private async markSyncError(
    shopId: string,
    error: unknown,
    runtimeConfig?: Pick<BackgroundRuntimeConfigSnapshot, "billingFrozenRecheckSeconds" | "billingProviderRetrySeconds">,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error("billing.subscription_reconciliation.error", { shopId, error: message });
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
        lastSyncErrorCode: "PARTNER_API_ERROR",
        lastSyncErrorAt: now,
        lastSyncedAt: now,
        nextReconcileAt,
      },
    });
    if (updated.count > 0) await this.enqueueSubscriptionReconcile(shopId, subscription.id, nextReconcileAt, now);
  }

  private async enqueueSubscriptionReconcile(shopId: string, subscriptionId: string, nextReconcileAt: Date, now: Date): Promise<void> {
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

  private async publishCommittedLifecycleSchedule(shopId: string, subscriptionId: string): Promise<void> {
    const current = await this.database.subscription.findUnique({ where: { id: subscriptionId }, select: { nextReconcileAt: true } });
    if (current?.nextReconcileAt) await this.enqueueSubscriptionReconcile(shopId, subscriptionId, current.nextReconcileAt, this.now());
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