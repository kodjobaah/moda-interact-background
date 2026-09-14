import {
  APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS,
  BILLING_SUBSCRIPTION_RECONCILE_JOB_NAME,
  BILLING_SUBSCRIPTION_RECONCILE_QUEUE_NAME,
  BILLING_SUBSCRIPTION_RECONCILE_SCHEMA_VERSION,
  createBillingSubscriptionReconcileJobId,
  parseBillingSubscriptionReconcileJob,
  type BillingSubscriptionReconcileJob,
} from "@modainteract/moda-interact-shared/billing";
import { BillingPeriodEntitlementCounterKind, BillingPeriodStatus, BillingPlanKind, SubscriptionProjectionStatus } from "@prisma/client";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";

import prisma from "../lib/db.js";
import { getSubscriptionReconciliationSnapshot, shopifyPartnerBillingApi, type PartnerSubscription, type PartnerSubscriptionReconciliationSnapshot, type ShopifyPartnerBillingProvider } from "../providers/shopify-partner-billing.provider.js";
import { recoveryCapacityResumeService } from "./recovery-capacity-resume.service.js";
import { shopifyUsageEventPublisherService } from "./shopify-usage-event-publisher.service.js";
import { SamePlanBillingPeriodRolloverService } from "./same-plan-billing-period-rollover.service.js";
import { ShopifyPlanChangeTransitionService, type ShopifyPlanChangePlan } from "./shopify-plan-change-transition.service.js";
import { ShopifySubscriptionLifecycleReconciliationService } from "./shopify-subscription-lifecycle-reconciliation.service.js";

const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const FREE_CYCLE_DISCOVERY_RETRY_MS = 5 * 60 * 1000;
export const ROLLOVER_RETRY_MS = 60 * 1000;
const RETRY_TIERS = [
  { ageMs: 10 * 60 * 1000, delayMs: 60 * 1000 },
  { ageMs: 60 * 60 * 1000, delayMs: 5 * 60 * 1000 },
  { ageMs: RETRY_WINDOW_MS, delayMs: 30 * 60 * 1000 },
] as const;
const RETRYABLE_PLAN_CHANGE_SYNC_ERRORS = [
  "UNEXPECTED_IMMEDIATE_PLAN_CHANGE",
  "MISSING_BILLING_CYCLE",
  "MISSING_USAGE_METER",
  "INVALID_INCLUDED_ALLOWANCE",
] as const;

function sameDate(left: Date | null, right: Date | null): boolean {
  return left === null && right === null
    || left !== null && right !== null && left.getTime() === right.getTime();
}

type SubscriptionQueue = Pick<Queue, "add">;
type BillingDatabase = PrismaClient;
type InitialActivationExpected = {
  subscriptionId: string;
  pendingPlanId: string;
  pendingShopifyPlanHandle: string;
  pendingEffectiveAt: Date;
  nextReconcileAt: Date | null;
};
export type InitialActivationPlan = {
  id: string;
  active: boolean;
  name: string;
  kind: BillingPlanKind;
  shopifyPlanHandle: string;
  shopifyUsageEventHandle: string | null;
  includedRecoveryConversationAllowance: number | null;
};
type FreeCycleExpected = {
  subscriptionId: string;
  currentPlanId: string;
  nextReconcileAt: Date;
};
type RolloverExpected = {
  subscriptionId: string;
  currentPlanId: string;
  billingPeriodId: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  nextReconcileAt: Date;
};
type EstablishedPlanChangeExpected = {
  subscriptionId: string;
  currentPlanId: string;
  pendingPlanId: string;
  pendingShopifyPlanHandle: string;
  pendingEffectiveAt: Date;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  billingPeriodId: string | null;
  nextReconcileAt: Date;
};

type ReinstallExpected = {
  subscriptionId: string;
  nextReconcileAt: Date;
  reinstallPendingAt: Date;
};

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

  async activateInitialPaid(
    shopId: string,
    subscriptionId: string,
    provider: PartnerSubscription,
    plan: InitialActivationPlan,
    expected: InitialActivationExpected,
  ): Promise<void> {
    await this.completeVerifiedPaid(shopId, subscriptionId, provider, plan, expected);
  }

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
        AND: [
          { OR: [
            { status: "ACTIVE" },
            { status: "UNINSTALLED", reinstallPendingAt: { not: null } },
          ] },
          { OR: [
          { subscription: { is: { pendingPlanId: { not: null }, nextReconcileAt: { not: null } } } },
          { subscription: { is: { status: "FROZEN", nextReconcileAt: { not: null } } } },
          {
            settings: { is: { onboardingCompleted: true } },
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
    const rowResult = await this.database.shop.findUnique({
      where: { id: job.shopId },
      select: {
        id: true,
        status: true,
        reinstallPendingAt: true,
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
            currentPeriodStart: true,
            currentPeriodEnd: true,
            cancelAtPeriodEnd: true,
            lastSyncErrorCode: true,
          },
        },
      },
    });
    const row = rowResult;
    if (!row || !row.subscription || !row.shopifyShopId) return;
    if (row.status === "UNINSTALLED") {
      if (row.reinstallPendingAt == null || row.subscription.nextReconcileAt === null) return;
      if (row.subscription.id !== job.subscriptionId) return;
      if (row.subscription.nextReconcileAt.toISOString() !== job.expectedNextReconcileAt) return;
      await this.reconcileReinstall(row.id, row.subscription.id, row.reinstallPendingAt, row.subscription.nextReconcileAt, row.shopifyShopId);
      return;
    }
    if (row.status !== "ACTIVE") return;
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
    const isRollover = row.settings?.onboardingCompleted === true
      && (row.subscription.status === SubscriptionProjectionStatus.ACTIVE || row.subscription.status === SubscriptionProjectionStatus.TRIALING)
      && row.subscription.planId !== null
      && row.subscription.billingPeriodId !== null
      && row.subscription.pendingPlanId === null
      && row.subscription.pendingShopifyPlanHandle === null
      && row.subscription.pendingEffectiveAt === null
      && row.subscription.nextReconcileAt !== null;
    const isFrozenReconciliation = row.settings?.onboardingCompleted === true
      && row.subscription.status === SubscriptionProjectionStatus.FROZEN
      && row.subscription.planId !== null
      && row.subscription.nextReconcileAt !== null;
    const isEstablishedPlanChange = row.settings?.onboardingCompleted === true
      && (
        row.subscription.status === SubscriptionProjectionStatus.ACTIVE
        || row.subscription.status === SubscriptionProjectionStatus.TRIALING
        || (row.subscription.status === SubscriptionProjectionStatus.SYNC_ERROR
          && RETRYABLE_PLAN_CHANGE_SYNC_ERRORS.includes(row.subscription.lastSyncErrorCode as typeof RETRYABLE_PLAN_CHANGE_SYNC_ERRORS[number]))
      )
      && row.subscription.planId !== null
      && row.subscription.pendingPlanId !== null
      && row.subscription.pendingShopifyPlanHandle !== null
      && row.subscription.pendingEffectiveAt !== null
      && row.subscription.nextReconcileAt !== null;
    if (
      row.subscription.id !== job.subscriptionId
      || (!isInitialActivation && !isCycleDiscovery && !isRollover && !isEstablishedPlanChange && !isFrozenReconciliation)
      || !row.subscription.nextReconcileAt
      || row.subscription.nextReconcileAt.toISOString() !== job.expectedNextReconcileAt
    ) return;

    const expected: InitialActivationExpected | FreeCycleExpected | RolloverExpected | EstablishedPlanChangeExpected = isCycleDiscovery || isRollover || isFrozenReconciliation
      ? {
          subscriptionId: row.subscription.id,
          currentPlanId: row.subscription.planId!,
          billingPeriodId: row.subscription.billingPeriodId!,
          currentPeriodStart: row.subscription.currentPeriodStart!,
          currentPeriodEnd: row.subscription.currentPeriodEnd!,
          nextReconcileAt: row.subscription.nextReconcileAt,
        }
      : isEstablishedPlanChange
        ? {
            subscriptionId: row.subscription.id,
            currentPlanId: row.subscription.planId!,
            pendingPlanId: row.subscription.pendingPlanId!,
            pendingShopifyPlanHandle: row.subscription.pendingShopifyPlanHandle!,
            pendingEffectiveAt: row.subscription.pendingEffectiveAt!,
            currentPeriodStart: row.subscription.currentPeriodStart,
            currentPeriodEnd: row.subscription.currentPeriodEnd,
            billingPeriodId: row.subscription.billingPeriodId,
            nextReconcileAt: row.subscription.nextReconcileAt,
          }
        : {
          subscriptionId: row.subscription.id,
          pendingPlanId: row.subscription.pendingPlanId!,
          pendingShopifyPlanHandle: row.subscription.pendingShopifyPlanHandle!,
          pendingEffectiveAt: row.subscription.pendingEffectiveAt!,
          nextReconcileAt: row.subscription.nextReconcileAt,
        };
    const currentPlan = (isCycleDiscovery || isRollover || isEstablishedPlanChange || isFrozenReconciliation) && row.subscription.planId
      ? await this.database.billingPlan.findUnique({
          where: { id: row.subscription.planId },
          select: { id: true, active: true, name: true, kind: true, shopifyPlanHandle: true, recoveryCreditPackEnabled: true, shopifyUsageEventHandle: true, shopifyRecoveryCreditPackEventHandle: true, includedRecoveryConversationAllowance: true },
        })
      : null;
    if (isCycleDiscovery && (!currentPlan || !currentPlan.active || currentPlan.kind !== BillingPlanKind.FREE || !currentPlan.recoveryCreditPackEnabled)) return;
    if (isRollover && (!currentPlan || !currentPlan.active || (currentPlan.kind === BillingPlanKind.FREE && !currentPlan.recoveryCreditPackEnabled))) return;
    let snapshot: PartnerSubscriptionReconciliationSnapshot;
    try {
      snapshot = await getSubscriptionReconciliationSnapshot(this.partner, row.shopifyShopId);
    } catch (error) {
      if (isCycleDiscovery && currentPlan) {
        await this.recordCycleDiscoveryFailure(row.id, expected as FreeCycleExpected, error);
      } else if (isRollover) {
        await this.recordRolloverRetry(row.id, expected as RolloverExpected, error);
      } else if (isEstablishedPlanChange) {
        await this.recordEstablishedPlanChangeRetry(row.id, expected as EstablishedPlanChangeExpected, "PARTNER_API_ERROR", error);
      } else if (isFrozenReconciliation) {
        await this.recordFrozenProviderFailure(
          row.id,
          row.subscription.id,
          row.subscription.nextReconcileAt,
          row.subscription.planId!,
          error,
        );
      } else {
        await this.recordProviderFailure(row.id, expected as InitialActivationExpected, error);
      }
      return;
    }

    if (!isInitialActivation && (snapshot.latestLifecycleEvent || isFrozenReconciliation)) {
      const lifecycleResult = await new ShopifySubscriptionLifecycleReconciliationService(this.database).reconcile(
        row.id,
        row.subscription.id,
        snapshot,
        this.now(),
      );
      if (lifecycleResult === "handled" || lifecycleResult === "restored") {
        await this.publishCommittedLifecycleSchedule(row.id, row.subscription.id);
        return;
      }
    }
    if (isRollover && currentPlan && row.subscription.currentPeriodEnd) {
      const now = this.now();
      const preCloseAt = new Date(row.subscription.currentPeriodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS);
      if (now < row.subscription.currentPeriodEnd) {
        await this.reconcilePreClose(row.id, expected as RolloverExpected, preCloseAt);
        return;
      }
    }
    const provider = snapshot.activeSubscription;
    if (provider && currentPlan && isRollover
      && (provider.pendingPlanHandle !== null || provider.cancelAtPeriodEnd || row.subscription.cancelAtPeriodEnd)
      && provider.planHandle === currentPlan.shopifyPlanHandle
      && provider.currentPeriodStart?.getTime() === row.subscription.currentPeriodStart?.getTime()
      && provider.currentPeriodEnd?.getTime() === row.subscription.currentPeriodEnd?.getTime()
      && provider.currentPeriodEnd !== null
      && provider.currentPeriodEnd > this.now()) {
      const pendingPlan = provider.pendingPlanHandle
        ? await this.database.billingPlan.findUnique({ where: { shopifyPlanHandle: provider.pendingPlanHandle }, select: { id: true, active: true } })
        : null;
      const next = provider.pendingPlanHandle && provider.pendingEffectiveAt
        ? provider.pendingEffectiveAt
        : provider.currentPeriodEnd
          ? this.now() < new Date(provider.currentPeriodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS)
            ? new Date(provider.currentPeriodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS)
            : provider.currentPeriodEnd
          : null;
      const updated = await this.database.subscription.updateMany({
        where: { id: row.subscription.id, planId: row.subscription.planId, billingPeriodId: row.subscription.billingPeriodId, nextReconcileAt: row.subscription.nextReconcileAt },
        data: {
          pendingShopifyPlanHandle: provider.pendingPlanHandle,
          pendingPlanId: pendingPlan?.active ? pendingPlan.id : null,
          pendingEffectiveAt: provider.pendingEffectiveAt,
          cancelAtPeriodEnd: provider.pendingPlanHandle ? false : provider.cancelAtPeriodEnd,
          currentPeriodEnd: provider.currentPeriodEnd,
          nextReconcileAt: next,
          lastSyncedAt: this.now(),
        },
      });
      if (updated.count > 0 && next) await this.publishNext(row.id, row.subscription.id, next);
      return;
    }

    if (!provider) {
      if (isCycleDiscovery) {
        await this.recordMissingCycle(row.id, expected as FreeCycleExpected);
      } else if (isRollover) {
        await this.recordRolloverRetry(row.id, expected as RolloverExpected);
      } else if (isEstablishedPlanChange) {
        await this.recordEstablishedPlanChangeRetry(row.id, expected as EstablishedPlanChangeExpected, "PROVIDER_STATE_UNRESOLVED");
      } else {
        await this.recordMissingSubscription(row.id, expected as InitialActivationExpected);
      }
      return;
    }

    if (isCycleDiscovery && currentPlan) {
      await this.reconcileFreeCycle(row.id, expected as FreeCycleExpected, provider, currentPlan);
      return;
    }
    if (isRollover && currentPlan) {
      await this.reconcileRollover(row.id, expected as RolloverExpected, provider, currentPlan);
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
        includedRecoveryConversationAllowance: true,
      },
    });
    if (isEstablishedPlanChange && currentPlan) {
      await this.reconcileEstablishedPlanChange(
        row.id,
        expected as EstablishedPlanChangeExpected,
        provider,
        currentPlan,
        plan,
      );
      return;
    }
      if (plan?.active && plan.id === row.subscription.pendingPlanId && plan.kind === BillingPlanKind.FREE) {
        await this.completeVerifiedFree(
          row.id,
          row.subscription.id,
          provider,
          plan.id,
          plan.recoveryCreditPackEnabled,
          job.expectedNextReconcileAt,
          plan.name,
          expected as InitialActivationExpected,
        );
      return;
    }

    if (
      plan?.active
      && plan.id === row.subscription.pendingPlanId
      && plan.shopifyPlanHandle === row.subscription.pendingShopifyPlanHandle
      && provider.planHandle === row.subscription.pendingShopifyPlanHandle
      && plan.kind === BillingPlanKind.PAID_METERED
    ) {
      await this.completeVerifiedPaid(
        row.id,
        row.subscription.id,
        provider,
        plan,
        expected as InitialActivationExpected,
      );
      return;
    }

    if (
      plan?.active
      && plan.kind === BillingPlanKind.PAID_METERED
      && plan.id === row.subscription.pendingPlanId
      && (
        provider.planHandle !== row.subscription.pendingShopifyPlanHandle
        || plan.shopifyPlanHandle !== row.subscription.pendingShopifyPlanHandle
      )
    ) {
      await this.recordPaidActivationFailure(
        row.id,
        expected as InitialActivationExpected,
        "PENDING_PLAN_HANDLE_MISMATCH",
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
      expected as InitialActivationExpected,
    );
  }

  private async reconcileReinstall(
    shopId: string,
    subscriptionId: string,
    reinstallPendingAt: Date,
    nextReconcileAt: Date,
    shopifyShopId: string,
  ): Promise<void> {
    const expected: ReinstallExpected = { subscriptionId, nextReconcileAt, reinstallPendingAt };
    let provider: PartnerSubscription | null;
    try {
      provider = await this.partner.getActiveSubscription(shopifyShopId);
    } catch (error) {
      await this.recordReinstallProviderFailure(shopId, expected, error);
      return;
    }
    if (!provider) {
      await this.completeReinstallWithoutContract(shopId, expected);
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
        shopifyRecoveryCreditPackEventHandle: true,
        recoveryCreditPackEnabled: true,
        includedRecoveryConversationAllowance: true,
      },
    });
    if (!plan?.active) {
      await this.recordReinstallBlocked(shopId, expected, "UNMAPPED_PLAN_HANDLE");
      return;
    }
    if (plan.kind === BillingPlanKind.FREE) {
      if (plan.recoveryCreditPackEnabled && (!plan.shopifyRecoveryCreditPackEventHandle
        || !provider.usageEventHandles.includes(plan.shopifyRecoveryCreditPackEventHandle))) {
        await this.recordReinstallBlocked(shopId, expected, "MISSING_USAGE_METER");
        return;
      }
      await this.completeReinstallFree(shopId, expected, provider, plan);
      return;
    }
    if (plan.kind !== BillingPlanKind.PAID_METERED) {
      await this.recordReinstallBlocked(shopId, expected, "UNSUPPORTED_PLAN_KIND");
      return;
    }
    if (!plan.shopifyUsageEventHandle || !provider.usageEventHandles.includes(plan.shopifyUsageEventHandle)) {
      await this.recordReinstallBlocked(shopId, expected, "MISSING_USAGE_METER");
      return;
    }
    await this.completeReinstallPaid(shopId, expected, provider, plan);
  }

  private async completeReinstallWithoutContract(shopId: string, expected: ReinstallExpected): Promise<void> {
    const now = this.now();
    const committed = await this.database.$transaction(async (transaction: Prisma.TransactionClient) => {
      await this.lockShop(transaction, shopId);
      await this.lockShopSettings(transaction, shopId);
      await this.lockSubscription(transaction, expected.subscriptionId);
      if (!(await this.isReinstallAuthority(transaction, shopId, expected))) return false;
      await transaction.subscription.update({ where: { id: expected.subscriptionId }, data: {
        planId: null, observedShopifyPlanHandle: null, status: SubscriptionProjectionStatus.NO_CONTRACT,
        billingPeriodId: null, currentPeriodStart: null, currentPeriodEnd: null, trialEndsAt: null,
        cancelAtPeriodEnd: false, providerSubscriptionId: null, pendingShopifyPlanHandle: null,
        pendingPlanId: null, pendingEffectiveAt: null, nextReconcileAt: null, lastSyncedAt: now,
        lastSyncErrorCode: null, lastSyncErrorAt: null,
      } });
      await transaction.shopSettings.update({ where: { shopId }, data: { onboardingCompleted: false } });
      await transaction.shop.update({ where: { id: shopId }, data: { status: "ACTIVE", uninstalledAt: null, reinstallPendingAt: null } });
      return true;
    });
    if (committed) this.logger.warn("billing.subscription_reconciliation.reinstall_no_contract", { shopId });
  }

  private async completeReinstallFree(
    shopId: string,
    expected: ReinstallExpected,
    provider: PartnerSubscription,
    plan: InitialActivationPlan & { recoveryCreditPackEnabled: boolean; shopifyRecoveryCreditPackEventHandle: string | null },
  ): Promise<void> {
    const now = this.now();
    const next = plan.recoveryCreditPackEnabled && provider.currentPeriodEnd
      ? new Date(Math.max(now.getTime(), provider.currentPeriodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS))
      : null;
    const committed = await this.database.$transaction(async (transaction: Prisma.TransactionClient) => {
      await this.lockShop(transaction, shopId);
      await this.lockShopSettings(transaction, shopId);
      await this.lockSubscription(transaction, expected.subscriptionId);
      if (!(await this.isReinstallAuthority(transaction, shopId, expected))) return false;
      const pendingPlan = provider.pendingPlanHandle
        ? await transaction.billingPlan.findUnique({ where: { shopifyPlanHandle: provider.pendingPlanHandle }, select: { id: true, active: true } })
        : null;
      const period = provider.currentPeriodStart && provider.currentPeriodEnd
        ? await transaction.billingPeriod.upsert({
            where: { shopId_periodStart_periodEnd: { shopId, periodStart: provider.currentPeriodStart, periodEnd: provider.currentPeriodEnd } },
            update: {},
            create: { shopId, subscriptionId: expected.subscriptionId, planId: plan.id, shopifyPlanHandleSnapshot: provider.planHandle, planNameSnapshot: plan.name, planKindSnapshot: BillingPlanKind.FREE, periodStart: provider.currentPeriodStart, periodEnd: provider.currentPeriodEnd, includedRecoveryCreditsGranted: null },
          })
        : null;
      await transaction.subscription.update({ where: { id: expected.subscriptionId }, data: {
        planId: plan.id, observedShopifyPlanHandle: provider.planHandle,
        status: provider.status === "TRIALING" ? SubscriptionProjectionStatus.TRIALING : SubscriptionProjectionStatus.ACTIVE,
        billingPeriodId: period?.id ?? null, currentPeriodStart: provider.currentPeriodStart, currentPeriodEnd: provider.currentPeriodEnd,
        trialEndsAt: provider.trialEndsAt, cancelAtPeriodEnd: provider.cancelAtPeriodEnd, providerSubscriptionId: provider.providerSubscriptionId,
        pendingShopifyPlanHandle: provider.pendingPlanHandle, pendingPlanId: pendingPlan?.active ? pendingPlan.id : null,
        pendingEffectiveAt: provider.pendingEffectiveAt, nextReconcileAt: next,
        lastSyncedAt: now, lastSyncErrorCode: null, lastSyncErrorAt: null,
      } });
      await transaction.shopSettings.update({ where: { shopId }, data: { onboardingCompleted: true } });
      await transaction.shop.update({ where: { id: shopId }, data: { status: "ACTIVE", uninstalledAt: null, reinstallPendingAt: null } });
      return true;
    });
    if (committed && next) await this.publishNext(shopId, expected.subscriptionId, next);
  }

  private async completeReinstallPaid(
    shopId: string,
    expected: ReinstallExpected,
    provider: PartnerSubscription,
    plan: InitialActivationPlan & { recoveryCreditPackEnabled: boolean; shopifyRecoveryCreditPackEventHandle: string | null },
  ): Promise<void> {
    const current = await this.database.subscription.findUnique({ where: { id: expected.subscriptionId }, select: { planId: true, observedShopifyPlanHandle: true, billingPeriodId: true, currentPeriodStart: true, currentPeriodEnd: true } });
    if (!current || current.planId !== plan.id || current.observedShopifyPlanHandle !== provider.planHandle || !current.billingPeriodId || !current.currentPeriodStart || !current.currentPeriodEnd) {
      await this.recordReinstallBlocked(shopId, expected, "PERIOD_ALIGNMENT_REQUIRED");
      return;
    }
    if (provider.currentPeriodStart?.getTime() === current.currentPeriodStart.getTime()
      && provider.currentPeriodEnd?.getTime() === current.currentPeriodEnd.getTime()) {
      const result = await this.activateReinstallPaid(shopId, expected, provider, plan);
      if (result === "invalid") await this.recordReinstallBlocked(shopId, expected, "PERIOD_ALIGNMENT_REQUIRED");
      return;
    }
    try {
      const result = await this.database.$transaction(async (transaction: Prisma.TransactionClient) => {
        await this.lockShop(transaction, shopId);
        if (!(await this.isReinstallAuthority(transaction, shopId, expected))) return { kind: "stale" as const };
        const rollover = await new SamePlanBillingPeriodRolloverService(this.database).transitionInTransaction(transaction, { shopId, subscriptionId: expected.subscriptionId, provider, plan, now: this.now() });
        if (rollover.kind !== "transitioned" && rollover.kind !== "unchanged") return rollover;
        const pendingPlan = provider.pendingPlanHandle
          ? await transaction.billingPlan.findUnique({ where: { shopifyPlanHandle: provider.pendingPlanHandle }, select: { id: true, active: true } })
          : null;
        await transaction.subscription.update({ where: { id: expected.subscriptionId }, data: { pendingShopifyPlanHandle: provider.pendingPlanHandle, pendingPlanId: pendingPlan?.active ? pendingPlan.id : null, pendingEffectiveAt: provider.pendingEffectiveAt } });
        await transaction.shopSettings.update({ where: { shopId }, data: { onboardingCompleted: true } });
        await transaction.shop.update({ where: { id: shopId }, data: { status: "ACTIVE", uninstalledAt: null, reinstallPendingAt: null } });
        return rollover;
      });
      if (result.kind === "transitioned" || result.kind === "unchanged") {
        if (result.nextReconcileAt) await this.publishNext(shopId, expected.subscriptionId, result.nextReconcileAt);
        return;
      }
      if (result.kind !== "stale") await this.recordReinstallBlocked(shopId, expected, result.kind === "provider-cycle-lag" ? "PROVIDER_CYCLE_LAG" : "PERIOD_ALIGNMENT_REQUIRED");
    } catch {
      await this.recordReinstallBlocked(shopId, expected, "PERIOD_ALIGNMENT_REQUIRED");
    }
  }

  private async activateReinstallPaid(
    shopId: string,
    expected: ReinstallExpected,
    provider: PartnerSubscription,
    plan: InitialActivationPlan & { recoveryCreditPackEnabled: boolean },
  ): Promise<boolean | "invalid"> {
    const now = this.now();
    const periodEnd = provider.currentPeriodEnd as Date;
    const next = new Date(Math.max(now.getTime(), periodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS));
    const committed = await this.database.$transaction(async (transaction: Prisma.TransactionClient) => {
      await this.lockShop(transaction, shopId);
      await this.lockShopSettings(transaction, shopId);
      await this.lockSubscription(transaction, expected.subscriptionId);
      if (!(await this.isReinstallAuthority(transaction, shopId, expected))) return false;
      const current = await transaction.subscription.findUnique({ where: { id: expected.subscriptionId }, select: { id: true, planId: true, observedShopifyPlanHandle: true, billingPeriodId: true, currentPeriodStart: true, currentPeriodEnd: true, nextReconcileAt: true } });
      const period = current?.billingPeriodId ? await transaction.billingPeriod.findUnique({ where: { id: current.billingPeriodId } }) : null;
      const counter = period ? await transaction.billingPeriodEntitlementCounter.findUnique({ where: { billingPeriodId_counter: { billingPeriodId: period.id, counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS } } }) : null;
      const quantities = counter && [counter.grantedQuantity, counter.committedQuantity, counter.reservedQuantity, counter.forfeitedQuantity].every((value) => Number.isSafeInteger(value) && value >= 0);
      const valid = Boolean(current && current.planId === plan.id && current.observedShopifyPlanHandle === provider.planHandle && current.billingPeriodId
        && current.currentPeriodStart && current.currentPeriodEnd && provider.currentPeriodStart && provider.currentPeriodEnd
        && current.currentPeriodStart.getTime() === provider.currentPeriodStart.getTime() && current.currentPeriodEnd.getTime() === provider.currentPeriodEnd.getTime()
        && period && period.id === current.billingPeriodId && period.shopId === shopId && period.subscriptionId === expected.subscriptionId && period.planId === plan.id
        && period.status === BillingPeriodStatus.OPEN && period.periodStart.getTime() === provider.currentPeriodStart.getTime() && period.periodEnd.getTime() === provider.currentPeriodEnd.getTime()
        && counter && counter.shopId === shopId && counter.billingPeriodId === period.id && quantities
        && counter.grantedQuantity === period.includedRecoveryCreditsGranted
        && counter.committedQuantity + counter.reservedQuantity + counter.forfeitedQuantity <= counter.grantedQuantity);
      if (!valid) return "invalid";
      const pendingPlan = provider.pendingPlanHandle
        ? await transaction.billingPlan.findUnique({ where: { shopifyPlanHandle: provider.pendingPlanHandle }, select: { id: true, active: true } })
        : null;
      await transaction.subscription.update({ where: { id: expected.subscriptionId }, data: {
        status: provider.status === "TRIALING" ? SubscriptionProjectionStatus.TRIALING : SubscriptionProjectionStatus.ACTIVE,
        trialEndsAt: provider.trialEndsAt, cancelAtPeriodEnd: provider.cancelAtPeriodEnd, providerSubscriptionId: provider.providerSubscriptionId,
        pendingShopifyPlanHandle: provider.pendingPlanHandle, pendingPlanId: pendingPlan?.active ? pendingPlan.id : null, pendingEffectiveAt: provider.pendingEffectiveAt,
        nextReconcileAt: next, lastSyncedAt: now, lastSyncErrorCode: null, lastSyncErrorAt: null,
      } });
      await transaction.shopSettings.update({ where: { shopId }, data: { onboardingCompleted: true } });
      await transaction.shop.update({ where: { id: shopId }, data: { status: "ACTIVE", uninstalledAt: null, reinstallPendingAt: null } });
      return true;
    });
    if (committed === true) await this.publishNext(shopId, expected.subscriptionId, next);
    return committed;
  }

  private async activateReinstallAfterRollover(shopId: string, expected: ReinstallExpected): Promise<boolean> {
    const committed = await this.database.$transaction(async (transaction: Prisma.TransactionClient) => {
      await this.lockShopSettings(transaction, shopId);
      await this.lockSubscription(transaction, expected.subscriptionId);
      const current = await transaction.subscription.findUnique({ where: { id: expected.subscriptionId }, select: { nextReconcileAt: true } });
      if (!current || !current.nextReconcileAt) return false;
      await transaction.shopSettings.update({ where: { shopId }, data: { onboardingCompleted: true } });
      await transaction.shop.update({ where: { id: shopId }, data: { status: "ACTIVE", uninstalledAt: null, reinstallPendingAt: null } });
      return true;
    });
    return committed;
  }

  private async recordReinstallProviderFailure(shopId: string, expected: ReinstallExpected, error: unknown): Promise<void> {
    const now = this.now();
    const next = nextSubscriptionReconcileAt(expected.reinstallPendingAt, now);
    this.logger.error("billing.subscription_reconciliation.reinstall_provider_failed", {
      shopId,
      subscriptionId: expected.subscriptionId,
      errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure",
    });
    const updated = await this.database.subscription.updateMany({
      where: { id: expected.subscriptionId, nextReconcileAt: expected.nextReconcileAt },
      data: { lastSyncErrorCode: "PARTNER_API_ERROR", lastSyncErrorAt: now, nextReconcileAt: next },
    });
    if (updated.count > 0 && next) await this.publishNext(shopId, expected.subscriptionId, next);
  }

  private async recordReinstallBlocked(shopId: string, expected: ReinstallExpected, errorCode: string): Promise<void> {
    const updated = await this.database.subscription.updateMany({
      where: { id: expected.subscriptionId, nextReconcileAt: expected.nextReconcileAt },
      data: { lastSyncErrorCode: errorCode.slice(0, 128), lastSyncErrorAt: this.now(), nextReconcileAt: null },
    });
    if (updated.count > 0) this.logger.warn("billing.subscription_reconciliation.reinstall_blocked", { shopId, subscriptionId: expected.subscriptionId, errorCode });
  }

  private async recordMissingSubscription(shopId: string, expected: InitialActivationExpected): Promise<void> {
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

  private async recordProviderFailure(shopId: string, expected: InitialActivationExpected, error: unknown): Promise<void> {
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

  private async recordFrozenProviderFailure(
    shopId: string,
    subscriptionId: string,
    consumedAt: Date,
    planId: string,
    error: unknown,
  ): Promise<void> {
    const now = this.now();
    const next = new Date(now.getTime() + 60 * 60 * 1000);
    this.logger.error("billing.subscription_reconciliation.provider_failed", {
      shopId,
      subscriptionId,
      errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure",
    });
    const updated = await this.database.subscription.updateMany({
      where: {
        id: subscriptionId,
        status: SubscriptionProjectionStatus.FROZEN,
        planId,
        nextReconcileAt: consumedAt,
      },
      data: {
        lastSyncErrorCode: "PARTNER_API_ERROR",
        lastSyncErrorAt: now,
        lastSyncedAt: now,
        nextReconcileAt: next,
      },
    });
    if (updated.count > 0) await this.publishNext(shopId, subscriptionId, next);
  }

  private async casPendingUpdate(
    expected: InitialActivationExpected,
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

  private async publishCommittedLifecycleSchedule(shopId: string, subscriptionId: string): Promise<void> {
    const current = await this.database.subscription.findUnique({
      where: { id: subscriptionId },
      select: { nextReconcileAt: true },
    });
    if (current?.nextReconcileAt) await this.publishNext(shopId, subscriptionId, current.nextReconcileAt);
  }

  private async recordMissingCycle(shopId: string, expected: FreeCycleExpected): Promise<void> {
    const next = new Date(this.now().getTime() + FREE_CYCLE_DISCOVERY_RETRY_MS);
    const result = await this.database.subscription.updateMany({
      where: {
        id: expected.subscriptionId,
        status: { in: [SubscriptionProjectionStatus.ACTIVE, SubscriptionProjectionStatus.TRIALING] },
        planId: expected.currentPlanId,
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

  private async recordCycleDiscoveryFailure(shopId: string, expected: FreeCycleExpected, error: unknown): Promise<void> {
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
        planId: expected.currentPlanId,
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

  private async reconcileRollover(
    shopId: string,
    expected: RolloverExpected,
    provider: PartnerSubscription,
    plan: {
      id: string;
      active: boolean;
      name: string;
      kind: BillingPlanKind;
      shopifyPlanHandle: string;
      recoveryCreditPackEnabled: boolean;
      shopifyUsageEventHandle: string | null;
      shopifyRecoveryCreditPackEventHandle: string | null;
      includedRecoveryConversationAllowance: number | null;
    },
  ): Promise<void> {
    try {
      const result = await new SamePlanBillingPeriodRolloverService(this.database, async (rolloverInput, transitionResult) => {
        if (transitionResult.planKind !== BillingPlanKind.PAID_METERED) return;
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
        subscriptionId: expected.subscriptionId,
        provider,
        plan,
        now: this.now(),
      });
      if (result.kind === "provider-cycle-lag") {
        await this.recordRolloverRetry(shopId, expected, undefined, "PROVIDER_CYCLE_LAG");
        return;
      }
      if (result.kind !== "not-applicable") {
        const next = result.nextReconcileAt;
        if (next) await this.publishNext(shopId, expected.subscriptionId, next);
        return;
      }
    } catch (error) {
      this.logger.warn("billing.subscription_reconciliation.rollover_retry", {
        shopId,
        subscriptionId: expected.subscriptionId,
        errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure",
      });
      await this.recordRolloverRetry(shopId, expected, error);
      return;
    }
    await this.recordRolloverRetry(shopId, expected);
  }

  private async reconcileEstablishedPlanChange(
    shopId: string,
    expected: EstablishedPlanChangeExpected,
    provider: PartnerSubscription,
    currentPlan: ShopifyPlanChangePlan,
    targetPlan: ShopifyPlanChangePlan | null,
  ): Promise<void> {
    const now = this.now();
    const providerIsCurrent = provider.planHandle === currentPlan.shopifyPlanHandle;
    const providerIsPendingTarget = targetPlan?.id === expected.pendingPlanId
      && targetPlan.shopifyPlanHandle === expected.pendingShopifyPlanHandle
      && provider.planHandle === expected.pendingShopifyPlanHandle;
    if (providerIsCurrent) {
      const pendingHandle = provider.pendingPlanHandle;
      const pendingPlan = pendingHandle
        ? await this.database.billingPlan.findUnique({ where: { shopifyPlanHandle: pendingHandle }, select: { id: true, active: true } })
        : null;
      const next = pendingHandle && provider.pendingEffectiveAt
        ? provider.pendingEffectiveAt
        : this.nextPlanReconcileAt(currentPlan, expected.currentPeriodEnd, now);
      const data = {
        lastSyncedAt: now,
        lastSyncErrorCode: null,
        lastSyncErrorAt: null,
        nextReconcileAt: next,
        pendingShopifyPlanHandle: pendingHandle,
        pendingPlanId: pendingPlan?.active ? pendingPlan.id : null,
        pendingEffectiveAt: provider.pendingEffectiveAt,
      } as Prisma.SubscriptionUpdateManyMutationInput & { pendingPlanId?: string | null };
      const updated = await this.database.subscription.updateMany({
        where: this.establishedPlanChangeWhere(expected),
        data,
      });
      if (updated.count > 0) {
        if (next) await this.publishNext(shopId, expected.subscriptionId, next);
      }
      return;
    }
    if (providerIsPendingTarget) {
      const sameCycle = expected.currentPeriodStart !== null
        && expected.currentPeriodEnd !== null
        && provider.currentPeriodStart?.getTime() === expected.currentPeriodStart.getTime()
        && provider.currentPeriodEnd?.getTime() === expected.currentPeriodEnd.getTime();
      if (sameCycle) {
        await this.recordEstablishedPlanChangeFailure(shopId, expected, "UNEXPECTED_IMMEDIATE_PLAN_CHANGE", false, provider.planHandle);
        return;
      }
      if (now < expected.pendingEffectiveAt) {
        const updated = await this.database.subscription.updateMany({
          where: this.establishedPlanChangeWhere(expected),
          data: { nextReconcileAt: expected.pendingEffectiveAt, lastSyncedAt: now, lastSyncErrorCode: null, lastSyncErrorAt: null },
        });
        if (updated.count > 0) await this.publishNext(shopId, expected.subscriptionId, expected.pendingEffectiveAt);
        return;
      }
      if (!targetPlan) return;
      if (targetPlan.kind === BillingPlanKind.PAID_METERED || (targetPlan.kind === BillingPlanKind.FREE && targetPlan.recoveryCreditPackEnabled)) {
        if (!provider.currentPeriodStart || !provider.currentPeriodEnd || provider.currentPeriodStart >= provider.currentPeriodEnd) {
          await this.recordEstablishedPlanChangeRetry(shopId, expected, "MISSING_BILLING_CYCLE", undefined, true);
          return;
        }
      }
      if (targetPlan.kind === BillingPlanKind.PAID_METERED) {
        if (!Number.isSafeInteger(targetPlan.includedRecoveryConversationAllowance) || (targetPlan.includedRecoveryConversationAllowance ?? -1) < 0) {
          await this.recordEstablishedPlanChangeRetry(shopId, expected, "INVALID_INCLUDED_ALLOWANCE", undefined, true);
          return;
        }
        if (!targetPlan.shopifyUsageEventHandle || !provider.usageEventHandles.includes(targetPlan.shopifyUsageEventHandle)) {
          await this.recordEstablishedPlanChangeRetry(shopId, expected, "MISSING_USAGE_METER", undefined, true);
          return;
        }
      }
      if (targetPlan.recoveryCreditPackEnabled && (!targetPlan.shopifyRecoveryCreditPackEventHandle || !provider.usageEventHandles.includes(targetPlan.shopifyRecoveryCreditPackEventHandle))) {
        await this.recordEstablishedPlanChangeRetry(shopId, expected, "MISSING_USAGE_METER", undefined, true);
        return;
      }
      const result = await new ShopifyPlanChangeTransitionService(this.database).transition({
        shopId,
        subscriptionId: expected.subscriptionId,
        provider,
        plan: targetPlan,
        expectedCurrentPlanId: expected.currentPlanId,
        now,
      });
      if (result.kind === "transitioned") {
        if (result.nextReconcileAt) await this.publishNext(shopId, expected.subscriptionId, result.nextReconcileAt);
        await this.schedulePlanChangeCapacityResume(shopId, result.planKind);
      } else {
        await this.recordEstablishedPlanChangeFailure(shopId, expected, "UNEXPECTED_IMMEDIATE_PLAN_CHANGE", false, provider.planHandle);
      }
      return;
    }
    if (!targetPlan) {
      await this.recordEstablishedPlanChangeFailure(shopId, expected, "UNMAPPED_PLAN_HANDLE", true, provider.planHandle);
      return;
    }
    await this.recordEstablishedPlanChangeFailure(shopId, expected, "UNEXPECTED_IMMEDIATE_PLAN_CHANGE", false, provider.planHandle);
  }

  private establishedPlanChangeWhere(expected: EstablishedPlanChangeExpected) {
    return {
      id: expected.subscriptionId,
      OR: [
        { status: { in: [SubscriptionProjectionStatus.ACTIVE, SubscriptionProjectionStatus.TRIALING] } },
        { status: SubscriptionProjectionStatus.SYNC_ERROR, lastSyncErrorCode: { in: [...RETRYABLE_PLAN_CHANGE_SYNC_ERRORS] } },
      ],
      planId: expected.currentPlanId,
      pendingPlanId: expected.pendingPlanId,
      pendingShopifyPlanHandle: expected.pendingShopifyPlanHandle,
      pendingEffectiveAt: expected.pendingEffectiveAt,
      nextReconcileAt: expected.nextReconcileAt,
    };
  }

  private nextPlanReconcileAt(plan: ShopifyPlanChangePlan, periodEnd: Date | null, now: Date): Date | null {
    if (plan.kind === BillingPlanKind.FREE && !plan.recoveryCreditPackEnabled) return null;
    return periodEnd ? new Date(Math.max(now.getTime(), periodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS)) : null;
  }

  private async recordEstablishedPlanChangeFailure(
    shopId: string,
    expected: EstablishedPlanChangeExpected,
    errorCode: "UNEXPECTED_IMMEDIATE_PLAN_CHANGE" | "UNMAPPED_PLAN_HANDLE",
    unmapped = false,
    observedHandle?: string,
  ): Promise<void> {
    const now = this.now();
    const next = unmapped ? null : new Date(now.getTime() + ROLLOVER_RETRY_MS);
    const updated = await this.database.subscription.updateMany({
      where: this.establishedPlanChangeWhere(expected),
      data: {
        ...(unmapped ? { planId: null, status: SubscriptionProjectionStatus.UNMAPPED } : { status: SubscriptionProjectionStatus.SYNC_ERROR }),
        ...(observedHandle ? { observedShopifyPlanHandle: observedHandle } : {}),
        nextReconcileAt: next,
        lastSyncedAt: now,
        lastSyncErrorCode: errorCode,
        lastSyncErrorAt: now,
      },
    });
    if (updated.count > 0 && next) await this.publishNext(shopId, expected.subscriptionId, next);
  }

  private async recordEstablishedPlanChangeRetry(
    shopId: string,
    expected: EstablishedPlanChangeExpected,
    errorCode: "PARTNER_API_ERROR" | "PROVIDER_STATE_UNRESOLVED" | "MISSING_BILLING_CYCLE" | "MISSING_USAGE_METER" | "INVALID_INCLUDED_ALLOWANCE",
    error?: unknown,
    failClosed = false,
  ): Promise<void> {
    const now = this.now();
    const next = new Date(now.getTime() + ROLLOVER_RETRY_MS);
    if (error) {
      this.logger.error("billing.subscription_reconciliation.provider_failed", {
        shopId,
        subscriptionId: expected.subscriptionId,
        errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure",
      });
    }
    const updated = await this.database.subscription.updateMany({
      where: this.establishedPlanChangeWhere(expected),
      data: {
        ...(failClosed ? { status: SubscriptionProjectionStatus.SYNC_ERROR } : {}),
        nextReconcileAt: next,
        lastSyncedAt: now,
        lastSyncErrorCode: errorCode,
        lastSyncErrorAt: now,
      },
    });
    if (updated.count > 0) await this.publishNext(shopId, expected.subscriptionId, next);
  }

  private async schedulePlanChangeCapacityResume(shopId: string, planKind: BillingPlanKind): Promise<void> {
    if (planKind !== BillingPlanKind.PAID_METERED) return;
    try {
      await recoveryCapacityResumeService.schedule({ shopId, trigger: "plan-change" });
    } catch (error) {
      this.logger.warn("billing.recovery_capacity_resume.enqueue_failed", {
        shopId,
        errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure",
      });
    }
  }

  private async recordRolloverRetry(
    shopId: string,
    expected: RolloverExpected,
    error?: unknown,
    errorCode = "PARTNER_API_ERROR",
  ): Promise<void> {
    const now = this.now();
    const next = new Date(now.getTime() + ROLLOVER_RETRY_MS);
    const updated = await this.database.subscription.updateMany({
      where: {
        id: expected.subscriptionId,
        status: { in: [SubscriptionProjectionStatus.ACTIVE, SubscriptionProjectionStatus.TRIALING] },
        planId: expected.currentPlanId,
        billingPeriodId: expected.billingPeriodId,
        currentPeriodStart: expected.currentPeriodStart,
        currentPeriodEnd: expected.currentPeriodEnd,
        nextReconcileAt: expected.nextReconcileAt,
      },
      data: {
        nextReconcileAt: next,
        lastSyncedAt: now,
        ...(error || errorCode === "PROVIDER_CYCLE_LAG"
          ? { lastSyncErrorCode: errorCode, lastSyncErrorAt: now }
          : {}),
      },
    });
    if (updated.count > 0) await this.publishNext(shopId, expected.subscriptionId, next);
  }

  private async reconcilePreClose(
    shopId: string,
    expected: RolloverExpected,
    preCloseAt: Date,
  ): Promise<void> {
    const now = this.now();
    const scheduled = await this.database.subscription.findUnique({
      where: { id: expected.subscriptionId },
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
    if (
      !scheduled
      || scheduled.id !== expected.subscriptionId
      || (scheduled.status !== SubscriptionProjectionStatus.ACTIVE && scheduled.status !== SubscriptionProjectionStatus.TRIALING)
      || scheduled.planId !== expected.currentPlanId
      || scheduled.billingPeriodId !== expected.billingPeriodId
      || scheduled.currentPeriodStart?.getTime() !== expected.currentPeriodStart.getTime()
      || scheduled.currentPeriodEnd?.getTime() !== expected.currentPeriodEnd.getTime()
      || scheduled.nextReconcileAt?.getTime() !== expected.nextReconcileAt.getTime()
    ) return;
    const periodEnd = expected.currentPeriodEnd;
    const next = now < preCloseAt ? preCloseAt : periodEnd;
    if (next.getTime() !== periodEnd.getTime()) {
      const updated = await this.database.subscription.updateMany({
        where: {
          id: expected.subscriptionId,
          status: { in: [SubscriptionProjectionStatus.ACTIVE, SubscriptionProjectionStatus.TRIALING] },
          planId: expected.currentPlanId,
          billingPeriodId: expected.billingPeriodId,
          currentPeriodStart: expected.currentPeriodStart,
          currentPeriodEnd: expected.currentPeriodEnd,
          nextReconcileAt: expected.nextReconcileAt,
        },
        data: { nextReconcileAt: next },
      });
      if (updated.count > 0) await this.publishNext(shopId, expected.subscriptionId, next);
      return;
    }
    let flushFailed = false;
    try {
      await shopifyUsageEventPublisherService.publishDue({ billingPeriodId: expected.billingPeriodId });
    } catch (error) {
      flushFailed = true;
      this.logger.warn("billing.subscription_reconciliation.pre_close_publish_failed", {
        shopId,
        subscriptionId: expected.subscriptionId,
        errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure",
      });
    }
    if (flushFailed) {
      const retryAt = new Date(Math.min(now.getTime() + ROLLOVER_RETRY_MS, periodEnd.getTime()));
      const updated = await this.database.subscription.updateMany({
        where: {
          id: expected.subscriptionId,
          status: { in: [SubscriptionProjectionStatus.ACTIVE, SubscriptionProjectionStatus.TRIALING] },
          planId: expected.currentPlanId,
          billingPeriodId: expected.billingPeriodId,
          currentPeriodStart: expected.currentPeriodStart,
          currentPeriodEnd: expected.currentPeriodEnd,
          nextReconcileAt: expected.nextReconcileAt,
        },
        data: {
          nextReconcileAt: retryAt,
          lastSyncedAt: now,
          lastSyncErrorCode: "PRE_CLOSE_USAGE_FLUSH_FAILED",
          lastSyncErrorAt: now,
        },
      });
      if (updated.count > 0) await this.publishNext(shopId, expected.subscriptionId, retryAt);
      return;
    }
    const updated = await this.database.subscription.updateMany({
      where: {
        id: expected.subscriptionId,
        status: { in: [SubscriptionProjectionStatus.ACTIVE, SubscriptionProjectionStatus.TRIALING] },
        planId: expected.currentPlanId,
        billingPeriodId: expected.billingPeriodId,
        currentPeriodStart: expected.currentPeriodStart,
        currentPeriodEnd: expected.currentPeriodEnd,
        nextReconcileAt: expected.nextReconcileAt,
      },
      data: { nextReconcileAt: periodEnd, lastSyncedAt: now, lastSyncErrorCode: null, lastSyncErrorAt: null },
    });
    if (updated.count > 0) await this.publishNext(shopId, expected.subscriptionId, periodEnd);
  }

  private async reconcileFreeCycle(
    shopId: string,
    expected: FreeCycleExpected,
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
      await this.lockSubscription(transaction, expected.subscriptionId);
      const current = await transaction.subscription.findUnique({
        where: { id: expected.subscriptionId },
        select: { status: true, planId: true, billingPeriodId: true, pendingPlanId: true, pendingShopifyPlanHandle: true, pendingEffectiveAt: true, nextReconcileAt: true },
      });
      if (!current || (current.status !== SubscriptionProjectionStatus.ACTIVE && current.status !== SubscriptionProjectionStatus.TRIALING) || current.planId !== expected.currentPlanId || current.billingPeriodId !== null || current.pendingPlanId !== null || current.pendingShopifyPlanHandle !== null || current.pendingEffectiveAt !== null || current.nextReconcileAt?.toISOString() !== expected.nextReconcileAt.toISOString()) return false;
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
    expectedNextReconcileAt: string,
    planName: string,
    expected: InitialActivationExpected,
  ): Promise<void> {
    const now = this.now();
    const nextReconcileAt = recoveryCreditPackEnabled
      ? provider.currentPeriodEnd
        ? new Date(Math.max(now.getTime(), provider.currentPeriodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS))
        : new Date(now.getTime() + FREE_CYCLE_DISCOVERY_RETRY_MS)
      : null;
    const committed = await this.database.$transaction(async (transaction: Prisma.TransactionClient) => {
      await this.lockShopSettings(transaction, shopId);
      await this.lockSubscription(transaction, subscriptionId);
      const settings = await transaction.shopSettings.findUnique({ where: { shopId }, select: { onboardingCompleted: true } });
      const current = await transaction.subscription.findUnique({
        where: { id: subscriptionId },
        select: { status: true, planId: true, pendingPlanId: true, pendingShopifyPlanHandle: true, pendingEffectiveAt: true, nextReconcileAt: true },
      });
      if (
        !current
        || settings?.onboardingCompleted !== false
        || current.status !== SubscriptionProjectionStatus.NO_CONTRACT
        || current.planId !== null
        || current.pendingPlanId !== expected.pendingPlanId
        || current.pendingShopifyPlanHandle !== expected.pendingShopifyPlanHandle
        || current.pendingEffectiveAt?.toISOString() !== expected.pendingEffectiveAt?.toISOString()
        || !sameDate(current.nextReconcileAt, expected.nextReconcileAt)
      ) return false;

      const lifetimeCounter = await transaction.shopEntitlementCounter.findUnique({ where: { shopId_counter: { shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" } }, select: { id: true } });
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
          where: { shopId_counter: { shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" } },
          update: {},
          create: { shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS", grantedQuantity: policy.lifetimeFreeRecoveryAllowance },
        });
      }
      return true;
    });
    if (committed === true && nextReconcileAt) await this.publishNext(shopId, subscriptionId, nextReconcileAt);
  }

  private async completeVerifiedPaid(
    shopId: string,
    subscriptionId: string,
    provider: PartnerSubscription,
    plan: InitialActivationPlan,
    expected: InitialActivationExpected,
  ): Promise<void> {
    const now = this.now();
    const allowance = plan.includedRecoveryConversationAllowance;
    const isValidAllowance = Number.isSafeInteger(allowance)
      && (allowance ?? -1) >= 0;
    const hasValidCycle = provider.currentPeriodStart !== null
      && provider.currentPeriodEnd !== null
      && provider.currentPeriodStart < provider.currentPeriodEnd;
    const hasMeter = Boolean(plan.shopifyUsageEventHandle && provider.usageEventHandles.includes(plan.shopifyUsageEventHandle));
    if (provider.status === "TRIALING" && provider.trialEndsAt && provider.trialEndsAt > now && !hasValidCycle) {
      await this.recordUnsupportedPaidTrial(shopId, expected);
      return;
    }
    if (!hasValidCycle || !isValidAllowance || !hasMeter) {
      await this.recordPaidActivationFailure(shopId, expected, !hasValidCycle ? "MISSING_BILLING_CYCLE" : !hasMeter ? "MISSING_USAGE_METER" : "INVALID_INCLUDED_ALLOWANCE");
      return;
    }

    const periodStart = provider.currentPeriodStart as Date;
    const periodEnd = provider.currentPeriodEnd as Date;
    const nextReconcileAt = new Date(Math.max(now.getTime(), periodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS));
    const expectedGrant = allowance as number;
    const committed = await this.database.$transaction(async (transaction: Prisma.TransactionClient) => {
      await this.lockShopSettings(transaction, shopId);
      await this.lockSubscription(transaction, subscriptionId);
      const settings = await transaction.shopSettings.findUnique({ where: { shopId }, select: { onboardingCompleted: true } });
      const current = await transaction.subscription.findUnique({
        where: { id: subscriptionId },
        select: { status: true, planId: true, pendingPlanId: true, pendingShopifyPlanHandle: true, pendingEffectiveAt: true, nextReconcileAt: true },
      });
      if (
        !current
        || settings?.onboardingCompleted !== false
        || current.status !== SubscriptionProjectionStatus.NO_CONTRACT
        || current.planId !== null
        || current.pendingPlanId !== expected.pendingPlanId
        || current.pendingShopifyPlanHandle !== expected.pendingShopifyPlanHandle
        || current.pendingEffectiveAt?.toISOString() !== expected.pendingEffectiveAt.toISOString()
        || !sameDate(current.nextReconcileAt, expected.nextReconcileAt)
      ) return false;

      const currentPlan = await transaction.billingPlan.findUnique({
        where: { id: current.pendingPlanId },
        select: { id: true, active: true, name: true, kind: true, shopifyPlanHandle: true, shopifyUsageEventHandle: true, includedRecoveryConversationAllowance: true },
      });
      const currentAllowance = currentPlan?.includedRecoveryConversationAllowance;
      const currentPlanValid = currentPlan?.id === expected.pendingPlanId
        && currentPlan.shopifyPlanHandle === expected.pendingShopifyPlanHandle
        && currentPlan.shopifyPlanHandle === provider.planHandle
        && currentPlan.active
        && currentPlan.kind === BillingPlanKind.PAID_METERED
        && currentPlan.shopifyUsageEventHandle !== null
        && provider.usageEventHandles.includes(currentPlan.shopifyUsageEventHandle)
        && currentAllowance === allowance
        && Number.isSafeInteger(currentAllowance)
        && (currentAllowance ?? -1) >= 0;
      if (!currentPlanValid) throw new Error("Initial paid activation found an incompatible pending plan");

      const existingPeriod = await transaction.billingPeriod.findUnique({
        where: { shopId_periodStart_periodEnd: { shopId, periodStart, periodEnd } },
      });
      if (existingPeriod?.status === BillingPeriodStatus.CLOSED) {
        throw new Error("Initial paid activation cannot reopen a closed billing period");
      }
      if (existingPeriod && (
        existingPeriod.subscriptionId !== subscriptionId
        || existingPeriod.planId !== currentPlan.id
        || existingPeriod.shopifyPlanHandleSnapshot !== provider.planHandle
        || existingPeriod.planNameSnapshot !== currentPlan.name
        || existingPeriod.planKindSnapshot !== BillingPlanKind.PAID_METERED
        || existingPeriod.includedRecoveryCreditsGranted !== currentAllowance
      )) {
        throw new Error("Initial paid activation found an incompatible billing period");
      }
      const billingPeriod = existingPeriod ?? await transaction.billingPeriod.create({
        data: {
          shopId,
          subscriptionId,
          planId: currentPlan.id,
          shopifyPlanHandleSnapshot: provider.planHandle,
          planNameSnapshot: currentPlan.name,
          planKindSnapshot: BillingPlanKind.PAID_METERED,
          includedRecoveryCreditsGranted: currentAllowance as number,
          periodStart,
          periodEnd,
          status: BillingPeriodStatus.OPEN,
        },
      });
      const existingCounter = await transaction.billingPeriodEntitlementCounter.findUnique({
        where: {
          billingPeriodId_counter: {
            billingPeriodId: billingPeriod.id,
            counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
          },
        },
      });
      if (existingCounter && (
        existingCounter.grantedQuantity !== currentAllowance
        || existingCounter.shopId !== shopId
      )) {
        throw new Error("Initial paid activation found an incompatible included-credit counter");
      }
      await transaction.billingPeriodEntitlementCounter.upsert({
        where: {
          billingPeriodId_counter: {
            billingPeriodId: billingPeriod.id,
            counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
          },
        },
        update: {},
        create: {
          shopId,
          billingPeriodId: billingPeriod.id,
          counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
          grantedQuantity: currentAllowance as number,
          committedQuantity: 0,
          reservedQuantity: 0,
          forfeitedQuantity: 0,
        },
      });
      const lifetimeCounter = await transaction.shopEntitlementCounter.findUnique({
        where: { shopId_counter: { shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" } },
      });
      if (!lifetimeCounter) {
        const policy = await transaction.platformBillingPolicy.findUnique({ where: { id: "default" }, select: { lifetimeFreeRecoveryAllowance: true } });
        if (!policy) throw new Error("PlatformBillingPolicy.default is required for first lifetime Free grant");
        await transaction.shopEntitlementCounter.create({
          data: { shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS", grantedQuantity: policy.lifetimeFreeRecoveryAllowance },
        });
      }
      await transaction.subscription.update({
        where: { id: subscriptionId },
        data: {
          planId: currentPlan.id,
          observedShopifyPlanHandle: provider.planHandle,
          status: SubscriptionProjectionStatus.ACTIVE,
          billingPeriodId: billingPeriod.id,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
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
      return true;
    });
    if (committed) await this.publishNext(shopId, subscriptionId, nextReconcileAt);
  }

  private async recordUnsupportedPaidTrial(shopId: string, expected: InitialActivationExpected): Promise<void> {
    const now = this.now();
    const updated = await this.casPendingUpdate(expected, {
      lastSyncedAt: now,
      lastSyncErrorCode: "UNSUPPORTED_PAID_TRIAL",
      lastSyncErrorAt: now,
      nextReconcileAt: null,
    });
    if (updated) {
      this.logger.warn("billing.subscription_reconciliation.unsupported_paid_trial", {
        shopId,
        subscriptionId: expected.subscriptionId,
      });
    }
  }

  private async recordPaidActivationFailure(
    shopId: string,
    expected: InitialActivationExpected,
    errorCode: "MISSING_BILLING_CYCLE" | "MISSING_USAGE_METER" | "INVALID_INCLUDED_ALLOWANCE" | "PENDING_PLAN_HANDLE_MISMATCH",
  ): Promise<void> {
    const now = this.now();
    const next = nextSubscriptionReconcileAt(expected.pendingEffectiveAt, now);
    const updated = await this.casPendingUpdate(expected, {
      lastSyncedAt: now,
      lastSyncErrorCode: errorCode,
      lastSyncErrorAt: now,
      ...(next ? { nextReconcileAt: next } : { nextReconcileAt: null }),
    });
    if (updated && next) await this.publishNext(shopId, expected.subscriptionId, next);
  }

  private async applyOtherCurrentPlan(
    shopId: string,
    subscriptionId: string,
    provider: PartnerSubscription,
    plan: { id: string; active: boolean; name: string; kind: BillingPlanKind; shopifyUsageEventHandle: string | null } | null,
    pendingShopifyPlanHandle: string,
    expectedNextReconcileAt: string,
    expected: InitialActivationExpected,
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
      await this.lockShopSettings(transaction, shopId);
      await this.lockSubscription(transaction, subscriptionId);
      const settings = await transaction.shopSettings.findUnique({ where: { shopId }, select: { onboardingCompleted: true } });
      const current = await transaction.subscription.findUnique({ where: { id: subscriptionId }, select: { status: true, planId: true, pendingPlanId: true, pendingShopifyPlanHandle: true, pendingEffectiveAt: true, nextReconcileAt: true } });
      if (!current || settings?.onboardingCompleted !== false || current.status !== SubscriptionProjectionStatus.NO_CONTRACT || current.planId !== null || current.pendingPlanId !== expected.pendingPlanId || current.pendingShopifyPlanHandle !== expected.pendingShopifyPlanHandle || current.pendingEffectiveAt?.toISOString() !== expected.pendingEffectiveAt.toISOString() || !sameDate(current.nextReconcileAt, expected.nextReconcileAt)) return;
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

  private async lockShopSettings(transaction: Prisma.TransactionClient, shopId: string): Promise<void> {
    await transaction.$queryRaw(Prisma.sql`
      SELECT "shopId"
      FROM "shopify"."ShopSettings"
      WHERE "shopId" = ${shopId}
      FOR UPDATE
    `);
  }

  private async lockShop(transaction: Prisma.TransactionClient, shopId: string): Promise<void> {
    await transaction.$queryRaw(Prisma.sql`
      SELECT "id"
      FROM "shopify"."Shop"
      WHERE "id" = ${shopId}
      FOR UPDATE
    `);
  }

  private async isReinstallAuthority(
    transaction: Prisma.TransactionClient,
    shopId: string,
    expected: ReinstallExpected,
  ): Promise<boolean> {
    const shop = await transaction.shop.findUnique({
      where: { id: shopId },
      select: { id: true, status: true, reinstallPendingAt: true },
    });
    const subscription = await transaction.subscription.findUnique({
      where: { id: expected.subscriptionId },
      select: { id: true, nextReconcileAt: true },
    });
    return shop?.id === shopId
      && shop.status === "UNINSTALLED"
      && sameDate(shop.reinstallPendingAt, expected.reinstallPendingAt)
      && subscription?.id === expected.subscriptionId
      && sameDate(subscription.nextReconcileAt, expected.nextReconcileAt);
  }

  private async lockSubscription(transaction: Prisma.TransactionClient, subscriptionId: string): Promise<void> {
    await transaction.$queryRaw(Prisma.sql`
      SELECT "id"
      FROM "billing"."Subscription"
      WHERE "id" = ${subscriptionId}
      FOR UPDATE
    `);
  }
}

export const billingSubscriptionReconciliationService = new BillingSubscriptionReconciliationService();

export { APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS };