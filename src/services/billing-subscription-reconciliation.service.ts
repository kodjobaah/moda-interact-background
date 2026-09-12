import {
  APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS,
  BILLING_SUBSCRIPTION_RECONCILE_JOB_NAME,
  BILLING_SUBSCRIPTION_RECONCILE_QUEUE_NAME,
  BILLING_SUBSCRIPTION_RECONCILE_SCHEMA_VERSION,
  createBillingSubscriptionReconcileJobId,
  parseBillingSubscriptionReconcileJob,
  type BillingSubscriptionReconcileJob,
} from "@modainteract/moda-interact-shared/billing";
import { BillingPeriodStatus, BillingPlanKind, SubscriptionProjectionStatus } from "@prisma/client";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";

import prisma from "../lib/db.js";
import { shopifyPartnerBillingApi, type PartnerSubscription, type ShopifyPartnerBillingProvider } from "../providers/shopify-partner-billing.provider.js";

const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const FREE_CYCLE_DISCOVERY_RETRY_MS = 5 * 60 * 1000;
const RETRY_TIERS = [
  { ageMs: 10 * 60 * 1000, delayMs: 60 * 1000 },
  { ageMs: 60 * 60 * 1000, delayMs: 5 * 60 * 1000 },
  { ageMs: RETRY_WINDOW_MS, delayMs: 30 * 60 * 1000 },
] as const;

type SubscriptionQueue = Pick<Queue, "add">;
type BillingDatabase = PrismaClient;

export function nextSubscriptionReconcileAt(pendingEffectiveAt: Date, now = new Date()): Date | null {
  const ageMs = Math.max(0, now.getTime() - pendingEffectiveAt.getTime());
  const tier = RETRY_TIERS.find(({ ageMs: tierAge }) => ageMs < tierAge);
  return tier ? new Date(now.getTime() + tier.delayMs) : null;
}

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

export class BillingSubscriptionReconciliationService {
  constructor(
    private readonly database: BillingDatabase = prisma,
    private readonly partner: ShopifyPartnerBillingProvider = shopifyPartnerBillingApi,
    private readonly queue?: SubscriptionQueue,
    private readonly logger: StructuredLogger = createLogger({
      serviceName: "moda-billing-worker",
      environment: process.env.NODE_ENV ?? "development",
    }),
    private readonly now: () => Date = () => new Date(),
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
        status: "ACTIVE",
        subscription: {
            OR: [
              { pendingPlanId: { not: null }, nextReconcileAt: { not: null } },
              { status: "FROZEN", nextReconcileAt: { not: null } },
              {
                status: { in: [SubscriptionProjectionStatus.ACTIVE, SubscriptionProjectionStatus.TRIALING] },
                planId: { not: null },
                billingPeriodId: null,
                pendingPlanId: null,
                pendingShopifyPlanHandle: null,
                nextReconcileAt: { not: null },
                plan: { is: { active: true, kind: BillingPlanKind.FREE, recoveryCreditPackEnabled: true } },
              },
            ],
        },
      },
      select: {
        id: true,
        subscription: { select: { id: true, nextReconcileAt: true } },
      },
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
    return enqueued;
  }

  async reconcileJob(input: unknown): Promise<void> {
    const job = parseBillingSubscriptionReconcileJob(input);
    const row = await this.database.shop.findUnique({
      where: { id: job.shopId },
      select: {
        id: true,
        status: true,
        shopifyShopId: true,
        settings: { select: { onboardingCompleted: true } },
        subscription: {
          select: {
            id: true,
            status: true,
            planId: true,
            pendingPlanId: true,
            pendingShopifyPlanHandle: true,
            pendingEffectiveAt: true,
            nextReconcileAt: true,
            billingPeriodId: true,
          },
        },
      },
    });
    if (!row || row.status !== "ACTIVE" || !row.subscription || !row.shopifyShopId) return;
    const isInitialActivation = row.settings?.onboardingCompleted === false
      && row.subscription.status === SubscriptionProjectionStatus.NO_CONTRACT
      && row.subscription.planId === null
      && row.subscription.pendingPlanId !== null
      && row.subscription.pendingShopifyPlanHandle !== null
      && row.subscription.nextReconcileAt !== null;
    const isCycleDiscovery = row.settings?.onboardingCompleted === true
      && (row.subscription.status === SubscriptionProjectionStatus.ACTIVE || row.subscription.status === SubscriptionProjectionStatus.TRIALING)
      && row.subscription.planId !== null
      && row.subscription.billingPeriodId === null
      && row.subscription.pendingPlanId === null
      && row.subscription.pendingShopifyPlanHandle === null
      && row.subscription.pendingEffectiveAt === null
      && row.subscription.nextReconcileAt !== null;
    if (
      row.subscription.id !== job.subscriptionId
      || (!isInitialActivation && !isCycleDiscovery)
      || !row.subscription.nextReconcileAt
      || row.subscription.nextReconcileAt.toISOString() !== job.expectedNextReconcileAt
    ) return;

    const expected = {
      subscriptionId: row.subscription.id,
      pendingPlanId: row.subscription.pendingPlanId,
      pendingShopifyPlanHandle: row.subscription.pendingShopifyPlanHandle,
      pendingEffectiveAt: row.subscription.pendingEffectiveAt,
      nextReconcileAt: row.subscription.nextReconcileAt,
    };
    const currentPlan = isCycleDiscovery && row.subscription.planId
      ? await this.database.billingPlan.findUnique({
          where: { id: row.subscription.planId },
          select: { id: true, active: true, name: true, kind: true, shopifyPlanHandle: true, recoveryCreditPackEnabled: true, shopifyUsageEventHandle: true },
        })
      : null;
    if (isCycleDiscovery && (!currentPlan || !currentPlan.active || currentPlan.kind !== BillingPlanKind.FREE || !currentPlan.recoveryCreditPackEnabled)) return;

    let provider: PartnerSubscription | null;
    try {
      provider = await this.partner.getActiveSubscription(row.shopifyShopId);
    } catch (error) {
      if (isCycleDiscovery && currentPlan) {
        await this.recordCycleDiscoveryFailure(row.id, expected, error);
      } else {
        await this.recordProviderFailure(row.id, expected, error);
      }
      return;
    }

    if (!provider) {
      if (isCycleDiscovery) {
        await this.recordMissingCycle(row.id, expected);
      } else {
        await this.recordMissingSubscription(row.id, expected);
      }
      return;
    }

    if (isCycleDiscovery && currentPlan) {
      await this.reconcileFreeCycle(row.id, expected, provider, currentPlan);
      return;
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
        recoveryCreditPackEnabled: true,
        shopifyRecoveryCreditPackEventHandle: true,
      },
    });
      if (plan?.active && plan.id === row.subscription.pendingPlanId && plan.kind === BillingPlanKind.FREE) {
        await this.completeVerifiedFree(
          row.id,
          row.subscription.id,
          provider,
          plan.id,
          plan.recoveryCreditPackEnabled,
          row.subscription.pendingEffectiveAt,
          job.expectedNextReconcileAt,
          plan.name,
          expected,
        );
      return;
    }

    await this.applyOtherCurrentPlan(
      row.id,
      row.subscription.id,
      provider,
      plan,
      row.subscription.pendingShopifyPlanHandle!,
      job.expectedNextReconcileAt,
      expected,
    );
  }

  private async recordMissingSubscription(shopId: string, expected: {
    subscriptionId: string;
    pendingPlanId: string | null;
    pendingShopifyPlanHandle: string | null;
    pendingEffectiveAt: Date | null;
    nextReconcileAt: Date;
  }): Promise<void> {
    const now = this.now();
    const next = expected.pendingEffectiveAt ? nextSubscriptionReconcileAt(expected.pendingEffectiveAt, now) : null;
    const updated = await this.casPendingUpdate(expected, {
      status: SubscriptionProjectionStatus.NO_CONTRACT,
      lastSyncedAt: now,
      lastSyncErrorCode: null,
      lastSyncErrorAt: null,
      ...(next ? { nextReconcileAt: next } : {
        pendingShopifyPlanHandle: null,
        pendingPlanId: null,
        pendingEffectiveAt: null,
        nextReconcileAt: null,
      }),
    });
    if (updated && next) await this.publishNext(shopId, expected.subscriptionId, next);
  }

  private async recordProviderFailure(shopId: string, expected: {
    subscriptionId: string;
    pendingPlanId: string | null;
    pendingShopifyPlanHandle: string | null;
    pendingEffectiveAt: Date | null;
    nextReconcileAt: Date;
  }, error: unknown): Promise<void> {
    const now = this.now();
    const next = expected.pendingEffectiveAt ? nextSubscriptionReconcileAt(expected.pendingEffectiveAt, now) : null;
    this.logger.error("billing.subscription_reconciliation.provider_failed", {
      shopId,
      subscriptionId: expected.subscriptionId,
      errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure",
    });
    const updated = await this.casPendingUpdate(expected, {
        lastSyncErrorCode: "PARTNER_API_ERROR",
        lastSyncErrorAt: now,
        ...(next ? { nextReconcileAt: next } : { pendingShopifyPlanHandle: null, pendingPlanId: null, pendingEffectiveAt: null, nextReconcileAt: null }),
    });
    if (updated && next) await this.publishNext(shopId, expected.subscriptionId, next);
  }

  private async casPendingUpdate(
    expected: {
      subscriptionId: string;
      pendingPlanId: string | null;
      pendingShopifyPlanHandle: string | null;
      pendingEffectiveAt: Date | null;
      nextReconcileAt: Date;
    },
    data: Prisma.SubscriptionUpdateManyMutationInput,
  ): Promise<boolean> {
    const result = await this.database.subscription.updateMany({
      where: {
        id: expected.subscriptionId,
        status: SubscriptionProjectionStatus.NO_CONTRACT,
        planId: null,
        pendingPlanId: expected.pendingPlanId,
        pendingShopifyPlanHandle: expected.pendingShopifyPlanHandle,
        pendingEffectiveAt: expected.pendingEffectiveAt,
        nextReconcileAt: expected.nextReconcileAt,
      },
      data,
    });
    return result.count > 0;
  }

  private async publishNext(shopId: string, subscriptionId: string, next: Date): Promise<void> {
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

  private async recordMissingCycle(shopId: string, expected: {
    subscriptionId: string;
    pendingPlanId: string | null;
    pendingShopifyPlanHandle: string | null;
    pendingEffectiveAt: Date | null;
    nextReconcileAt: Date;
  }): Promise<void> {
    const next = new Date(this.now().getTime() + FREE_CYCLE_DISCOVERY_RETRY_MS);
    const result = await this.database.subscription.updateMany({
      where: {
        id: expected.subscriptionId,
        status: { in: [SubscriptionProjectionStatus.ACTIVE, SubscriptionProjectionStatus.TRIALING] },
        planId: { not: null },
        billingPeriodId: null,
        pendingPlanId: null,
        pendingShopifyPlanHandle: null,
        pendingEffectiveAt: null,
        nextReconcileAt: expected.nextReconcileAt,
      },
      data: { nextReconcileAt: next, lastSyncedAt: this.now(), lastSyncErrorCode: null, lastSyncErrorAt: null },
    });
    if (result.count > 0) await this.publishNext(shopId, expected.subscriptionId, next);
  }

  private async recordCycleDiscoveryFailure(shopId: string, expected: {
    subscriptionId: string;
    pendingPlanId: string | null;
    pendingShopifyPlanHandle: string | null;
    pendingEffectiveAt: Date | null;
    nextReconcileAt: Date;
  }, error: unknown): Promise<void> {
    const next = new Date(this.now().getTime() + FREE_CYCLE_DISCOVERY_RETRY_MS);
    this.logger.error("billing.subscription_reconciliation.provider_failed", {
      shopId,
      subscriptionId: expected.subscriptionId,
      errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure",
    });
    const result = await this.database.subscription.updateMany({
      where: {
        id: expected.subscriptionId,
        status: { in: [SubscriptionProjectionStatus.ACTIVE, SubscriptionProjectionStatus.TRIALING] },
        planId: { not: null },
        billingPeriodId: null,
        pendingPlanId: null,
        pendingShopifyPlanHandle: null,
        pendingEffectiveAt: null,
        nextReconcileAt: expected.nextReconcileAt,
      },
      data: { nextReconcileAt: next, lastSyncErrorCode: "PARTNER_API_ERROR", lastSyncErrorAt: this.now() },
    });
    if (result.count > 0) await this.publishNext(shopId, expected.subscriptionId, next);
  }

  private async reconcileFreeCycle(
    shopId: string,
    expected: { subscriptionId: string; pendingPlanId: string | null; pendingShopifyPlanHandle: string | null; pendingEffectiveAt: Date | null; nextReconcileAt: Date },
    provider: PartnerSubscription,
    plan: { id: string; active: boolean; name: string; kind: BillingPlanKind; shopifyPlanHandle: string; recoveryCreditPackEnabled: boolean; shopifyUsageEventHandle: string | null },
  ): Promise<void> {
    if (provider.planHandle !== plan.shopifyPlanHandle || !provider.currentPeriodStart || !provider.currentPeriodEnd) {
      await this.recordMissingCycle(shopId, expected);
      return;
    }
    const now = this.now();
    const periodStart = provider.currentPeriodStart!;
    const periodEnd = provider.currentPeriodEnd!;
    const next = new Date(Math.max(now.getTime(), provider.currentPeriodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS));
    const committed = await this.database.$transaction(async (transaction: Prisma.TransactionClient) => {
      const current = await transaction.subscription.findUnique({
        where: { id: expected.subscriptionId },
        select: { status: true, planId: true, billingPeriodId: true, pendingPlanId: true, pendingShopifyPlanHandle: true, pendingEffectiveAt: true, nextReconcileAt: true },
      });
      if (!current || (current.status !== SubscriptionProjectionStatus.ACTIVE && current.status !== SubscriptionProjectionStatus.TRIALING) || current.planId !== plan.id || current.billingPeriodId !== null || current.pendingPlanId !== null || current.pendingShopifyPlanHandle !== null || current.pendingEffectiveAt !== null || current.nextReconcileAt?.toISOString() !== expected.nextReconcileAt.toISOString()) return false;
      const billingPeriod = await transaction.billingPeriod.upsert({
        where: { shopId_periodStart_periodEnd: { shopId, periodStart, periodEnd } },
        update: {},
        create: { shopId, subscriptionId: expected.subscriptionId, planId: plan.id, shopifyPlanHandleSnapshot: provider.planHandle, planNameSnapshot: plan.name, planKindSnapshot: BillingPlanKind.FREE, periodStart, periodEnd, includedRecoveryCreditsGranted: null },
      });
      await transaction.subscription.update({
        where: { id: expected.subscriptionId },
        data: { billingPeriodId: billingPeriod.id, currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, providerSubscriptionId: provider.providerSubscriptionId, trialEndsAt: provider.trialEndsAt, cancelAtPeriodEnd: provider.cancelAtPeriodEnd, nextReconcileAt: next, lastSyncedAt: now, lastSyncErrorCode: null, lastSyncErrorAt: null },
      });
      return true;
    });
    if (committed) await this.publishNext(shopId, expected.subscriptionId, next);
  }

  private async completeVerifiedFree(
    shopId: string,
    subscriptionId: string,
    provider: PartnerSubscription,
    planId: string,
    recoveryCreditPackEnabled: boolean,
    pendingEffectiveAt: Date | null,
    expectedNextReconcileAt: string,
    planName: string,
    expected: {
      subscriptionId: string;
      pendingPlanId: string | null;
      pendingShopifyPlanHandle: string | null;
      pendingEffectiveAt: Date | null;
      nextReconcileAt: Date;
    },
  ): Promise<void> {
    const now = this.now();
    const nextReconcileAt = recoveryCreditPackEnabled
      ? provider.currentPeriodEnd
        ? new Date(Math.max(now.getTime(), provider.currentPeriodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS))
        : pendingEffectiveAt
          ? nextSubscriptionReconcileAt(pendingEffectiveAt, now)
          : null
      : null;
    await this.database.$transaction(async (transaction: Prisma.TransactionClient) => {
      const current = await transaction.subscription.findUnique({
        where: { id: subscriptionId },
        select: { status: true, planId: true, pendingPlanId: true, pendingShopifyPlanHandle: true, pendingEffectiveAt: true, nextReconcileAt: true },
      });
      if (
        !current
        || current.status !== SubscriptionProjectionStatus.NO_CONTRACT
        || current.planId !== null
        || current.pendingPlanId !== expected.pendingPlanId
        || current.pendingShopifyPlanHandle !== expected.pendingShopifyPlanHandle
        || current.pendingEffectiveAt?.toISOString() !== expected.pendingEffectiveAt?.toISOString()
        || current.nextReconcileAt?.toISOString() !== expected.nextReconcileAt.toISOString()
      ) return;
      const lifetimeCounter = await transaction.shopEntitlementCounter.findUnique({ where: { shopId_counter: { shopId, counter: "FREE_RECOVERY_LIFETIME" } }, select: { id: true } });
      const policy = lifetimeCounter
        ? null
        : await transaction.platformBillingPolicy.findUnique({ where: { id: "default" }, select: { lifetimeFreeRecoveryAllowance: true } });
      if (!lifetimeCounter && !policy) throw new Error("PlatformBillingPolicy.default is required for first lifetime Free grant");
      const billingPeriod = provider.currentPeriodStart && provider.currentPeriodEnd
        ? await transaction.billingPeriod.upsert({
            where: { shopId_periodStart_periodEnd: { shopId, periodStart: provider.currentPeriodStart, periodEnd: provider.currentPeriodEnd } },
            update: {},
            create: {
              shopId,
              subscriptionId,
              planId,
              shopifyPlanHandleSnapshot: provider.planHandle,
              planNameSnapshot: planName,
              planKindSnapshot: BillingPlanKind.FREE,
              periodStart: provider.currentPeriodStart,
              periodEnd: provider.currentPeriodEnd,
              includedRecoveryCreditsGranted: null,
            },
          })
        : null;
      await transaction.subscription.update({
        where: { id: subscriptionId },
        data: {
          planId,
          observedShopifyPlanHandle: provider.planHandle,
          status: provider.status === "TRIALING" ? SubscriptionProjectionStatus.TRIALING : SubscriptionProjectionStatus.ACTIVE,
          billingPeriodId: billingPeriod?.id ?? null,
          currentPeriodStart: provider.currentPeriodStart,
          currentPeriodEnd: provider.currentPeriodEnd,
          trialEndsAt: provider.trialEndsAt,
          cancelAtPeriodEnd: provider.cancelAtPeriodEnd,
          providerSubscriptionId: provider.providerSubscriptionId,
          pendingShopifyPlanHandle: null,
          pendingPlanId: null,
          pendingEffectiveAt: null,
          nextReconcileAt,
          lastSyncedAt: now,
          lastSyncErrorCode: null,
          lastSyncErrorAt: null,
        },
      });
      await transaction.shopSettings.update({ where: { shopId }, data: { onboardingCompleted: true } });
      if (!lifetimeCounter) {
        if (!policy) throw new Error("PlatformBillingPolicy.default is required for first lifetime Free grant");
        await transaction.shopEntitlementCounter.upsert({
          where: { shopId_counter: { shopId, counter: "FREE_RECOVERY_LIFETIME" } },
          update: {},
          create: { shopId, counter: "FREE_RECOVERY_LIFETIME", grantedQuantity: policy.lifetimeFreeRecoveryAllowance },
        });
      }
    });
    if (nextReconcileAt) await this.publishNext(shopId, subscriptionId, nextReconcileAt);
  }

  private async applyOtherCurrentPlan(
    shopId: string,
    subscriptionId: string,
    provider: PartnerSubscription,
    plan: { id: string; active: boolean; name: string; kind: BillingPlanKind; shopifyUsageEventHandle: string | null } | null,
    pendingShopifyPlanHandle: string,
    expectedNextReconcileAt: string,
    expected: {
      subscriptionId: string;
      pendingPlanId: string | null;
      pendingShopifyPlanHandle: string | null;
      pendingEffectiveAt: Date | null;
      nextReconcileAt: Date;
    },
  ): Promise<void> {
    const now = this.now();
    const planUsable = Boolean(plan?.active);
    const meterUsable = plan?.kind !== BillingPlanKind.PAID_METERED
      || Boolean(plan.shopifyUsageEventHandle && provider.usageEventHandles.includes(plan.shopifyUsageEventHandle));
    const status = !planUsable
      ? SubscriptionProjectionStatus.UNMAPPED
      : !meterUsable
        ? SubscriptionProjectionStatus.SYNC_ERROR
        : provider.status === "TRIALING" ? SubscriptionProjectionStatus.TRIALING : SubscriptionProjectionStatus.ACTIVE;
    await this.database.$transaction(async (transaction: Prisma.TransactionClient) => {
      const current = await transaction.subscription.findUnique({ where: { id: subscriptionId }, select: { status: true, planId: true, pendingPlanId: true, pendingShopifyPlanHandle: true, pendingEffectiveAt: true, nextReconcileAt: true } });
      if (!current || current.status !== SubscriptionProjectionStatus.NO_CONTRACT || current.planId !== null || current.pendingPlanId !== expected.pendingPlanId || current.pendingShopifyPlanHandle !== expected.pendingShopifyPlanHandle || current.pendingEffectiveAt?.toISOString() !== expected.pendingEffectiveAt?.toISOString() || current.nextReconcileAt?.toISOString() !== expected.nextReconcileAt.toISOString()) return;
      const billingPeriod = provider.currentPeriodStart && provider.currentPeriodEnd
        ? await transaction.billingPeriod.upsert({
            where: { shopId_periodStart_periodEnd: { shopId, periodStart: provider.currentPeriodStart, periodEnd: provider.currentPeriodEnd } },
            update: {},
            create: { shopId, subscriptionId, planId: planUsable ? plan?.id ?? null : null, shopifyPlanHandleSnapshot: provider.planHandle, planNameSnapshot: plan?.name ?? null, planKindSnapshot: plan?.kind ?? null, periodStart: provider.currentPeriodStart, periodEnd: provider.currentPeriodEnd },
          })
        : null;
      const pendingPlan = provider.pendingPlanHandle
        ? await transaction.billingPlan.findUnique({ where: { shopifyPlanHandle: provider.pendingPlanHandle }, select: { id: true, active: true } })
        : null;
      await transaction.subscription.update({ where: { id: subscriptionId }, data: { planId: planUsable ? plan?.id ?? null : null, observedShopifyPlanHandle: provider.planHandle, status, billingPeriodId: billingPeriod?.id ?? null, currentPeriodStart: provider.currentPeriodStart, currentPeriodEnd: provider.currentPeriodEnd, trialEndsAt: provider.trialEndsAt, cancelAtPeriodEnd: provider.cancelAtPeriodEnd, providerSubscriptionId: provider.providerSubscriptionId, pendingShopifyPlanHandle: provider.pendingPlanHandle, pendingPlanId: pendingPlan?.active ? pendingPlan.id : null, pendingEffectiveAt: provider.pendingEffectiveAt, nextReconcileAt: null, lastSyncedAt: now, lastSyncErrorCode: status === SubscriptionProjectionStatus.UNMAPPED ? "UNMAPPED_PLAN_HANDLE" : status === SubscriptionProjectionStatus.SYNC_ERROR ? "MISSING_USAGE_METER" : null, lastSyncErrorAt: status === SubscriptionProjectionStatus.ACTIVE || status === SubscriptionProjectionStatus.TRIALING ? null : now } });
    });
  }
}

export const billingSubscriptionReconciliationService = new BillingSubscriptionReconciliationService();

export { APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS };