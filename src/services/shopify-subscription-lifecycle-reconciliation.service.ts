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

import type {
  PartnerSubscription,
  PartnerSubscriptionLifecycleEvent,
  PartnerSubscriptionReconciliationSnapshot,
} from "../providers/shopify-partner-billing.provider.js";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { recoveryCapacityResumeService } from "./recovery-capacity-resume.service.js";
import { SamePlanBillingPeriodRolloverService } from "./same-plan-billing-period-rollover.service.js";
import { ShopifyPlanChangeTransitionService } from "./shopify-plan-change-transition.service.js";

const FROZEN_RECONCILE_INTERVAL_MS = 60 * 60 * 1000;
const PROVIDER_RETRY_INTERVAL_MS = 5 * 60 * 1000;

type LifecycleDatabase = Pick<PrismaClient, "$transaction">;
type ResumeService = Pick<typeof recoveryCapacityResumeService, "schedule">;

export type LifecycleReconciliationResult = "handled" | "continue" | "restored";

export class ShopifySubscriptionLifecycleReconciliationService {
  constructor(
    private readonly database: LifecycleDatabase,
    private readonly resumeService: ResumeService = recoveryCapacityResumeService,
    private readonly logger: StructuredLogger = createLogger({ serviceName: "moda-billing-worker", environment: process.env.NODE_ENV ?? "development" }),
  ) {}

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
        select: { lastProviderLifecycleEventAt: true, lastProviderLifecycleEventId: true, lastSyncErrorCode: true },
      });
      if (isStrictlyOlder(current?.lastProviderLifecycleEventAt ?? null, current?.lastProviderLifecycleEventId ?? null, lifecycle)) return;
      const replay = isSameEvent(current?.lastProviderLifecycleEventAt ?? null, current?.lastProviderLifecycleEventId ?? null, lifecycle);
      const clearError = current?.lastSyncErrorCode === "UNFROZEN_LIVE_CONTRACT_PENDING"
        || current?.lastSyncErrorCode === "PROVIDER_STATE_UNRESOLVED"
        || current?.lastSyncErrorCode === "PARTNER_API_ERROR";
      await transaction.subscription.update({
        where: { id: subscriptionId },
        data: {
          status: SubscriptionProjectionStatus.FROZEN,
          ...(active ? { cancelAtPeriodEnd: active.cancelAtPeriodEnd } : {}),
          nextReconcileAt: new Date(now.getTime() + FROZEN_RECONCILE_INTERVAL_MS),
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
      await transaction.subscription.update({
        where: { id: subscriptionId },
        data: {
          nextReconcileAt: new Date(now.getTime() + PROVIDER_RETRY_INTERVAL_MS),
          lastSyncedAt: now,
          lastSyncErrorCode: lifecycle?.state === "UNFROZEN" ? "UNFROZEN_LIVE_CONTRACT_PENDING" : "PROVIDER_STATE_UNRESOLVED",
          lastSyncErrorAt: now,
          ...(lifecycle ? {
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
        nextReconcileAt: new Date(now.getTime() + FROZEN_RECONCILE_INTERVAL_MS),
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
        await transaction.subscription.update({ where: { id: subscriptionId }, data: { status: SubscriptionProjectionStatus.UNMAPPED, observedShopifyPlanHandle: provider.planHandle, lastSyncedAt: now, lastSyncErrorCode: "UNMAPPED_PLAN_HANDLE", lastSyncErrorAt: now, nextReconcileAt: new Date(now.getTime() + PROVIDER_RETRY_INTERVAL_MS), lastProviderLifecycleState: lifecycle.state, lastProviderLifecycleEventId: lifecycle.id, lastProviderLifecycleEventAt: lifecycle.occurredAt } });
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
      const samePlan = subscription.planId === plan.id;
      const sameCycle = samePlan
        && subscription.currentPeriodStart?.getTime() === provider.currentPeriodStart?.getTime()
        && subscription.currentPeriodEnd?.getTime() === provider.currentPeriodEnd?.getTime();
      if (sameCycle) {
        await transaction.subscription.update({ where: { id: subscriptionId }, data: {
          status: provider.status === "TRIALING" ? SubscriptionProjectionStatus.TRIALING : SubscriptionProjectionStatus.ACTIVE,
          observedShopifyPlanHandle: provider.planHandle,
          providerSubscriptionId: provider.providerSubscriptionId,
          trialEndsAt: provider.trialEndsAt,
          cancelAtPeriodEnd: provider.cancelAtPeriodEnd,
          lastSyncedAt: now,
          ...(lifecycleErrorCleared(subscription.lastSyncErrorCode) ? { lastSyncErrorCode: null, lastSyncErrorAt: null } : {}),
          lastProviderLifecycleState: lifecycle.state,
          lastProviderLifecycleEventId: lifecycle.id,
          lastProviderLifecycleEventAt: lifecycle.occurredAt,
          nextReconcileAt: provider.currentPeriodEnd ? new Date(Math.max(now.getTime(), provider.currentPeriodEnd.getTime() - 5 * 60 * 1000)) : new Date(now.getTime() + PROVIDER_RETRY_INTERVAL_MS),
        } });
        return true;
      }
      await transaction.subscription.update({ where: { id: subscriptionId }, data: { status: SubscriptionProjectionStatus.ACTIVE } });
      const transition = samePlan
        ? await new SamePlanBillingPeriodRolloverService({ $transaction: async (callback) => callback(transaction) } as never).transitionInTransaction(transaction, { shopId, subscriptionId, provider, plan: planInput, now })
        : await new ShopifyPlanChangeTransitionService({ $transaction: async (callback) => callback(transaction) } as never).transitionInTransaction(transaction, { shopId, subscriptionId, provider, plan: planInput, expectedCurrentPlanId: subscription.planId ?? "", now });
      if (transition.kind !== "transitioned" && transition.kind !== "unchanged") {
        await transaction.subscription.update({ where: { id: subscriptionId }, data: { status: SubscriptionProjectionStatus.SYNC_ERROR, lastSyncedAt: now, lastSyncErrorCode: "UNEXPECTED_IMMEDIATE_PLAN_CHANGE", lastSyncErrorAt: now, nextReconcileAt: new Date(now.getTime() + PROVIDER_RETRY_INTERVAL_MS), lastProviderLifecycleState: lifecycle.state, lastProviderLifecycleEventId: lifecycle.id, lastProviderLifecycleEventAt: lifecycle.occurredAt } });
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
    });
  }
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