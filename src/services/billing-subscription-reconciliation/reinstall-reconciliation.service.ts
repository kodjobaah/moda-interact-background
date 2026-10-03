import { APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS } from "@modainteract/moda-interact-shared/billing";
import { BillingPeriodEntitlementCounterKind, BillingPeriodStatus, BillingPlanKind, SubscriptionProjectionStatus } from "@prisma/client";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";

import type { PartnerSubscription, ShopifyPartnerBillingProvider } from "../../providers/shopify-partner-billing.provider.js";
import { ensureCurrentBillingPeriodProjection } from "../current-billing-period-projection.service.js";
import { SamePlanBillingPeriodRolloverService } from "../same-plan-billing-period-rollover.service.js";
import { lockShop, lockShopSettings, lockSubscription } from "./locking.js";
import { sameDate, type ReinstallExpected } from "./classification.js";
import { nextSubscriptionReconcileAt, ROLLOVER_RETRY_MS } from "./reconciliation-timing.js";
import type { InitialActivationPlan } from "./types.js";

type ReconciliationQueuePublisher = {
  publishNext(shopId: string, subscriptionId: string, next: Date): Promise<void>;
};

type DiscountPublisher = {
  publishDiscountSync(shopId: string, reason: "SUBSCRIPTION_ACTIVATED" | "REINSTALL_RECONCILED"): Promise<void>;
};

export class ReinstallReconciliationService {
  constructor(
    private readonly database: PrismaClient,
    private readonly partner: ShopifyPartnerBillingProvider,
    private readonly reconciliationQueue: ReconciliationQueuePublisher,
    private readonly discountPublisher: DiscountPublisher,
    private readonly logger: StructuredLogger,
    private readonly now: () => Date,
  ) {}

  async reconcileReinstall(
    shopId: string,
    expected: ReinstallExpected,
    shopifyShopId: string,
  ): Promise<void> {
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
      await lockShop(transaction, shopId);
      await lockShopSettings(transaction, shopId);
      await lockSubscription(transaction, expected.subscriptionId);
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
      await lockShop(transaction, shopId);
      await lockShopSettings(transaction, shopId);
      await lockSubscription(transaction, expected.subscriptionId);
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
        await lockShop(transaction, shopId);
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
      await lockShop(transaction, shopId);
      await lockShopSettings(transaction, shopId);
      await lockSubscription(transaction, expected.subscriptionId);
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
      await lockShopSettings(transaction, shopId);
      await lockSubscription(transaction, expected.subscriptionId);
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

  private async publishNext(shopId: string, subscriptionId: string, next: Date): Promise<void> {
    await this.reconciliationQueue.publishNext(shopId, subscriptionId, next);
  }

  private async publishDiscountSync(shopId: string, reason: "REINSTALL_RECONCILED"): Promise<void> {
    await this.discountPublisher.publishDiscountSync(shopId, reason);
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
}