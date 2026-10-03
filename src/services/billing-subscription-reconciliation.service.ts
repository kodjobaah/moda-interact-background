import {
  APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS,
  parseBillingSubscriptionReconcileJob,
  type BillingSubscriptionReconcileJob,
} from "@modainteract/moda-interact-shared/billing";
import { BillingPeriodEntitlementCounterKind, BillingPeriodStatus, BillingPlanKind, SubscriptionProjectionStatus } from "@prisma/client";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";

import prisma from "../lib/db.js";
import { getSubscriptionReconciliationSnapshot, shopifyPartnerBillingApi, type PartnerSubscription, type PartnerSubscriptionReconciliationSnapshot, type ShopifyPartnerBillingProvider } from "../providers/shopify-partner-billing.provider.js";
import { recoveryCapacityResumeService } from "./recovery-capacity-resume.service.js";
import { shopifyUsageEventPublisherService } from "./shopify-usage-event-publisher.service.js";
import { SamePlanBillingPeriodRolloverService } from "./same-plan-billing-period-rollover.service.js";
import { ShopifyPlanChangeTransitionService, type ShopifyPlanChangePlan } from "./shopify-plan-change-transition.service.js";
import { ShopifySubscriptionLifecycleReconciliationService } from "./shopify-subscription-lifecycle-reconciliation.service.js";
import { backgroundRuntimeConfigService, type BackgroundRuntimeConfigSnapshot } from "../runtime/background-runtime-config.js";
import { ensureCurrentBillingPeriodProjection } from "./current-billing-period-projection.service.js";
import {
  classifySubscriptionReconciliation,
  RETRYABLE_PLAN_CHANGE_SYNC_ERRORS,
  sameDate,
  type EstablishedPlanChangeExpected,
  type FreeCycleExpected,
  type InitialActivationExpected,
  type ReinstallExpected,
  type RolloverExpected,
} from "./billing-subscription-reconciliation/classification.js";
import { ReconciliationQueueService } from "./billing-subscription-reconciliation/reconciliation-queue.service.js";
export { createSubscriptionReconcilePayload } from "./billing-subscription-reconciliation/reconciliation-queue.service.js";
import type { InitialActivationPlan } from "./billing-subscription-reconciliation/types.js";
import { DiscountSyncPublisherService } from "./billing-subscription-reconciliation/discount-sync-publisher.service.js";
import { InitialActivationReconciliationService } from "./billing-subscription-reconciliation/initial-activation-reconciliation.service.js";
import { lockShop, lockShopSettings, lockSubscription } from "./billing-subscription-reconciliation/locking.js";
import { FREE_CYCLE_DISCOVERY_RETRY_MS, nextSubscriptionReconcileAt, ROLLOVER_RETRY_MS } from "./billing-subscription-reconciliation/reconciliation-timing.js";
export { FREE_CYCLE_DISCOVERY_RETRY_MS, nextSubscriptionReconcileAt, ROLLOVER_RETRY_MS } from "./billing-subscription-reconciliation/reconciliation-timing.js";
export type { InitialActivationPlan } from "./billing-subscription-reconciliation/types.js";

type SubscriptionQueue = Pick<Queue, "add">;
type BillingDatabase = PrismaClient;
type RuntimeConfigReader = { current: () => BackgroundRuntimeConfigSnapshot };

export class BillingSubscriptionReconciliationService {
  private readonly reconciliationQueue: ReconciliationQueueService;
  private readonly initialActivationReconciliation: InitialActivationReconciliationService;
  private readonly discountSyncPublisher: DiscountSyncPublisherService;

  constructor(
    private readonly database: BillingDatabase = prisma,
    private readonly partner: ShopifyPartnerBillingProvider = shopifyPartnerBillingApi,
    private readonly queue?: SubscriptionQueue,
    private readonly logger: StructuredLogger = createLogger({
      serviceName: "moda-billing-worker",
      environment: resolveDeploymentEnvironmentName(),
    }),
    private readonly now: () => Date = () => new Date(),
    private readonly runtimeConfig: RuntimeConfigReader = backgroundRuntimeConfigService,
    private readonly discountQueue?: Pick<Queue, "add">,
  ) {
    this.reconciliationQueue = new ReconciliationQueueService(this.database, this.queue, this.logger, this.now);
    this.discountSyncPublisher = new DiscountSyncPublisherService(this.database, this.discountQueue, this.logger, this.now);
    this.initialActivationReconciliation = new InitialActivationReconciliationService(
      this.database,
      this.reconciliationQueue,
      this.discountSyncPublisher,
      this.logger,
      this.now,
    );
  }

  private async publishDiscountSync(shopId: string, reason: "SUBSCRIPTION_ACTIVATED" | "REINSTALL_RECONCILED"): Promise<void> {
    await this.discountSyncPublisher.publishDiscountSync(shopId, reason);
  }

  async activateInitialPaid(
    shopId: string,
    subscriptionId: string,
    provider: PartnerSubscription,
    plan: InitialActivationPlan,
    expected: InitialActivationExpected,
  ): Promise<void> {
    await this.initialActivationReconciliation.completeVerifiedPaid(shopId, subscriptionId, provider, plan, expected);
  }

  async enqueue(job: BillingSubscriptionReconcileJob, delay = 0): Promise<void> {
    await this.reconciliationQueue.enqueue(job, delay);
  }

  async reconstruct(): Promise<number> {
    return this.reconciliationQueue.reconstruct();
  }

  async reconcileJob(input: unknown): Promise<void> {
    const job = parseBillingSubscriptionReconcileJob(input);
    const runtimeConfig = this.runtimeConfig.current();
    this.logger.info("billing.subscription_reconciliation.job_received", {
      shopId: job.shopId,
      subscriptionId: job.subscriptionId,
      expectedNextReconcileAt: job.expectedNextReconcileAt,
    });
    const logSkip = (reason: string, fields: Record<string, unknown> = {}): void => {
      this.logger.info("billing.subscription_reconciliation.job_skipped", {
        shopId: job.shopId,
        subscriptionId: job.subscriptionId,
        reason,
        ...fields,
      });
    };
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
    const classification = classifySubscriptionReconciliation(rowResult, job);
    if (classification.type === "skip") {
      logSkip(classification.reason, classification.fields);
      return;
    }
    const row = classification.row;
    if (classification.kind === "reinstall") {
      this.logger.info("billing.subscription_reconciliation.job_accepted", {
        shopId: row.id,
        subscriptionId: classification.expected.subscriptionId,
        kind: "reinstall",
      });
      await this.reconcileReinstall(
        row.id,
        classification.expected.subscriptionId,
        classification.expected.reinstallPendingAt,
        classification.expected.nextReconcileAt,
        row.shopifyShopId,
      );
      return;
    }
    const reconciliationKind = classification.kind;
    const isInitialActivation = reconciliationKind === "initial-activation";
    const isCycleDiscovery = reconciliationKind === "cycle-discovery";
    const isRollover = reconciliationKind === "rollover";
    const isFrozenReconciliation = reconciliationKind === "frozen-reconciliation";
    const isEstablishedPlanChange = reconciliationKind === "established-plan-change";
    this.logger.info("billing.subscription_reconciliation.job_accepted", {
      shopId: row.id,
      subscriptionId: row.subscription.id,
      kind: reconciliationKind,
      onboardingCompleted: row.settings?.onboardingCompleted ?? null,
      nextReconcileAt: row.subscription.nextReconcileAt.toISOString(),
    });

    const expected = classification.expected;
    const currentPlan = (isCycleDiscovery || isRollover || isEstablishedPlanChange || isFrozenReconciliation) && row.subscription.planId
      ? await this.database.billingPlan.findUnique({
          where: { id: row.subscription.planId },
          select: { id: true, active: true, name: true, kind: true, shopifyPlanHandle: true, recoveryCreditPackEnabled: true, shopifyUsageEventHandle: true, shopifyRecoveryCreditPackEventHandle: true, includedRecoveryConversationAllowance: true },
        })
      : null;
    if (isCycleDiscovery && (!currentPlan || !currentPlan.active || currentPlan.kind !== BillingPlanKind.FREE || !currentPlan.recoveryCreditPackEnabled)) {
      logSkip("cycle-discovery-plan-ineligible", { currentPlanKind: currentPlan?.kind ?? null, currentPlanActive: currentPlan?.active ?? null });
      return;
    }
    if (isRollover && (!currentPlan || !currentPlan.active || (currentPlan.kind === BillingPlanKind.FREE && !currentPlan.recoveryCreditPackEnabled))) {
      logSkip("rollover-plan-ineligible", { currentPlanKind: currentPlan?.kind ?? null, currentPlanActive: currentPlan?.active ?? null });
      return;
    }
    let snapshot: PartnerSubscriptionReconciliationSnapshot;
    try {
      this.logger.info("billing.subscription_reconciliation.provider_snapshot_requested", {
        shopId: row.id,
        subscriptionId: row.subscription.id,
        kind: reconciliationKind,
      });
      snapshot = await getSubscriptionReconciliationSnapshot(this.partner, row.shopifyShopId);
      this.logger.info("billing.subscription_reconciliation.provider_snapshot_received", {
        shopId: row.id,
        subscriptionId: row.subscription.id,
        kind: reconciliationKind,
        hasActiveSubscription: snapshot.activeSubscription !== null,
        providerPlanHandle: snapshot.activeSubscription?.planHandle ?? null,
        hasLifecycleEvent: snapshot.latestLifecycleEvent !== null,
      });
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
          runtimeConfig,
        );
      } else {
        await this.initialActivationReconciliation.recordProviderFailure(row.id, expected as InitialActivationExpected, error);
      }
      return;
    }

    if (!isInitialActivation && (snapshot.latestLifecycleEvent || isFrozenReconciliation)) {
      const lifecycleResult = await new ShopifySubscriptionLifecycleReconciliationService(this.database, undefined, undefined, runtimeConfig).reconcile(
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
      const preCloseAt = new Date(provider.currentPeriodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS);
      const next = this.now() < preCloseAt ? preCloseAt : provider.currentPeriodEnd;
      if (this.now() >= preCloseAt && this.now() < provider.currentPeriodEnd) {
        try {
          await shopifyUsageEventPublisherService.publishDue({ billingPeriodId: row.subscription.billingPeriodId!, runtimeConfig });
        } catch (error) {
          const retryAt = new Date(Math.min(this.now().getTime() + ROLLOVER_RETRY_MS, provider.currentPeriodEnd.getTime()));
          const failed = await this.database.subscription.updateMany({
            where: { id: row.subscription.id, planId: row.subscription.planId, billingPeriodId: row.subscription.billingPeriodId, nextReconcileAt: row.subscription.nextReconcileAt },
            data: {
              pendingShopifyPlanHandle: provider.pendingPlanHandle,
              pendingPlanId: pendingPlan?.active ? pendingPlan.id : null,
              pendingEffectiveAt: provider.pendingEffectiveAt,
              cancelAtPeriodEnd: provider.pendingPlanHandle ? false : provider.cancelAtPeriodEnd,
              currentPeriodEnd: provider.currentPeriodEnd,
              nextReconcileAt: retryAt,
              lastSyncedAt: this.now(),
              lastSyncErrorCode: "PRE_CLOSE_USAGE_FLUSH_FAILED",
              lastSyncErrorAt: this.now(),
            },
          });
          if (failed.count > 0) await this.publishNext(row.id, row.subscription.id, retryAt);
          return;
        }
      }
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
          ...(this.now() >= preCloseAt && row.subscription.lastSyncErrorCode === "PRE_CLOSE_USAGE_FLUSH_FAILED"
            ? { lastSyncErrorCode: null, lastSyncErrorAt: null }
            : {}),
        },
      });
      if (updated.count > 0 && next) await this.publishNext(row.id, row.subscription.id, next);
      return;
    }
    if (isRollover && currentPlan && row.subscription.currentPeriodEnd) {
      const now = this.now();
      const preCloseAt = new Date(row.subscription.currentPeriodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS);
      if (now < row.subscription.currentPeriodEnd) {
        await this.reconcilePreClose(row.id, expected as RolloverExpected, preCloseAt, runtimeConfig);
        return;
      }
    }

    if (!provider) {
      if (isCycleDiscovery) {
        await this.recordMissingCycle(row.id, expected as FreeCycleExpected);
      } else if (isRollover) {
        await this.recordRolloverRetry(row.id, expected as RolloverExpected);
      } else if (isEstablishedPlanChange) {
        await this.recordEstablishedPlanChangeRetry(row.id, expected as EstablishedPlanChangeExpected, "PROVIDER_STATE_UNRESOLVED");
      } else {
        await this.initialActivationReconciliation.recordMissingSubscription(row.id, expected as InitialActivationExpected);
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
        await this.initialActivationReconciliation.completeVerifiedFree(
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
      await this.initialActivationReconciliation.completeVerifiedPaid(
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
      await this.initialActivationReconciliation.recordPaidActivationFailure(
        row.id,
        expected as InitialActivationExpected,
        "PENDING_PLAN_HANDLE_MISMATCH",
      );
      return;
    }

    await this.initialActivationReconciliation.applyOtherCurrentPlan(
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
      if (!(await this.isReinstallAuthority(transaction, shopId, expected))) return { kind: "stale" as const };
      await transaction.subscription.update({ where: { id: expected.subscriptionId }, data: {
        planId: null, observedShopifyPlanHandle: null, status: SubscriptionProjectionStatus.NO_CONTRACT,
        billingPeriodId: null, currentPeriodStart: null, currentPeriodEnd: null, trialEndsAt: null,
        cancelAtPeriodEnd: false, providerSubscriptionId: null, pendingShopifyPlanHandle: null,
        pendingPlanId: null, pendingEffectiveAt: null, nextReconcileAt: null, lastSyncedAt: now,
        lastSyncErrorCode: null, lastSyncErrorAt: null,
      } });
      await transaction.shop.update({ where: { id: shopId }, data: { status: "ACTIVE", uninstalledAt: null, reinstallPendingAt: null } });
      if (transaction.shopifyDiscountCatalogue && transaction.shopifyDiscount) {
        const catalogue = await transaction.shopifyDiscountCatalogue.upsert({ where: { shopId }, create: { shopId, status: "UNAVAILABLE", unavailableAt: now }, update: { status: "UNAVAILABLE", activeSyncToken: null, syncStartedAt: null } });
        await transaction.shopifyDiscount.updateMany({ where: { shopId }, data: { isAvailable: false } });
        if (catalogue.unavailableAt === null) await transaction.shopifyDiscountCatalogue.update({ where: { shopId }, data: { unavailableAt: now } });
        await transaction.shopifyDiscount.updateMany({ where: { shopId, unavailableAt: null }, data: { unavailableAt: now } });
      }
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
      if (!(await this.isReinstallAuthority(transaction, shopId, expected))) return { kind: "stale" as const };
      const pendingPlan = provider.pendingPlanHandle
        ? await transaction.billingPlan.findUnique({ where: { shopifyPlanHandle: provider.pendingPlanHandle }, select: { id: true, active: true } })
        : null;
      const period = provider.currentPeriodStart && provider.currentPeriodEnd
        ? await ensureCurrentBillingPeriodProjection(transaction, {
            shopId,
            subscriptionId: expected.subscriptionId,
            periodStart: provider.currentPeriodStart,
            periodEnd: provider.currentPeriodEnd,
            providerPlanHandle: provider.planHandle,
            plan,
          })
        : { kind: "CONFLICT" as const, billingPeriodId: null, reason: "INVALID_INCLUDED_ALLOWANCE" as const };
      if (period.kind === "CONFLICT") {
        const nextReconcileAt = new Date(now.getTime() + ROLLOVER_RETRY_MS);
        await transaction.subscription.update({ where: { id: expected.subscriptionId }, data: {
          status: SubscriptionProjectionStatus.SYNC_ERROR,
          lastSyncErrorCode: "BILLING_PERIOD_PLAN_CONFLICT",
          lastSyncErrorAt: now,
          nextReconcileAt,
        } });
        return { kind: "conflict" as const, nextReconcileAt };
      }
      await transaction.subscription.update({ where: { id: expected.subscriptionId }, data: {
        planId: plan.id, observedShopifyPlanHandle: provider.planHandle,
        status: provider.status === "TRIALING" ? SubscriptionProjectionStatus.TRIALING : SubscriptionProjectionStatus.ACTIVE,
        billingPeriodId: period.billingPeriodId, currentPeriodStart: provider.currentPeriodStart, currentPeriodEnd: provider.currentPeriodEnd,
        trialEndsAt: provider.trialEndsAt, cancelAtPeriodEnd: provider.cancelAtPeriodEnd, providerSubscriptionId: provider.providerSubscriptionId,
        pendingShopifyPlanHandle: provider.pendingPlanHandle, pendingPlanId: pendingPlan?.active ? pendingPlan.id : null,
        pendingEffectiveAt: provider.pendingEffectiveAt, nextReconcileAt: next,
        lastSyncedAt: now, lastSyncErrorCode: null, lastSyncErrorAt: null,
      } });
      await transaction.shopSettings.update({ where: { shopId }, data: { onboardingCompleted: true } });
      await transaction.shop.update({ where: { id: shopId }, data: { status: "ACTIVE", uninstalledAt: null, reinstallPendingAt: null } });
      return { kind: "committed" as const };
    });
    if (committed.kind === "conflict") {
      await this.publishNext(shopId, expected.subscriptionId, committed.nextReconcileAt);
    } else if (committed.kind === "committed") {
      await this.publishDiscountSync(shopId, "REINSTALL_RECONCILED");
      if (next) await this.publishNext(shopId, expected.subscriptionId, next);
    }
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
        await this.publishDiscountSync(shopId, "REINSTALL_RECONCILED");
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
    if (committed === true) {
      await this.publishDiscountSync(shopId, "REINSTALL_RECONCILED");
      await this.publishNext(shopId, expected.subscriptionId, next);
    }
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

  private async recordFrozenProviderFailure(
    shopId: string,
    subscriptionId: string,
    consumedAt: Date,
    planId: string,
    error: unknown,
    runtimeConfig: BackgroundRuntimeConfigSnapshot,
  ): Promise<void> {
    const now = this.now();
    const next = new Date(now.getTime() + runtimeConfig.billingFrozenRecheckSeconds * 1000);
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

  private async publishNext(shopId: string, subscriptionId: string, next: Date): Promise<void> {
    await this.reconciliationQueue.publishNext(shopId, subscriptionId, next);
  }

  private async publishCommittedLifecycleSchedule(shopId: string, subscriptionId: string): Promise<void> {
    await this.reconciliationQueue.publishCommittedLifecycleSchedule(shopId, subscriptionId);
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
    runtimeConfig: BackgroundRuntimeConfigSnapshot,
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
      await shopifyUsageEventPublisherService.publishDue({ billingPeriodId: expected.billingPeriodId, runtimeConfig });
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
    plan: { id: string; active: boolean; name: string; kind: BillingPlanKind; shopifyPlanHandle: string; recoveryCreditPackEnabled: boolean; shopifyUsageEventHandle: string | null; includedRecoveryConversationAllowance: number | null },
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
      if (!current || (current.status !== SubscriptionProjectionStatus.ACTIVE && current.status !== SubscriptionProjectionStatus.TRIALING) || current.planId !== expected.currentPlanId || current.billingPeriodId !== null || current.pendingPlanId !== null || current.pendingShopifyPlanHandle !== null || current.pendingEffectiveAt !== null || current.nextReconcileAt?.toISOString() !== expected.nextReconcileAt.toISOString()) return { kind: "stale" as const };
      const billingPeriod = await ensureCurrentBillingPeriodProjection(transaction, {
        shopId,
        subscriptionId: expected.subscriptionId,
        periodStart,
        periodEnd,
        providerPlanHandle: provider.planHandle,
        plan,
      });
      if (billingPeriod.kind === "CONFLICT") {
        const nextReconcileAt = new Date(now.getTime() + ROLLOVER_RETRY_MS);
        await transaction.subscription.update({ where: { id: expected.subscriptionId }, data: { status: SubscriptionProjectionStatus.SYNC_ERROR, lastSyncErrorCode: "BILLING_PERIOD_PLAN_CONFLICT", lastSyncErrorAt: now, nextReconcileAt } });
        return { kind: "conflict" as const, nextReconcileAt };
      }
      await transaction.subscription.update({
        where: { id: expected.subscriptionId },
        data: { billingPeriodId: billingPeriod.billingPeriodId, currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, providerSubscriptionId: provider.providerSubscriptionId, trialEndsAt: provider.trialEndsAt, cancelAtPeriodEnd: provider.cancelAtPeriodEnd, nextReconcileAt: next, lastSyncedAt: now, lastSyncErrorCode: null, lastSyncErrorAt: null },
      });
      return { kind: "committed" as const };
    });
    if (committed.kind === "conflict") await this.publishNext(shopId, expected.subscriptionId, committed.nextReconcileAt);
    if (committed.kind === "committed") await this.publishNext(shopId, expected.subscriptionId, next);
  }

  private async lockShopSettings(transaction: Prisma.TransactionClient, shopId: string): Promise<void> {
    await lockShopSettings(transaction, shopId);
  }

  private async lockShop(transaction: Prisma.TransactionClient, shopId: string): Promise<void> {
    await lockShop(transaction, shopId);
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
    await lockSubscription(transaction, subscriptionId);
  }
}

export const billingSubscriptionReconciliationService = new BillingSubscriptionReconciliationService();

export { APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS };