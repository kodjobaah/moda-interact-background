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

type TransitionDatabase = Pick<PrismaClient, "$transaction">;
type Transition = Prisma.TransactionClient;

export type ShopifyPlanChangePlan = {
  id: string;
  active: boolean;
  name: string;
  kind: BillingPlanKind;
  shopifyPlanHandle: string;
  shopifyUsageEventHandle: string | null;
  shopifyRecoveryCreditPackEventHandle: string | null;
  recoveryCreditPackEnabled: boolean;
  includedRecoveryConversationAllowance: number | null;
};

export type ShopifyPlanChangeInput = {
  shopId: string;
  subscriptionId: string;
  provider: PartnerSubscription;
  plan: ShopifyPlanChangePlan;
  expectedCurrentPlanId: string;
  now: Date;
};

export type ShopifyPlanChangeResult =
  | { kind: "not-applicable" }
  | { kind: "transitioned"; billingPeriodId: string; nextReconcileAt: Date | null; planKind: BillingPlanKind };

export class ShopifyPlanChangeTransitionService {
  constructor(private readonly database: TransitionDatabase) {}

  async transition(input: ShopifyPlanChangeInput): Promise<ShopifyPlanChangeResult> {
    return this.database.$transaction((transaction) => this.transitionInTransaction(transaction, input));
  }

  async transitionInTransaction(transaction: Transition, input: ShopifyPlanChangeInput): Promise<ShopifyPlanChangeResult> {
    const start = input.provider.currentPeriodStart;
    const end = input.provider.currentPeriodEnd;
    const allowance = input.plan.includedRecoveryConversationAllowance;
    if (!input.plan.active || input.provider.planHandle !== input.plan.shopifyPlanHandle || !start || !end || start >= end) {
      return { kind: "not-applicable" };
    }
    if (input.plan.kind === BillingPlanKind.PAID_METERED) {
      if (!Number.isSafeInteger(allowance) || (allowance ?? -1) < 0 || !input.plan.shopifyUsageEventHandle || !input.provider.usageEventHandles.includes(input.plan.shopifyUsageEventHandle)) {
        throw new Error("Provider-confirmed paid plan is missing a valid recovery meter or allowance");
      }
      if (input.plan.recoveryCreditPackEnabled && (!input.plan.shopifyRecoveryCreditPackEventHandle || !input.provider.usageEventHandles.includes(input.plan.shopifyRecoveryCreditPackEventHandle))) {
        throw new Error("Provider-confirmed Paid plan is missing its recovery pack meter");
      }
    }
    if (input.plan.kind === BillingPlanKind.FREE && input.plan.recoveryCreditPackEnabled && (!input.plan.shopifyRecoveryCreditPackEventHandle || !input.provider.usageEventHandles.includes(input.plan.shopifyRecoveryCreditPackEventHandle))) {
      throw new Error("Provider-confirmed Free plan is missing its recovery pack meter");
    }

    await lockSubscription(transaction, input.subscriptionId);
    const subscription = await transaction.subscription.findUnique({
      where: { id: input.subscriptionId },
      include: { billingPeriod: true, plan: true },
    });
    if (!subscription || subscription.shopId !== input.shopId || subscription.planId !== input.expectedCurrentPlanId || (subscription.status !== "ACTIVE" && subscription.status !== "TRIALING") || !subscription.billingPeriod || !subscription.currentPeriodEnd) {
      return { kind: "not-applicable" };
    }
    if (start < subscription.currentPeriodEnd) throw new Error("Provider plan change cycle overlaps the current billing period");

    const successor = await transaction.billingPeriod.findUnique({
      where: { shopId_periodStart_periodEnd: { shopId: input.shopId, periodStart: start, periodEnd: end } },
    });
    if (successor?.status === BillingPeriodStatus.CLOSED) throw new Error("Provider plan change has a closed successor period");
    const expectedGrant = input.plan.kind === BillingPlanKind.PAID_METERED ? allowance as number : null;
    if (successor && (successor.subscriptionId !== subscription.id || successor.planId !== input.plan.id || successor.shopifyPlanHandleSnapshot !== input.provider.planHandle || successor.planNameSnapshot !== input.plan.name || successor.planKindSnapshot !== input.plan.kind || successor.includedRecoveryCreditsGranted !== expectedGrant || successor.status !== BillingPeriodStatus.OPEN)) {
      throw new Error("Provider plan change has an incompatible successor period");
    }

    await closePeriod(transaction, subscription.billingPeriod.id, subscription.billingPeriod.periodEnd, subscription.billingPeriod.planKindSnapshot ?? subscription.plan?.kind ?? BillingPlanKind.FREE);
    const period = successor ?? await transaction.billingPeriod.create({
      data: {
        shopId: input.shopId,
        subscriptionId: subscription.id,
        planId: input.plan.id,
        shopifyPlanHandleSnapshot: input.provider.planHandle,
        planNameSnapshot: input.plan.name,
        planKindSnapshot: input.plan.kind,
        includedRecoveryCreditsGranted: expectedGrant,
        periodStart: start,
        periodEnd: end,
        status: BillingPeriodStatus.OPEN,
      },
    });
    if (input.plan.kind === BillingPlanKind.PAID_METERED) {
      const counter = await transaction.billingPeriodEntitlementCounter.findUnique({ where: { billingPeriodId_counter: { billingPeriodId: period.id, counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS } } });
      if (counter && counter.grantedQuantity !== expectedGrant) throw new Error("Provider plan change has an incompatible included-credit grant");
      await transaction.billingPeriodEntitlementCounter.upsert({
        where: { billingPeriodId_counter: { billingPeriodId: period.id, counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS } },
        update: {},
        create: { shopId: input.shopId, billingPeriodId: period.id, counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS, grantedQuantity: allowance as number, committedQuantity: 0, reservedQuantity: 0, forfeitedQuantity: 0 },
      });
    }
    const nextReconcileAt = input.plan.kind === BillingPlanKind.FREE && !input.plan.recoveryCreditPackEnabled
      ? null
      : new Date(Math.max(input.now.getTime(), end.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS));
    await transaction.subscription.update({
      where: { id: subscription.id },
      data: {
        planId: input.plan.id,
        observedShopifyPlanHandle: input.provider.planHandle,
        status: input.provider.status === "TRIALING" ? "TRIALING" : "ACTIVE",
        billingPeriodId: period.id,
        currentPeriodStart: start,
        currentPeriodEnd: end,
        trialEndsAt: input.provider.trialEndsAt,
        cancelAtPeriodEnd: input.provider.cancelAtPeriodEnd,
        providerSubscriptionId: input.provider.providerSubscriptionId,
        pendingPlanId: null,
        pendingShopifyPlanHandle: null,
        pendingEffectiveAt: null,
        nextReconcileAt,
        lastSyncedAt: input.now,
        lastSyncErrorCode: null,
        lastSyncErrorAt: null,
      },
    });
    return { kind: "transitioned", billingPeriodId: period.id, nextReconcileAt, planKind: input.plan.kind };
  }
}

async function closePeriod(transaction: Transition, billingPeriodId: string, closedAt: Date, planKind: BillingPlanKind): Promise<void> {
  await transaction.usageEvent.updateMany({ where: { billingPeriodId, shopifyReportState: { in: [ShopifyReportState.PENDING, ShopifyReportState.RETRYABLE] } }, data: { shopifyReportState: ShopifyReportState.NEEDS_ATTENTION, nextReportAt: null, providerErrorCode: "PERIOD_CLOSED_BEFORE_REPORT", providerResponseSummary: "Billing period closed before Shopify App Event report" } });
  if (planKind === BillingPlanKind.PAID_METERED) {
    const counter = await transaction.billingPeriodEntitlementCounter.findUnique({ where: { billingPeriodId_counter: { billingPeriodId, counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS } } });
    if (!counter) throw new Error("Paid billing period included-credit counter is missing");
    const reserved = await transaction.usageReservation.aggregate({ where: { billingPeriodEntitlementCounterId: counter.id, status: { in: [UsageReservationStatus.RESERVED, UsageReservationStatus.AMBIGUOUS] } }, _sum: { quantity: true } });
    const quantity = Number(reserved._sum.quantity ?? 0);
    const forfeitable = counter.grantedQuantity - counter.committedQuantity - counter.forfeitedQuantity;
    if (forfeitable < 0 || quantity !== counter.reservedQuantity) throw new Error("Paid billing period included-credit counter is inconsistent");
    await transaction.usageReservation.updateMany({ where: { billingPeriodEntitlementCounterId: counter.id, status: { in: [UsageReservationStatus.RESERVED, UsageReservationStatus.AMBIGUOUS] } }, data: { status: UsageReservationStatus.RELEASED, releaseReason: UsageReservationReleaseReason.PERIOD_CLOSED } });
    const updated = await transaction.billingPeriodEntitlementCounter.updateMany({ where: { id: counter.id, version: counter.version, reservedQuantity: counter.reservedQuantity }, data: { reservedQuantity: { decrement: quantity }, forfeitedQuantity: { increment: forfeitable }, version: { increment: 1 } } });
    if (updated.count !== 1) throw new Error("Paid billing period included-credit counter changed during close");
  }
  const closed = await transaction.billingPeriod.updateMany({ where: { id: billingPeriodId, status: BillingPeriodStatus.OPEN }, data: { status: BillingPeriodStatus.CLOSED, closedAt, closeReason: BillingPeriodCloseReason.PLAN_CHANGED } });
  if (closed.count !== 1) throw new Error("Billing period was not open while applying plan change");
}

async function lockSubscription(transaction: Transition, subscriptionId: string): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`SELECT "id" FROM "billing"."Subscription" WHERE "id" = ${subscriptionId} FOR UPDATE`);
}