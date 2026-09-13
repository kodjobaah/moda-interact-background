import {
  BillingPeriodCloseReason,
  BillingPeriodEntitlementCounterKind,
  BillingPeriodStatus,
  BillingPlanKind,
  Prisma,
  ShopifyReportState,
  UsageReservationReleaseReason,
  UsageReservationStatus,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import { APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS } from "@modainteract/moda-interact-shared/billing";
import type { PartnerSubscription } from "../providers/shopify-partner-billing.provider.js";

type RolloverDatabase = Pick<PrismaClient, "$transaction">;
type RolloverTransaction = Prisma.TransactionClient;

export type SamePlanRolloverPlan = {
  id: string;
  active: boolean;
  name: string;
  kind: BillingPlanKind;
  shopifyPlanHandle: string;
  includedRecoveryConversationAllowance: number | null;
  recoveryCreditPackEnabled: boolean;
  shopifyUsageEventHandle: string | null;
  shopifyRecoveryCreditPackEventHandle: string | null;
};

export type SamePlanRolloverResult =
  | { kind: "not-applicable" }
  | { kind: "provider-cycle-lag"; billingPeriodId: string; nextReconcileAt: Date | null }
  | { kind: "unchanged"; billingPeriodId: string | null; nextReconcileAt: Date | null }
  | { kind: "transitioned"; billingPeriodId: string; nextReconcileAt: Date; planKind: BillingPlanKind };

export type SamePlanRolloverInput = {
  shopId: string;
  subscriptionId?: string;
  provider: PartnerSubscription;
  plan: SamePlanRolloverPlan;
  now: Date;
};

type AfterTransitionCommitted = (input: SamePlanRolloverInput, result: Extract<SamePlanRolloverResult, { kind: "transitioned" }>) => Promise<void> | void;

export class SamePlanBillingPeriodRolloverService {
  constructor(
    private readonly database: RolloverDatabase,
    private readonly afterTransitionCommitted?: AfterTransitionCommitted,
  ) {}

  async transition(input: SamePlanRolloverInput): Promise<SamePlanRolloverResult> {
    const result = await this.database.$transaction(async (transaction) =>
      this.transitionInTransaction(transaction, input),
    );
    if (result.kind === "transitioned") await this.afterTransitionCommitted?.(input, result);
    return result;
  }

  async transitionInTransaction(
    transaction: RolloverTransaction,
    input: SamePlanRolloverInput,
  ): Promise<SamePlanRolloverResult> {
    const providerStart = input.provider.currentPeriodStart;
    const providerEnd = input.provider.currentPeriodEnd;
    if (!providerStart || !providerEnd || providerStart >= providerEnd) {
      return { kind: "not-applicable" };
    }
    if (!input.plan.active || input.provider.planHandle !== input.plan.shopifyPlanHandle) {
      return { kind: "not-applicable" };
    }
    if (input.plan.kind === BillingPlanKind.PAID_METERED) {
      if (!input.plan.shopifyUsageEventHandle || !input.provider.usageEventHandles.includes(input.plan.shopifyUsageEventHandle)) {
        return { kind: "not-applicable" };
      }
    }
    if (input.plan.kind === BillingPlanKind.FREE && input.plan.recoveryCreditPackEnabled) {
      if (!input.plan.shopifyRecoveryCreditPackEventHandle || !input.provider.usageEventHandles.includes(input.plan.shopifyRecoveryCreditPackEventHandle)) {
        return { kind: "not-applicable" };
      }
    }

    if (input.subscriptionId) await lockSubscription(transaction, input.subscriptionId);
    const subscription = await transaction.subscription.findUnique({
      where: input.subscriptionId ? { id: input.subscriptionId } : { shopId: input.shopId },
      include: { billingPeriod: true },
    });
    if (!subscription || subscription.shopId !== input.shopId || subscription.planId !== input.plan.id) {
      return { kind: "not-applicable" };
    }
    if (subscription.status !== "ACTIVE" && subscription.status !== "TRIALING") {
      return { kind: "not-applicable" };
    }

    const currentPeriod = subscription.billingPeriod;
    if (!currentPeriod || !subscription.currentPeriodStart || !subscription.currentPeriodEnd) {
      return { kind: "not-applicable" };
    }
    if (subscription.currentPeriodStart.getTime() === providerStart.getTime() && subscription.currentPeriodEnd.getTime() === providerEnd.getTime()) {
      if (input.now.getTime() >= currentPeriod.periodEnd.getTime()) {
        return {
          kind: "provider-cycle-lag",
          billingPeriodId: currentPeriod.id,
          nextReconcileAt: subscription.nextReconcileAt,
        };
      }
      return {
        kind: "unchanged",
        billingPeriodId: subscription.billingPeriodId,
        nextReconcileAt: subscription.nextReconcileAt,
      };
    }
    if (providerStart < currentPeriod.periodEnd || providerEnd <= providerStart) {
      throw new Error("Provider billing cycle overlaps the current local billing period");
    }

    const existingSuccessor = await transaction.billingPeriod.findUnique({
      where: {
        shopId_periodStart_periodEnd: {
          shopId: input.shopId,
          periodStart: providerStart,
          periodEnd: providerEnd,
        },
      },
    });
    if (existingSuccessor?.status === BillingPeriodStatus.CLOSED) {
      throw new Error("Provider billing cycle already has a closed successor period");
    }
    if (existingSuccessor && (
      existingSuccessor.subscriptionId !== subscription.id
      || existingSuccessor.shopId !== input.shopId
      || existingSuccessor.planId !== input.plan.id
      || existingSuccessor.shopifyPlanHandleSnapshot !== input.provider.planHandle
      || existingSuccessor.planNameSnapshot !== input.plan.name
      || existingSuccessor.planKindSnapshot !== input.plan.kind
      || existingSuccessor.includedRecoveryCreditsGranted !== (input.plan.kind === BillingPlanKind.PAID_METERED
        ? input.plan.includedRecoveryConversationAllowance ?? 0
        : null)
      || existingSuccessor.periodStart.getTime() !== providerStart.getTime()
      || existingSuccessor.periodEnd.getTime() !== providerEnd.getTime()
      || existingSuccessor.status !== BillingPeriodStatus.OPEN
    )) {
      throw new Error("Provider billing cycle has an incompatible successor period");
    }
    if (existingSuccessor && subscription.billingPeriodId === existingSuccessor.id) {
      return {
        kind: "unchanged",
        billingPeriodId: existingSuccessor.id,
        nextReconcileAt: subscription.nextReconcileAt,
      };
    }

    await finalizeOldPeriod(transaction, currentPeriod.id, input.plan.kind, currentPeriod.periodEnd);
    const successor = existingSuccessor ?? await transaction.billingPeriod.create({
      data: {
        shopId: input.shopId,
        subscriptionId: subscription.id,
        planId: input.plan.id,
        shopifyPlanHandleSnapshot: input.provider.planHandle,
        planNameSnapshot: input.plan.name,
        planKindSnapshot: input.plan.kind,
        includedRecoveryCreditsGranted: input.plan.kind === BillingPlanKind.PAID_METERED
          ? input.plan.includedRecoveryConversationAllowance ?? 0
          : null,
        periodStart: providerStart,
        periodEnd: providerEnd,
        status: BillingPeriodStatus.OPEN,
      },
    });

    if (input.plan.kind === BillingPlanKind.PAID_METERED) {
      const existingCounter = await transaction.billingPeriodEntitlementCounter.findUnique({
        where: {
          billingPeriodId_counter: {
            billingPeriodId: successor.id,
            counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
          },
        },
      });
      const expectedGrant = input.plan.includedRecoveryConversationAllowance ?? 0;
      if (existingCounter && existingCounter.grantedQuantity !== expectedGrant) {
        throw new Error("Successor included-credit counter has an incompatible grant");
      }
      await transaction.billingPeriodEntitlementCounter.upsert({
        where: {
          billingPeriodId_counter: {
            billingPeriodId: successor.id,
            counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
          },
        },
        update: {},
        create: {
          shopId: input.shopId,
          billingPeriodId: successor.id,
          counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
          grantedQuantity: expectedGrant,
          committedQuantity: 0,
          reservedQuantity: 0,
          forfeitedQuantity: 0,
        },
      });
    }

    const nextReconcileAt = new Date(
      Math.max(input.now.getTime(), providerEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS),
    );
    await transaction.subscription.update({
      where: { id: subscription.id },
      data: {
        observedShopifyPlanHandle: input.provider.planHandle,
        status: input.provider.status === "TRIALING" ? "TRIALING" : "ACTIVE",
        billingPeriodId: successor.id,
        currentPeriodStart: providerStart,
        currentPeriodEnd: providerEnd,
        trialEndsAt: input.provider.trialEndsAt,
        cancelAtPeriodEnd: input.provider.cancelAtPeriodEnd,
        providerSubscriptionId: input.provider.providerSubscriptionId,
        lastSyncedAt: input.now,
        lastSyncErrorCode: null,
        lastSyncErrorAt: null,
        nextReconcileAt,
      },
    });

    return { kind: "transitioned", billingPeriodId: successor.id, nextReconcileAt, planKind: input.plan.kind };
  }
}

async function finalizeOldPeriod(
  transaction: RolloverTransaction,
  billingPeriodId: string,
  planKind: BillingPlanKind,
  periodEnd: Date,
): Promise<void> {
  await transaction.usageEvent.updateMany({
    where: {
      billingPeriodId,
      shopifyReportState: { in: [ShopifyReportState.PENDING, ShopifyReportState.RETRYABLE] },
    },
    data: {
      shopifyReportState: ShopifyReportState.NEEDS_ATTENTION,
      nextReportAt: null,
      providerErrorCode: "PERIOD_CLOSED_BEFORE_REPORT",
      providerResponseSummary: "Billing period closed before Shopify App Event report",
    },
  });
  if (planKind === BillingPlanKind.PAID_METERED) {
    const counter = await transaction.billingPeriodEntitlementCounter.findUnique({
      where: {
        billingPeriodId_counter: {
          billingPeriodId,
          counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
        },
      },
    });
    if (!counter) throw new Error("Paid billing period included-credit counter is missing");
    const reserved = await transaction.usageReservation.aggregate({
      where: {
        billingPeriodEntitlementCounterId: counter.id,
        status: { in: [UsageReservationStatus.RESERVED, UsageReservationStatus.AMBIGUOUS] },
      },
      _sum: { quantity: true },
    });
    const reservedQuantity = Number(reserved._sum.quantity ?? 0);
    const forfeitableAfterRelease = counter.grantedQuantity - counter.committedQuantity - counter.forfeitedQuantity;
    if (forfeitableAfterRelease < 0 || reservedQuantity !== counter.reservedQuantity) {
      throw new Error("Paid billing period included-credit counter is inconsistent");
    }
    await transaction.usageReservation.updateMany({
      where: {
        billingPeriodEntitlementCounterId: counter.id,
        status: { in: [UsageReservationStatus.RESERVED, UsageReservationStatus.AMBIGUOUS] },
      },
      data: { status: UsageReservationStatus.RELEASED, releaseReason: UsageReservationReleaseReason.PERIOD_CLOSED },
    });
    const updated = await transaction.billingPeriodEntitlementCounter.updateMany({
      where: { id: counter.id, version: counter.version, reservedQuantity: counter.reservedQuantity },
      data: {
        reservedQuantity: { decrement: reservedQuantity },
        forfeitedQuantity: { increment: forfeitableAfterRelease },
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new Error("Paid billing period included-credit counter changed during close");
    const closedCounter = await transaction.billingPeriodEntitlementCounter.findUnique({ where: { id: counter.id } });
    if (!closedCounter || closedCounter.reservedQuantity !== 0 || closedCounter.committedQuantity + closedCounter.forfeitedQuantity !== closedCounter.grantedQuantity) {
      throw new Error("Paid billing period included-credit counter did not close cleanly");
    }
  }

  const closed = await transaction.billingPeriod.updateMany({
    where: { id: billingPeriodId, status: BillingPeriodStatus.OPEN },
    data: {
      status: BillingPeriodStatus.CLOSED,
      closedAt: periodEnd,
      closeReason: BillingPeriodCloseReason.RENEWED_SAME_PLAN,
    },
  });
  if (closed.count !== 1) throw new Error("Billing period was not open while closing");
}

async function lockSubscription(transaction: RolloverTransaction, subscriptionId: string): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "billing"."Subscription"
    WHERE "id" = ${subscriptionId}
    FOR UPDATE
  `);
}

export { APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS };