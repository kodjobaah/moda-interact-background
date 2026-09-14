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

const FROZEN_RECONCILE_INTERVAL_MS = 60 * 60 * 1000;
const PROVIDER_RETRY_INTERVAL_MS = 5 * 60 * 1000;

type LifecycleDatabase = Pick<PrismaClient, "$transaction">;

export type LifecycleReconciliationResult = "handled" | "continue";

export class ShopifySubscriptionLifecycleReconciliationService {
  constructor(private readonly database: LifecycleDatabase) {}

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
      await this.freeze(shopId, subscriptionId, lifecycle, now);
      return "handled";
    }
    if (active === null) {
      await this.recordUnresolved(shopId, subscriptionId, now, lifecycle);
      return "handled";
    }

    const current = await this.database.$transaction(async (transaction) => {
      await lockSubscription(transaction, subscriptionId);
      return transaction.subscription.findUnique({
        where: { id: subscriptionId },
        select: { status: true, planId: true, currentPeriodStart: true, currentPeriodEnd: true, nextReconcileAt: true },
      });
    });
    if (current?.status !== SubscriptionProjectionStatus.FROZEN) return "continue";

    if (lifecycle.state === "UNFROZEN"
      && current.planId
      && current.currentPeriodStart?.getTime() === active.currentPeriodStart?.getTime()
      && current.currentPeriodEnd?.getTime() === active.currentPeriodEnd?.getTime()) {
      const next = active.currentPeriodEnd
        ? new Date(Math.max(now.getTime(), active.currentPeriodEnd.getTime() - 5 * 60 * 1000))
        : new Date(now.getTime() + PROVIDER_RETRY_INTERVAL_MS);
      await this.database.$transaction(async (transaction) => {
        await lockSubscription(transaction, subscriptionId);
        await transaction.subscription.update({
          where: { id: subscriptionId },
          data: {
            status: active.status === "TRIALING" ? SubscriptionProjectionStatus.TRIALING : SubscriptionProjectionStatus.ACTIVE,
            cancelAtPeriodEnd: active.cancelAtPeriodEnd,
            providerSubscriptionId: active.providerSubscriptionId,
            trialEndsAt: active.trialEndsAt,
            nextReconcileAt: next,
            lastSyncedAt: now,
            lastSyncErrorCode: null,
            lastSyncErrorAt: null,
            lastProviderLifecycleState: lifecycle.state,
            lastProviderLifecycleEventId: lifecycle.id,
            lastProviderLifecycleEventAt: lifecycle.occurredAt,
          },
        });
      });
      return "handled";
    }

    await this.freeze(shopId, subscriptionId, lifecycle, now);
    return "handled";
  }

  private async freeze(shopId: string, subscriptionId: string, lifecycle: PartnerSubscriptionLifecycleEvent, now: Date): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await lockSubscription(transaction, subscriptionId);
      const current = await transaction.subscription.findUnique({
        where: { id: subscriptionId },
        select: { lastProviderLifecycleEventAt: true, lastProviderLifecycleEventId: true },
      });
      if (isOlder(current?.lastProviderLifecycleEventAt ?? null, current?.lastProviderLifecycleEventId ?? null, lifecycle)) return;
      await transaction.subscription.update({
        where: { id: subscriptionId },
        data: {
          status: SubscriptionProjectionStatus.FROZEN,
          nextReconcileAt: new Date(now.getTime() + FROZEN_RECONCILE_INTERVAL_MS),
          lastSyncedAt: now,
          lastSyncErrorCode: null,
          lastSyncErrorAt: null,
          lastProviderLifecycleState: lifecycle.state,
          lastProviderLifecycleEventId: lifecycle.id,
          lastProviderLifecycleEventAt: lifecycle.occurredAt,
        },
      });
    });
  }

  private async recordUnresolved(shopId: string, subscriptionId: string, now: Date, lifecycle?: PartnerSubscriptionLifecycleEvent): Promise<void> {
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

  private async cancel(shopId: string, subscriptionId: string, lifecycle: PartnerSubscriptionLifecycleEvent, now: Date): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await lockSubscription(transaction, subscriptionId);
      const subscription = await transaction.subscription.findUnique({
        where: { id: subscriptionId },
        include: { billingPeriod: true },
      });
      if (!subscription || isOlder(subscription.lastProviderLifecycleEventAt, subscription.lastProviderLifecycleEventId, lifecycle)) return;
      const period = subscription.billingPeriod;
      if (period?.status === BillingPeriodStatus.OPEN) {
        await transaction.usageEvent.updateMany({
          where: { billingPeriodId: period.id, shopifyReportState: { in: [ShopifyReportState.PENDING, ShopifyReportState.RETRYABLE] } },
          data: { shopifyReportState: ShopifyReportState.NEEDS_ATTENTION, nextReportAt: null, providerErrorCode: "PERIOD_CLOSED_BEFORE_REPORT" },
        });
        if (period.planKindSnapshot === BillingPlanKind.PAID_METERED) {
          const counter = await transaction.billingPeriodEntitlementCounter.findUnique({
            where: { billingPeriodId_counter: { billingPeriodId: period.id, counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS } },
          });
          if (counter) {
            const reservations = await transaction.usageReservation.aggregate({ where: { billingPeriodEntitlementCounterId: counter.id, status: { in: [UsageReservationStatus.RESERVED, UsageReservationStatus.AMBIGUOUS] } }, _sum: { quantity: true } });
            const reserved = Number(reservations._sum.quantity ?? 0);
            await transaction.usageReservation.updateMany({ where: { billingPeriodEntitlementCounterId: counter.id, status: { in: [UsageReservationStatus.RESERVED, UsageReservationStatus.AMBIGUOUS] } }, data: { status: UsageReservationStatus.RELEASED, releaseReason: UsageReservationReleaseReason.PERIOD_CLOSED } });
            await transaction.billingPeriodEntitlementCounter.update({ where: { id: counter.id }, data: { reservedQuantity: { decrement: reserved }, forfeitedQuantity: { increment: counter.grantedQuantity - counter.committedQuantity - counter.forfeitedQuantity } } });
          }
        }
        await transaction.billingPeriod.update({ where: { id: period.id }, data: { status: BillingPeriodStatus.CLOSED, closedAt: now, closeReason: BillingPeriodCloseReason.CONTRACT_ENDED } });
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

function isOlder(
  persistedAt: Date | null,
  persistedId: string | null,
  incoming: PartnerSubscriptionLifecycleEvent,
): boolean {
  return persistedAt !== null
    && (persistedAt.getTime() > incoming.occurredAt.getTime()
      || (persistedAt.getTime() === incoming.occurredAt.getTime() && persistedId !== null && persistedId >= incoming.id));
}

async function lockSubscription(transaction: Prisma.TransactionClient, subscriptionId: string): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`
    SELECT "id" FROM "billing"."Subscription" WHERE "id" = ${subscriptionId} FOR UPDATE
  `);
}