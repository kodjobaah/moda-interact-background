import { BillingPlanKind, SubscriptionProjectionStatus } from "@prisma/client";
import { retireUnmappedCurrentPeriod } from "../billing-period-transition/retire-unmapped-current-period.js";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";

import type { PartnerSubscription } from "../../providers/shopify-partner-billing.provider.js";
import {
  recoveryCapacityResumeService,
  type RecoveryCapacityResumeService,
} from "../recovery-capacity-resume.service.js";
import {
  ShopifyPlanChangeTransitionService,
  type ShopifyPlanChangePlan,
  type ShopifyPlanChangeResult,
} from "../shopify-plan-change-transition.service.js";
import type { BillingReconciliationSchedulerService } from "./reconciliation-scheduler.service.js";
import { resolveShopifyUsageEventMapping } from "./shopify-usage-event-mapping.js";
import { planChangeTargetPrerequisiteFailure } from "./plan-change-target-prerequisites.js";

type EstablishedPlanObservationDatabase = Pick<PrismaClient, "$transaction" | "billingPlan" | "subscription">;
type ReconciliationScheduler = Pick<BillingReconciliationSchedulerService, "enqueue"> &
  Partial<Pick<BillingReconciliationSchedulerService, "publishCommittedFailure">>;
type CapacityResumeScheduler = Pick<RecoveryCapacityResumeService, "schedule">;
type PlanChangeTransition = Pick<ShopifyPlanChangeTransitionService, "transition">;

type ExistingSubscription = {
  id: string;
  status: SubscriptionProjectionStatus;
  planId: string | null;
  pendingPlanId: string | null;
  pendingShopifyPlanHandle: string | null;
  pendingEffectiveAt: Date | null;
  billingPeriodId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
};

type EstablishedPendingPlanSubscription = ExistingSubscription & {
  planId: string;
  pendingPlanId: string;
  pendingShopifyPlanHandle: string;
  pendingEffectiveAt: Date;
};

function hasEstablishedPendingPlan(
  existing: ExistingSubscription | null,
): existing is EstablishedPendingPlanSubscription {
  return existing !== null
    && existing.id.length > 0
    && existing.planId !== null
    && existing.pendingPlanId !== null
    && existing.pendingShopifyPlanHandle !== null
    && existing.pendingEffectiveAt !== null;
}

type EstablishedPlanObservationInput = {
  shopId: string;
  provider: PartnerSubscription;
  observedPlan: ShopifyPlanChangePlan | null;
  existing: ExistingSubscription | null;
  now: Date;
};

type EstablishedPlanObservationProjection = {
  billingPeriodId: string | null;
  packMeterHandle: string | null;
};

export type EstablishedPlanObservationResult =
  | { kind: "not-applicable" }
  | ({ kind: "handled" } & EstablishedPlanObservationProjection);

type PlanChangeFailureCode =
  | "MISSING_BILLING_CYCLE"
  | "MISSING_USAGE_METER"
  | "INVALID_INCLUDED_ALLOWANCE"
  | "UNEXPECTED_IMMEDIATE_PLAN_CHANGE";

export class EstablishedPlanObservationService {
  constructor(
    private readonly database: EstablishedPlanObservationDatabase,
    private readonly scheduler: ReconciliationScheduler,
    private readonly logger: StructuredLogger,
    private readonly capacityResume: CapacityResumeScheduler = recoveryCapacityResumeService,
    private readonly planChangeTransition: PlanChangeTransition = new ShopifyPlanChangeTransitionService(database),
  ) {}

  async reconcile(input: EstablishedPlanObservationInput): Promise<EstablishedPlanObservationResult> {
    const { shopId, provider, observedPlan, existing, now } = input;
    if (
      !hasEstablishedPendingPlan(existing)
      || existing.planId === observedPlan?.id
    ) {
      return { kind: "not-applicable" };
    }

    const currentPlan = await this.database.billingPlan.findUnique({
      where: { id: existing.planId },
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

    if (currentPlan && provider.planHandle === currentPlan.shopifyPlanHandle) {
      await this.persistUsageEventMapping(existing, provider);
      return {
        kind: "handled",
        billingPeriodId: existing.billingPeriodId,
        packMeterHandle: currentPlan.shopifyRecoveryCreditPackEventHandle ?? null,
      };
    }

    if (
      observedPlan?.active
      && provider.planHandle === existing.pendingShopifyPlanHandle
      && observedPlan.id === existing.pendingPlanId
    ) {
      return this.reconcileExpectedTarget({ shopId, provider, plan: observedPlan, existing, now });
    }

    if (!observedPlan?.active) {
      await this.recordUnmappedPlan(existing, provider, now, observedPlan !== null);
      await this.scheduler.publishCommittedFailure?.(shopId, existing.id);
      return { kind: "handled", billingPeriodId: null, packMeterHandle: null };
    }

    await this.recordPlanChangeFailure(
      shopId,
      existing,
      now,
      "UNEXPECTED_IMMEDIATE_PLAN_CHANGE",
      provider,
      provider.planHandle,
    );
    return { kind: "handled", billingPeriodId: existing.billingPeriodId, packMeterHandle: null };
  }

  private async persistUsageEventMapping(
    expected: ExistingSubscription,
    provider: PartnerSubscription,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`SELECT "id" FROM "billing"."Subscription" WHERE "id" = ${expected.id} FOR UPDATE`);
      const current = await transaction.subscription.findUnique({
        where: { id: expected.id },
        select: {
          id: true, status: true, planId: true, pendingPlanId: true, pendingShopifyPlanHandle: true,
          pendingEffectiveAt: true, billingPeriodId: true, currentPeriodStart: true, currentPeriodEnd: true,
        },
      });
      if (!matchesExpectedSubscription(current, expected)) return;
      const mapping = await resolveShopifyUsageEventMapping(transaction, provider.planHandle, provider.usageEventHandles);
      await transaction.subscription.update({
        where: { id: expected.id },
        data: { unmappedShopifyUsageEventHandles: mapping.unmappedProviderHandles },
      });
    });
  }

  private async recordUnmappedPlan(
    expected: ExistingSubscription,
    provider: PartnerSubscription,
    now: Date,
    inactivePlan: boolean,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`SELECT "id" FROM "billing"."Subscription" WHERE "id" = ${expected.id} FOR UPDATE`);
      const current = await transaction.subscription.findUnique({
        where: { id: expected.id },
        select: {
          id: true, status: true, planId: true, pendingPlanId: true, pendingShopifyPlanHandle: true,
          pendingEffectiveAt: true, billingPeriodId: true, currentPeriodStart: true, currentPeriodEnd: true,
        },
      });
      if (!current || !matchesExpectedSubscription(current, expected)) return;
      await retireUnmappedCurrentPeriod(transaction, {
        subscriptionId: current.id,
        billingPeriodId: current.billingPeriodId,
        now,
      });
      const mapping = await resolveShopifyUsageEventMapping(transaction, provider.planHandle, provider.usageEventHandles);
      await transaction.subscription.update({
        where: { id: expected.id },
        data: {
          billingPeriodId: null,
          currentPeriodStart: null,
          currentPeriodEnd: null,
          trialEndsAt: null,
          planId: null,
          status: SubscriptionProjectionStatus.UNMAPPED,
          observedShopifyPlanHandle: provider.planHandle,
          unmappedShopifyUsageEventHandles: mapping.unmappedProviderHandles,
          nextReconcileAt: null,
          lastSyncedAt: now,
          lastSyncErrorCode: inactivePlan ? "UNMAPPED_PLAN_HANDLE" : null,
          lastSyncErrorAt: inactivePlan ? now : null,
        },
      });
    });
  }

  private async reconcileExpectedTarget(input: {
    shopId: string;
    provider: PartnerSubscription;
    plan: ShopifyPlanChangePlan;
    existing: EstablishedPendingPlanSubscription;
    now: Date;
  }): Promise<EstablishedPlanObservationResult> {
    const { shopId, provider, plan, existing, now } = input;
    const sameCycle = existing.currentPeriodStart !== null
      && existing.currentPeriodEnd !== null
      && provider.currentPeriodStart?.getTime() === existing.currentPeriodStart.getTime()
      && provider.currentPeriodEnd?.getTime() === existing.currentPeriodEnd.getTime();

    if (sameCycle) {
      await this.recordPlanChangeFailure(shopId, existing, now, "UNEXPECTED_IMMEDIATE_PLAN_CHANGE", provider);
      return { kind: "handled", billingPeriodId: existing.billingPeriodId, packMeterHandle: null };
    }

    if (now < existing.pendingEffectiveAt) {
      await this.persistUsageEventMapping(existing, provider);
      return { kind: "handled", billingPeriodId: existing.billingPeriodId, packMeterHandle: null };
    }

    const prerequisiteFailure = planChangeTargetPrerequisiteFailure(provider, plan);
    if (prerequisiteFailure) {
      await this.recordPlanChangeFailure(shopId, existing, now, prerequisiteFailure, provider);
      return { kind: "handled", billingPeriodId: existing.billingPeriodId, packMeterHandle: null };
    }

    const transition = await this.planChangeTransition.transition({
      shopId,
      subscriptionId: existing.id,
      provider,
      plan,
      expectedCurrentPlanId: existing.planId,
      now,
    });

    if (transition.kind === "not-applicable") {
      await this.recordPlanChangeFailure(shopId, existing, now, "UNEXPECTED_IMMEDIATE_PLAN_CHANGE", provider);
      return { kind: "handled", billingPeriodId: existing.billingPeriodId, packMeterHandle: null };
    }

    await this.afterSuccessfulTransition(shopId, existing.id, transition, now);
    return {
      kind: "handled",
      billingPeriodId: transition.billingPeriodId,
      packMeterHandle: plan.shopifyRecoveryCreditPackEventHandle ?? null,
    };
  }

  private async afterSuccessfulTransition(
    shopId: string,
    subscriptionId: string,
    transition: Extract<ShopifyPlanChangeResult, { kind: "transitioned" }>,
    now: Date,
  ): Promise<void> {
    if (transition.nextReconcileAt) {
      await this.scheduler.enqueue(shopId, subscriptionId, transition.nextReconcileAt, now);
    }
    if (transition.planKind !== BillingPlanKind.PAID_METERED) return;

    try {
      await this.capacityResume.schedule({ shopId, trigger: "plan-change" });
    } catch (error) {
      this.logger.warn("billing.recovery_capacity_resume.enqueue_failed", {
        shopId,
        errorMessage: error instanceof Error ? error.message : "unknown failure",
        error: error,
      });
    }
  }

  private async recordPlanChangeFailure(
    shopId: string,
    existing: EstablishedPendingPlanSubscription,
    now: Date,
    errorCode: PlanChangeFailureCode,
    provider: PartnerSubscription,
    observedShopifyPlanHandle?: string,
  ): Promise<void> {
    const nextReconcileAt = new Date(now.getTime() + 60 * 1000);
    const updated = await this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`SELECT "id" FROM "billing"."Subscription" WHERE "id" = ${existing.id} FOR UPDATE`);
      const mapping = await resolveShopifyUsageEventMapping(transaction, provider.planHandle, provider.usageEventHandles);
      return transaction.subscription.updateMany({
        where: this.pendingIntentFence(existing),
        data: {
          unmappedShopifyUsageEventHandles: mapping.unmappedProviderHandles,
          status: SubscriptionProjectionStatus.SYNC_ERROR,
          ...(observedShopifyPlanHandle ? { observedShopifyPlanHandle } : {}),
          nextReconcileAt,
          lastSyncedAt: now,
          lastSyncErrorCode: errorCode,
          lastSyncErrorAt: now,
        },
      });
    });
    if (updated.count > 0) {
      await this.scheduler.enqueue(shopId, existing.id, nextReconcileAt, now);
      await this.scheduler.publishCommittedFailure?.(shopId, existing.id);
    }
  }

  private pendingIntentFence(existing: EstablishedPendingPlanSubscription) {
    return {
      id: existing.id,
      planId: existing.planId,
      pendingPlanId: existing.pendingPlanId,
      pendingShopifyPlanHandle: existing.pendingShopifyPlanHandle,
      pendingEffectiveAt: existing.pendingEffectiveAt,
    };
  }
}

function matchesExpectedSubscription(
  current: {
    id: string;
    status: SubscriptionProjectionStatus;
    planId: string | null;
    pendingPlanId: string | null;
    pendingShopifyPlanHandle: string | null;
    pendingEffectiveAt: Date | null;
    billingPeriodId: string | null;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
  } | null,
  expected: ExistingSubscription,
): boolean {
  return current !== null
    && current.id === expected.id
    && current.status === expected.status
    && current.planId === expected.planId
    && current.pendingPlanId === expected.pendingPlanId
    && current.pendingShopifyPlanHandle === expected.pendingShopifyPlanHandle
    && sameDate(current.pendingEffectiveAt, expected.pendingEffectiveAt)
    && current.billingPeriodId === expected.billingPeriodId
    && sameDate(current.currentPeriodStart, expected.currentPeriodStart)
    && sameDate(current.currentPeriodEnd, expected.currentPeriodEnd);
}

function sameDate(left: Date | null, right: Date | null): boolean {
  return left === null && right === null
    || left !== null && right !== null && left.getTime() === right.getTime();
}
