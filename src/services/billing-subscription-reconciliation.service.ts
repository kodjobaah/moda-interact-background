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
      removeOnFail: 100,
    });
  }

  async reconstruct(): Promise<number> {
    const rows = await this.database.shop.findMany({
      where: {
        status: "ACTIVE",
        subscription: {
          pendingPlanId: { not: null },
          nextReconcileAt: { not: null },
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
          },
        },
      },
    });
    if (!row || row.status !== "ACTIVE" || !row.subscription || !row.shopifyShopId) return;
    if (
      row.subscription.id !== job.subscriptionId
      || !row.subscription.pendingPlanId
      || !row.subscription.pendingShopifyPlanHandle
      || !row.subscription.nextReconcileAt
      || row.subscription.nextReconcileAt.toISOString() !== job.expectedNextReconcileAt
    ) return;

    let provider: PartnerSubscription | null;
    try {
      provider = await this.partner.getActiveSubscription(row.shopifyShopId);
    } catch (error) {
      await this.recordProviderFailure(row.id, row.subscription.id, row.subscription.pendingEffectiveAt, error);
      return;
    }

    if (!provider) {
      await this.recordMissingSubscription(row.id, row.subscription.id, row.subscription.pendingEffectiveAt);
      return;
    }

    const plan = await this.database.billingPlan.findUnique({
      where: { shopifyPlanHandle: provider.planHandle },
      select: {
        id: true,
        active: true,
        kind: true,
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
        );
      return;
    }

    await this.database.subscription.update({
      where: { id: row.subscription.id },
      data: {
        observedShopifyPlanHandle: provider.planHandle,
        lastSyncedAt: this.now(),
        lastSyncErrorCode: null,
        lastSyncErrorAt: null,
        pendingShopifyPlanHandle: provider.planHandle === row.subscription.pendingShopifyPlanHandle ? row.subscription.pendingShopifyPlanHandle : null,
        pendingPlanId: provider.planHandle === row.subscription.pendingShopifyPlanHandle ? row.subscription.pendingPlanId : null,
        pendingEffectiveAt: provider.planHandle === row.subscription.pendingShopifyPlanHandle ? row.subscription.pendingEffectiveAt : null,
        nextReconcileAt: null,
      },
    });
  }

  private async recordMissingSubscription(shopId: string, subscriptionId: string, pendingEffectiveAt: Date | null): Promise<void> {
    const now = this.now();
    const next = pendingEffectiveAt ? nextSubscriptionReconcileAt(pendingEffectiveAt, now) : null;
    await this.database.subscription.update({
      where: { id: subscriptionId },
      data: next ? {
        status: SubscriptionProjectionStatus.NO_CONTRACT,
        lastSyncedAt: now,
        lastSyncErrorCode: null,
        lastSyncErrorAt: null,
        nextReconcileAt: next,
      } : {
        status: SubscriptionProjectionStatus.NO_CONTRACT,
        lastSyncedAt: now,
        lastSyncErrorCode: null,
        lastSyncErrorAt: null,
        pendingShopifyPlanHandle: null,
        pendingPlanId: null,
        pendingEffectiveAt: null,
        nextReconcileAt: null,
      },
    });
    if (next) await this.publishNext(shopId, subscriptionId, next);
  }

  private async recordProviderFailure(shopId: string, subscriptionId: string, pendingEffectiveAt: Date | null, error: unknown): Promise<void> {
    const now = this.now();
    const next = pendingEffectiveAt ? nextSubscriptionReconcileAt(pendingEffectiveAt, now) : null;
    this.logger.error("billing.subscription_reconciliation.provider_failed", {
      shopId,
      subscriptionId,
      errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure",
    });
    await this.database.subscription.update({
      where: { id: subscriptionId },
      data: {
        lastSyncErrorCode: "PARTNER_API_ERROR",
        lastSyncErrorAt: now,
        ...(next ? { nextReconcileAt: next } : { pendingShopifyPlanHandle: null, pendingPlanId: null, pendingEffectiveAt: null, nextReconcileAt: null }),
      },
    });
    if (next) await this.publishNext(shopId, subscriptionId, next);
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

  private async completeVerifiedFree(
    shopId: string,
    subscriptionId: string,
    provider: PartnerSubscription,
    planId: string,
    recoveryCreditPackEnabled: boolean,
    pendingEffectiveAt: Date | null,
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
      const billingPeriod = provider.currentPeriodStart && provider.currentPeriodEnd
        ? await transaction.billingPeriod.upsert({
            where: { shopId_periodStart_periodEnd: { shopId, periodStart: provider.currentPeriodStart, periodEnd: provider.currentPeriodEnd } },
            update: { subscriptionId, planId, planKindSnapshot: BillingPlanKind.FREE, status: BillingPeriodStatus.OPEN, includedRecoveryCreditsGranted: null },
            create: { shopId, subscriptionId, planId, planKindSnapshot: BillingPlanKind.FREE, periodStart: provider.currentPeriodStart, periodEnd: provider.currentPeriodEnd, includedRecoveryCreditsGranted: null },
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
      const policy = await transaction.platformBillingPolicy.findUnique({ where: { id: "default" }, select: { lifetimeFreeRecoveryAllowance: true } });
      await transaction.shopEntitlementCounter.upsert({
        where: { shopId_counter: { shopId, counter: "FREE_RECOVERY_LIFETIME" } },
        update: {},
        create: { shopId, counter: "FREE_RECOVERY_LIFETIME", grantedQuantity: policy?.lifetimeFreeRecoveryAllowance ?? 5 },
      });
    });
    if (nextReconcileAt) await this.publishNext(shopId, subscriptionId, nextReconcileAt);
  }
}

export const billingSubscriptionReconciliationService = new BillingSubscriptionReconciliationService();

export { APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS };