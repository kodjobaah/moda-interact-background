import {
  APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS,
  parseBillingSubscriptionReconcileJob,
  type BillingSubscriptionReconcileJob,
} from "@modainteract/moda-interact-shared/billing";
import { BillingPlanKind, SubscriptionProjectionStatus } from "@prisma/client";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";

import prisma from "../lib/db.js";
import { getSubscriptionReconciliationSnapshot, shopifyPartnerBillingApi, type PartnerSubscription, type PartnerSubscriptionReconciliationSnapshot, type ShopifyPartnerBillingProvider } from "../providers/shopify-partner-billing.provider.js";
import { recoveryCapacityResumeService } from "./recovery-capacity-resume.service.js";
import { ShopifyPlanChangeTransitionService, type ShopifyPlanChangePlan } from "./shopify-plan-change-transition.service.js";
import { ShopifySubscriptionLifecycleReconciliationService } from "./shopify-subscription-lifecycle-reconciliation.service.js";
import { backgroundRuntimeConfigService, type BackgroundRuntimeConfigSnapshot } from "../runtime/background-runtime-config.js";
import {
  classifySubscriptionReconciliation,
  RETRYABLE_PLAN_CHANGE_SYNC_ERRORS,
  type EstablishedPlanChangeExpected,
  type InitialActivationExpected,
  type RolloverExpected,
} from "./billing-subscription-reconciliation/classification.js";
import { ReconciliationQueueService } from "./billing-subscription-reconciliation/reconciliation-queue.service.js";
export { createSubscriptionReconcilePayload } from "./billing-subscription-reconciliation/reconciliation-queue.service.js";
import type { InitialActivationPlan } from "./billing-subscription-reconciliation/types.js";
import { DiscountSyncPublisherService } from "./billing-subscription-reconciliation/discount-sync-publisher.service.js";
import { InitialActivationReconciliationService } from "./billing-subscription-reconciliation/initial-activation-reconciliation.service.js";
import { ReinstallReconciliationService } from "./billing-subscription-reconciliation/reinstall-reconciliation.service.js";
import { BillingCycleReconciliationService } from "./billing-subscription-reconciliation/billing-cycle-reconciliation.service.js";
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
  private readonly reinstallReconciliation: ReinstallReconciliationService;
  private readonly billingCycleReconciliation: BillingCycleReconciliationService;

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
    this.reinstallReconciliation = new ReinstallReconciliationService(
      this.database,
      this.partner,
      this.reconciliationQueue,
      this.discountSyncPublisher,
      this.logger,
      this.now,
    );
    this.billingCycleReconciliation = new BillingCycleReconciliationService(
      this.database,
      this.reconciliationQueue,
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
      await this.reinstallReconciliation.reconcileReinstall(
        row.id,
        classification.expected,
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
        await this.billingCycleReconciliation.recordProviderFailure(
          row.id,
          "cycle-discovery",
          expected as RolloverExpected,
          error,
        );
      } else if (isRollover) {
        await this.billingCycleReconciliation.recordProviderFailure(
          row.id,
          "rollover",
          expected as RolloverExpected,
          error,
        );
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
    if ((isCycleDiscovery || isRollover) && currentPlan) {
      await this.billingCycleReconciliation.reconcileAccepted({
        shopId: row.id,
        kind: isCycleDiscovery ? "cycle-discovery" : "rollover",
        expected: expected as RolloverExpected,
        provider,
        plan: currentPlan,
        runtimeConfig,
        subscription: {
          planId: row.subscription.planId,
          billingPeriodId: row.subscription.billingPeriodId,
          currentPeriodStart: row.subscription.currentPeriodStart,
          currentPeriodEnd: row.subscription.currentPeriodEnd,
          cancelAtPeriodEnd: row.subscription.cancelAtPeriodEnd,
          lastSyncErrorCode: row.subscription.lastSyncErrorCode,
        },
      });
      return;
    }
    if (!provider) {
      if (isEstablishedPlanChange) {
        await this.recordEstablishedPlanChangeRetry(row.id, expected as EstablishedPlanChangeExpected, "PROVIDER_STATE_UNRESOLVED");
      } else {
        await this.initialActivationReconciliation.recordMissingSubscription(row.id, expected as InitialActivationExpected);
      }
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

  private async lockShopSettings(transaction: Prisma.TransactionClient, shopId: string): Promise<void> {
    await lockShopSettings(transaction, shopId);
  }

  private async lockShop(transaction: Prisma.TransactionClient, shopId: string): Promise<void> {
    await lockShop(transaction, shopId);
  }

  private async lockSubscription(transaction: Prisma.TransactionClient, subscriptionId: string): Promise<void> {
    await lockSubscription(transaction, subscriptionId);
  }
}

export const billingSubscriptionReconciliationService = new BillingSubscriptionReconciliationService();

export { APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS };