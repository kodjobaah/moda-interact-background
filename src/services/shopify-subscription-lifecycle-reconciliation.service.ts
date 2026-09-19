import {
  BillingPeriodCloseReason,
  BillingPeriodEntitlementCounterKind,
  BillingPeriodStatus,
  BillingPlanKind,
  Prisma,
  ShopifyReportState,
  SubscriptionProjectionStatus,
  UsageReservationReleaseReason,
  UsageReservationStatus,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS } from "@modainteract/moda-interact-shared/billing";

import type {
  PartnerSubscription,
  PartnerSubscriptionLifecycleEvent,
  PartnerSubscriptionReconciliationSnapshot,
} from "../providers/shopify-partner-billing.provider.js";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import { recoveryCapacityResumeService } from "./recovery-capacity-resume.service.js";
import type { BackgroundRuntimeConfigSnapshot } from "../runtime/background-runtime-config.js";
import { SamePlanBillingPeriodRolloverService } from "./same-plan-billing-period-rollover.service.js";
import { ShopifyPlanChangeTransitionService } from "./shopify-plan-change-transition.service.js";


type LifecycleDatabase = Pick<PrismaClient, "$transaction">;
type ResumeService = Pick<typeof recoveryCapacityResumeService, "schedule">;

export type LifecycleReconciliationResult = "handled" | "continue" | "restored";

export class ShopifySubscriptionLifecycleReconciliationService {
  constructor(
    private readonly database: LifecycleDatabase,
    private readonly resumeService: ResumeService = recoveryCapacityResumeService,
    private readonly logger: StructuredLogger = createLogger({ serviceName: "moda-billing-worker", environment: resolveDeploymentEnvironmentName() }),
    private readonly runtimeConfig?: Pick<BackgroundRuntimeConfigSnapshot, "billingFrozenRecheckSeconds" | "billingProviderRetrySeconds">,
  ) {}

  private frozenReconcileIntervalMs(): number { return (this.runtimeConfig?.billingFrozenRecheckSeconds ?? 3600) * 1000; }
  private providerRetryIntervalMs(): number { return (this.runtimeConfig?.billingProviderRetrySeconds ?? 300) * 1000; }

  async reconcile(
    shopId: string,
    subscriptionId: string,
    snapshot: PartnerSubscriptionReconciliationSnapshot,
    now: Date,
  ): Promise<LifecycleReconciliationResult> {
    const lifecycle = snapshot.latestLifecycleEvent;
    const active = snapshot.activeSubscription;
    if (!lifecycle) {
      if (!active) {
        await this.recordUnresolved(shopId, subscriptionId, now);
        return "handled";
      }
      return "continue";
    }

    const ordering = await this.database.$transaction(async (transaction) => {
      await lockSubscription(transaction, subscriptionId);
      const current = await transaction.subscription.findUnique({
        where: { id: subscriptionId },
        select: { status: true, lastProviderLifecycleEventAt: true, lastProviderLifecycleEventId: true },
      });
      if (!isStrictlyOlder(current?.lastProviderLifecycleEventAt ?? null, current?.lastProviderLifecycleEventId ?? null, lifecycle)) {
        return { kind: "continue" as const };
      }
      if (current?.status === SubscriptionProjectionStatus.FROZEN) {
        await transaction.subscription.update({
          where: { id: subscriptionId },
          data: {
            nextReconcileAt: new Date(now.getTime() + this.frozenReconcileIntervalMs()),
            lastSyncedAt: now,
          },
        });
        return { kind: "handled" as const };
      }
      if (!active) {
        await transaction.subscription.update({
          where: { id: subscriptionId },
          data: {
            nextReconcileAt: new Date(now.getTime() + this.providerRetryIntervalMs()),
            lastSyncedAt: now,
            lastSyncErrorCode: "PROVIDER_STATE_UNRESOLVED",
            lastSyncErrorAt: now,
          },
        });
        return { kind: "handled" as const };
      }
      return { kind: "stale-continue" as const };
    });
    if (ordering.kind === "handled") {
      return "handled";
    }
    if (ordering.kind === "stale-continue") {
      return "continue";
    }

    if (active === null && lifecycle.state === "CANCELED") {
      await this.cancel(shopId, subscriptionId, lifecycle, now);
      return "handled";
    }
    if (lifecycle.state === "FROZEN") {
      await this.freeze(subscriptionId, lifecycle, active, now);
      return "handled";
    }
    const current = await this.database.$transaction(async (transaction) => {
      await lockSubscription(transaction, subscriptionId);
      return transaction.subscription.findUnique({
        where: { id: subscriptionId },
        select: { status: true, planId: true, currentPeriodStart: true, currentPeriodEnd: true },
      });
    });
    if (!active && current?.status === SubscriptionProjectionStatus.FROZEN && lifecycle.state === "UNFROZEN") {
      await this.recordUnfrozenWithoutContract(subscriptionId, lifecycle, now);
      return "handled";
    }
    if (!active) {
      await this.recordUnresolved(shopId, subscriptionId, now, lifecycle);
      return "handled";
    }
    if (current?.status !== SubscriptionProjectionStatus.FROZEN || lifecycle.state !== "UNFROZEN") return "continue";
    const restored = await this.restore(shopId, subscriptionId, active, lifecycle, now);
    if (!restored) return "handled";
    try {
      await this.resumeService.schedule({ shopId, trigger: "unfreeze" });
    } catch (error) {
      this.logger.warn("billing.recovery_capacity_resume.enqueue_failed", { shopId, errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure" });
    }
    return "restored";
  }

  private async freeze(subscriptionId: string, lifecycle: PartnerSubscriptionLifecycleEvent, active: PartnerSubscription | null, now: Date): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await lockSubscription(transaction, subscriptionId);
      const current = await transaction.subscription.findUnique({
        where: { id: subscriptionId },
        select: { status: true, lastProviderLifecycleEventAt: true, lastProviderLifecycleEventId: true, lastSyncErrorCode: true },
      });
      if (isStrictlyOlder(current?.lastProviderLifecycleEventAt ?? null, current?.lastProviderLifecycleEventId ?? null, lifecycle)) {
        if (current?.status === SubscriptionProjectionStatus.FROZEN) {
          await transaction.subscription.update({ where: { id: subscriptionId }, data: { nextReconcileAt: new Date(now.getTime() + this.frozenReconcileIntervalMs()), lastSyncedAt: now } });
        }
        return;
      }
      const replay = isSameEvent(current?.lastProviderLifecycleEventAt ?? null, current?.lastProviderLifecycleEventId ?? null, lifecycle);
      const clearError = current?.lastSyncErrorCode === "UNFROZEN_LIVE_CONTRACT_PENDING"
        || current?.lastSyncErrorCode === "PROVIDER_STATE_UNRESOLVED"
        || current?.lastSyncErrorCode === "PARTNER_API_ERROR";
      await transaction.subscription.update({
        where: { id: subscriptionId },
        data: {
          status: SubscriptionProjectionStatus.FROZEN,
          ...(active ? { cancelAtPeriodEnd: active.cancelAtPeriodEnd } : {}),
          nextReconcileAt: new Date(now.getTime() + this.frozenReconcileIntervalMs()),
          lastSyncedAt: now,
          ...(clearError ? { lastSyncErrorCode: null, lastSyncErrorAt: null } : {}),
          ...(replay ? {} : { lastProviderLifecycleState: lifecycle.state, lastProviderLifecycleEventId: lifecycle.id, lastProviderLifecycleEventAt: lifecycle.occurredAt }),
        },
      });
    });
  }

  private async recordUnresolved(_shopId: string, subscriptionId: string, now: Date, lifecycle?: PartnerSubscriptionLifecycleEvent): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await lockSubscription(transaction, subscriptionId);
      const current = await transaction.subscription.findUnique({
        where: { id: subscriptionId },
        select: { status: true, lastProviderLifecycleEventAt: true, lastProviderLifecycleEventId: true },
      });
      const frozen = current?.status === SubscriptionProjectionStatus.FROZEN;
      const older = lifecycle && isStrictlyOlder(current?.lastProviderLifecycleEventAt ?? null, current?.lastProviderLifecycleEventId ?? null, lifecycle);
      await transaction.subscription.update({
        where: { id: subscriptionId },
        data: {
          nextReconcileAt: new Date(now.getTime() + (frozen ? this.frozenReconcileIntervalMs() : this.providerRetryIntervalMs())),
          lastSyncedAt: now,
          lastSyncErrorCode: lifecycle?.state === "UNFROZEN" && !older ? "UNFROZEN_LIVE_CONTRACT_PENDING" : "PROVIDER_STATE_UNRESOLVED",
          lastSyncErrorAt: now,
          ...(lifecycle && !older ? {
            lastProviderLifecycleState: lifecycle.state,
            lastProviderLifecycleEventId: lifecycle.id,
            lastProviderLifecycleEventAt: lifecycle.occurredAt,
          } : {}),
        },
      });
    });
  }

  private async recordUnfrozenWithoutContract(subscriptionId: string, lifecycle: PartnerSubscriptionLifecycleEvent, now: Date): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await lockSubscription(transaction, subscriptionId);
      const current = await transaction.subscription.findUnique({ where: { id: subscriptionId }, select: { lastProviderLifecycleEventAt: true, lastProviderLifecycleEventId: true } });
      if (isStrictlyOlder(current?.lastProviderLifecycleEventAt ?? null, current?.lastProviderLifecycleEventId ?? null, lifecycle)) return;
      await transaction.subscription.update({ where: { id: subscriptionId }, data: {
        status: SubscriptionProjectionStatus.FROZEN,
        nextReconcileAt: new Date(now.getTime() + this.frozenReconcileIntervalMs()),
        lastSyncedAt: now,
        lastSyncErrorCode: "UNFROZEN_LIVE_CONTRACT_PENDING",
        lastSyncErrorAt: now,
        lastProviderLifecycleState: lifecycle.state,
        lastProviderLifecycleEventId: lifecycle.id,
        lastProviderLifecycleEventAt: lifecycle.occurredAt,
      } });
    });
  }

  private async restore(shopId: string, subscriptionId: string, provider: PartnerSubscription, lifecycle: PartnerSubscriptionLifecycleEvent, now: Date): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      await lockSubscription(transaction, subscriptionId);
      const subscription = await transaction.subscription.findUnique({ where: { id: subscriptionId }, include: { billingPeriod: true, plan: true } });
      if (!subscription || subscription.status !== SubscriptionProjectionStatus.FROZEN || isStrictlyOlder(subscription.lastProviderLifecycleEventAt, subscription.lastProviderLifecycleEventId, lifecycle)) return false;
      const plan = await transaction.billingPlan.findUnique({ where: { shopifyPlanHandle: provider.planHandle } });
      if (!plan?.active) {
        await this.updateUnfreezeFailure(transaction, subscriptionId, subscription, provider, lifecycle, now, "UNMAPPED_PLAN_HANDLE", SubscriptionProjectionStatus.UNMAPPED);
        return false;
      }
      const planInput = {
        id: plan.id,
        active: plan.active,
        name: plan.name,
        kind: plan.kind,
        shopifyPlanHandle: plan.shopifyPlanHandle,
        includedRecoveryConversationAllowance: plan.includedRecoveryConversationAllowance,
        recoveryCreditPackEnabled: plan.recoveryCreditPackEnabled,
        shopifyUsageEventHandle: plan.shopifyUsageEventHandle,
        shopifyRecoveryCreditPackEventHandle: plan.shopifyRecoveryCreditPackEventHandle,
      };
      const configurationError = validateProviderPlan(planInput, provider);
      if (configurationError) {
        await this.updateUnfreezeFailure(transaction, subscriptionId, subscription, provider, lifecycle, now, configurationError, configurationError === "UNMAPPED_PLAN_HANDLE" ? SubscriptionProjectionStatus.UNMAPPED : SubscriptionProjectionStatus.SYNC_ERROR);
        return false;
      }
      const samePlan = subscription.planId === plan.id;
      const sameCycle = samePlan
        && subscription.currentPeriodStart?.getTime() === provider.currentPeriodStart?.getTime()
        && subscription.currentPeriodEnd?.getTime() === provider.currentPeriodEnd?.getTime();
      if (sameCycle) {
        const pendingPlan = provider.pendingPlanHandle
          ? await transaction.billingPlan.findUnique({ where: { shopifyPlanHandle: provider.pendingPlanHandle }, select: { id: true, active: true } })
          : null;
        await transaction.subscription.update({ where: { id: subscriptionId }, data: {
          status: provider.status === "TRIALING" ? SubscriptionProjectionStatus.TRIALING : SubscriptionProjectionStatus.ACTIVE,
          observedShopifyPlanHandle: provider.planHandle,
          providerSubscriptionId: provider.providerSubscriptionId,
          trialEndsAt: provider.trialEndsAt,
          cancelAtPeriodEnd: provider.cancelAtPeriodEnd,
          pendingShopifyPlanHandle: provider.pendingPlanHandle,
          pendingPlanId: pendingPlan?.active ? pendingPlan.id : null,
          pendingEffectiveAt: provider.pendingEffectiveAt,
          lastSyncedAt: now,
          ...(lifecycleErrorCleared(subscription.lastSyncErrorCode) ? { lastSyncErrorCode: null, lastSyncErrorAt: null } : {}),
          lastProviderLifecycleState: lifecycle.state,
          lastProviderLifecycleEventId: lifecycle.id,
          lastProviderLifecycleEventAt: lifecycle.occurredAt,
          nextReconcileAt: provider.currentPeriodEnd ? nextCycleReconcileAt(provider.currentPeriodEnd, now) : new Date(now.getTime() + this.providerRetryIntervalMs()),
        } });
        return true;
      }
      await transaction.subscription.update({ where: { id: subscriptionId }, data: { status: SubscriptionProjectionStatus.ACTIVE } });
      const transition = samePlan
        ? await new SamePlanBillingPeriodRolloverService({ $transaction: async (callback: (client: typeof transaction) => unknown) => callback(transaction) } as never).transitionInTransaction(transaction, { shopId, subscriptionId, provider, plan: planInput, now })
        : await new ShopifyPlanChangeTransitionService({ $transaction: async (callback: (client: typeof transaction) => unknown) => callback(transaction) } as never).transitionInTransaction(transaction, { shopId, subscriptionId, provider, plan: planInput, expectedCurrentPlanId: subscription.planId ?? "", now });
      if (transition.kind !== "transitioned" && transition.kind !== "unchanged") {
        await transaction.subscription.update({ where: { id: subscriptionId }, data: { status: SubscriptionProjectionStatus.SYNC_ERROR, lastSyncedAt: now, lastSyncErrorCode: "UNEXPECTED_IMMEDIATE_PLAN_CHANGE", lastSyncErrorAt: now, nextReconcileAt: new Date(now.getTime() + this.providerRetryIntervalMs()), lastProviderLifecycleState: lifecycle.state, lastProviderLifecycleEventId: lifecycle.id, lastProviderLifecycleEventAt: lifecycle.occurredAt } });
        return false;
      }
      await transaction.subscription.update({ where: { id: subscriptionId }, data: {
        lastSyncedAt: now,
        ...(lifecycleErrorCleared(subscription.lastSyncErrorCode) ? { lastSyncErrorCode: null, lastSyncErrorAt: null } : {}),
        lastProviderLifecycleState: lifecycle.state,
        lastProviderLifecycleEventId: lifecycle.id,
        lastProviderLifecycleEventAt: lifecycle.occurredAt,
      } });
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async updateUnfreezeFailure(transaction: Prisma.TransactionClient, subscriptionId: string, subscription: { pendingShopifyPlanHandle: string | null; pendingPlanId: string | null; pendingEffectiveAt: Date | null }, provider: PartnerSubscription, lifecycle: PartnerSubscriptionLifecycleEvent, now: Date, errorCode: string, status: SubscriptionProjectionStatus): Promise<void> {
    const pendingPlan = provider.pendingPlanHandle
      ? await transaction.billingPlan.findUnique({ where: { shopifyPlanHandle: provider.pendingPlanHandle }, select: { id: true, active: true } })
      : null;
    await transaction.subscription.update({ where: { id: subscriptionId }, data: {
      status,
      observedShopifyPlanHandle: provider.planHandle,
      pendingShopifyPlanHandle: provider.pendingPlanHandle,
      pendingPlanId: pendingPlan?.active ? pendingPlan.id : null,
      pendingEffectiveAt: provider.pendingEffectiveAt,
      cancelAtPeriodEnd: provider.pendingPlanHandle ? false : provider.cancelAtPeriodEnd,
      lastSyncedAt: now,
      lastSyncErrorCode: errorCode,
      lastSyncErrorAt: now,
      nextReconcileAt: new Date(now.getTime() + this.providerRetryIntervalMs()),
      lastProviderLifecycleState: lifecycle.state,
      lastProviderLifecycleEventId: lifecycle.id,
      lastProviderLifecycleEventAt: lifecycle.occurredAt,
    } });
  }

  private async cancel(shopId: string, subscriptionId: string, lifecycle: PartnerSubscriptionLifecycleEvent, now: Date): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await lockSubscription(transaction, subscriptionId);
      const subscription = await transaction.subscription.findUnique({
        where: { id: subscriptionId },
        include: { billingPeriod: true },
      });
      if (!subscription || isStrictlyOlder(subscription.lastProviderLifecycleEventAt, subscription.lastProviderLifecycleEventId, lifecycle)) return;
      const established = subscription.planId !== null || subscription.providerSubscriptionId !== null || subscription.billingPeriodId !== null;
      if (!established && subscription.status === SubscriptionProjectionStatus.NO_CONTRACT) return;
      const period = subscription.billingPeriod;
      if (period?.status === BillingPeriodStatus.OPEN) {
        await transaction.usageEvent.updateMany({
          where: { billingPeriodId: period.id, shopifyReportState: { in: [ShopifyReportState.PENDING, ShopifyReportState.RETRYABLE] } },
          data: { shopifyReportState: ShopifyReportState.NEEDS_ATTENTION, nextReportAt: null, providerErrorCode: "PERIOD_CLOSED_BEFORE_REPORT" },
        });
        if (period.planKindSnapshot === BillingPlanKind.PAID_METERED) await closePaidPeriod(transaction, period.id);
        const closed = await transaction.billingPeriod.updateMany({ where: { id: period.id, status: BillingPeriodStatus.OPEN }, data: { status: BillingPeriodStatus.CLOSED, closedAt: now, closeReason: BillingPeriodCloseReason.CONTRACT_ENDED } });
        if (closed.count !== 1) throw new Error("Billing period was not open while closing contract");
      }
      await transaction.subscription.update({
        where: { id: subscriptionId },
        data: {
          planId: null, observedShopifyPlanHandle: null, status: SubscriptionProjectionStatus.NO_CONTRACT,
          billingPeriodId: null, currentPeriodStart: null, currentPeriodEnd: null, trialEndsAt: null,
          cancelAtPeriodEnd: false, providerSubscriptionId: null, pendingShopifyPlanHandle: null,
          pendingPlanId: null, pendingEffectiveAt: null, nextReconcileAt: null, lastSyncedAt: now,
          lastSyncErrorCode: null, lastSyncErrorAt: null, lastProviderLifecycleState: lifecycle.state,
          lastProviderLifecycleEventId: lifecycle.id, lastProviderLifecycleEventAt: lifecycle.occurredAt,
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}

function validateProviderPlan(
  plan: {
    active: boolean;
    kind: BillingPlanKind;
    includedRecoveryConversationAllowance: number | null;
    recoveryCreditPackEnabled: boolean;
    shopifyUsageEventHandle: string | null;
    shopifyRecoveryCreditPackEventHandle: string | null;
  },
  provider: PartnerSubscription,
): "UNMAPPED_PLAN_HANDLE" | "MISSING_BILLING_CYCLE" | "INVALID_INCLUDED_ALLOWANCE" | "MISSING_USAGE_METER" | null {
  if (!plan.active) return "UNMAPPED_PLAN_HANDLE";
  const needsCycle = plan.kind === BillingPlanKind.PAID_METERED
    || (plan.kind === BillingPlanKind.FREE && plan.recoveryCreditPackEnabled);
  if (needsCycle && (!provider.currentPeriodStart || !provider.currentPeriodEnd || provider.currentPeriodStart >= provider.currentPeriodEnd)) {
    return "MISSING_BILLING_CYCLE";
  }
  if (plan.kind === BillingPlanKind.PAID_METERED) {
    if (!Number.isSafeInteger(plan.includedRecoveryConversationAllowance) || (plan.includedRecoveryConversationAllowance ?? -1) < 0) return "INVALID_INCLUDED_ALLOWANCE";
    if (!plan.shopifyUsageEventHandle || !provider.usageEventHandles.includes(plan.shopifyUsageEventHandle)) return "MISSING_USAGE_METER";
  }
  if (plan.recoveryCreditPackEnabled && (!plan.shopifyRecoveryCreditPackEventHandle || !provider.usageEventHandles.includes(plan.shopifyRecoveryCreditPackEventHandle))) return "MISSING_USAGE_METER";
  return null;
}

function nextCycleReconcileAt(periodEnd: Date, now: Date): Date {
  const preCloseAt = new Date(periodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS);
  return now < preCloseAt ? preCloseAt : periodEnd;
}

function isStrictlyOlder(
  persistedAt: Date | null,
  persistedId: string | null,
  incoming: PartnerSubscriptionLifecycleEvent,
): boolean {
  const occurredAt = incoming.occurredAt?.getTime?.();
  return persistedAt instanceof Date
    && occurredAt !== undefined
    && (persistedAt.getTime() > occurredAt
      || (persistedAt.getTime() === occurredAt && persistedId !== null && persistedId > incoming.id));
}

function isSameEvent(persistedAt: Date | null, persistedId: string | null, incoming: PartnerSubscriptionLifecycleEvent): boolean {
  const occurredAt = incoming.occurredAt?.getTime?.();
  return persistedAt instanceof Date && occurredAt !== undefined && persistedAt.getTime() === occurredAt && persistedId === incoming.id;
}

function lifecycleErrorCleared(code: string | null): boolean {
  return code === "UNFROZEN_LIVE_CONTRACT_PENDING" || code === "PROVIDER_STATE_UNRESOLVED" || code === "PARTNER_API_ERROR";
}

async function closePaidPeriod(transaction: Prisma.TransactionClient, billingPeriodId: string): Promise<void> {
  const counter = await transaction.billingPeriodEntitlementCounter.findUnique({ where: { billingPeriodId_counter: { billingPeriodId, counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS } } });
  if (!counter) throw new Error("Paid billing period included-credit counter is missing");
  const reservations = await transaction.usageReservation.aggregate({ where: { billingPeriodEntitlementCounterId: counter.id, status: { in: [UsageReservationStatus.RESERVED, UsageReservationStatus.AMBIGUOUS] } }, _sum: { quantity: true } });
  const reserved = Number(reservations._sum.quantity ?? 0);
  const forfeitable = counter.grantedQuantity - counter.committedQuantity - counter.forfeitedQuantity;
  if (forfeitable < 0 || reserved !== counter.reservedQuantity) throw new Error("Paid billing period included-credit counter is inconsistent");
  await transaction.usageReservation.updateMany({ where: { billingPeriodEntitlementCounterId: counter.id, status: { in: [UsageReservationStatus.RESERVED, UsageReservationStatus.AMBIGUOUS] } }, data: { status: UsageReservationStatus.RELEASED, releaseReason: UsageReservationReleaseReason.PERIOD_CLOSED } });
  const updated = await transaction.billingPeriodEntitlementCounter.updateMany({ where: { id: counter.id, version: counter.version, reservedQuantity: counter.reservedQuantity }, data: { reservedQuantity: { decrement: reserved }, forfeitedQuantity: { increment: forfeitable }, version: { increment: 1 } } });
  if (updated.count !== 1) throw new Error("Paid billing period included-credit counter changed during close");
  const closed = await transaction.billingPeriodEntitlementCounter.findUnique({ where: { id: counter.id } });
  if (!closed || closed.reservedQuantity !== 0 || closed.committedQuantity + closed.forfeitedQuantity !== closed.grantedQuantity) throw new Error("Paid billing period included-credit counter did not close cleanly");
}

async function lockSubscription(transaction: Prisma.TransactionClient, subscriptionId: string): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`
    SELECT "id" FROM "billing"."Subscription" WHERE "id" = ${subscriptionId} FOR UPDATE
  `);
}