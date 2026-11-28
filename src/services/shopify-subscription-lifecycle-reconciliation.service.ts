import {
  BillingPeriodCloseReason,
  BillingPeriodEntitlementCounterKind,
  BillingPeriodStatus,
  BillingPlanKind,
  Prisma,
  SubscriptionProjectionStatus,
  UsageReservationStatus,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS } from "@modainteract/moda-interact-shared/billing";

import type {
  PartnerSubscription,
  PartnerSubscriptionLifecycleEvent,
  PartnerSubscriptionReconciliationSnapshot,
} from "../providers/shopify-partner-billing.provider.js";
import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import { recoveryCapacityResumeService } from "./recovery-capacity-resume.service.js";
import type { BackgroundRuntimeConfigSnapshot } from "../runtime/background-runtime-config.js";
import { SamePlanBillingPeriodRolloverService } from "./same-plan-billing-period-rollover.service.js";
import { ShopifyPlanChangeTransitionService } from "./shopify-plan-change-transition.service.js";
import { closeBillingPeriod } from "./billing-period-transition/close-billing-period.js";
import { resolveShopifyUsageEventMapping } from "./billing-reconciliation/shopify-usage-event-mapping.js";
import { BillingPlanMaterializationService } from "./billing-plan-materialization.service.js";
import {
  canRevalidateRepairedUnfreezePeriod,
  isBlockedUnfreezeAccountingState,
  isUnresolvedUnfreezeAccountingError,
  unfreezeAccountingErrorCode,
} from "./billing-reconciliation/unfreeze-integrity-guard.js";

type LifecycleDatabase = Pick<
  PrismaClient,
  "$transaction" | "billingPlan" | "merchantPricingPlan"
>;
type ResumeService = Pick<typeof recoveryCapacityResumeService, "schedule">;

export type LifecycleReconciliationResult = "handled" | "continue" | "restored";

export class ShopifySubscriptionLifecycleReconciliationService {
  constructor(
    private readonly database: LifecycleDatabase,
    private readonly resumeService: ResumeService = recoveryCapacityResumeService,
    private readonly logger: StructuredLogger = createLogger({
      serviceName: "moda-billing-worker",
      environment: resolveDeploymentEnvironmentName(),
    }),
    private readonly runtimeConfig?: Pick<
      BackgroundRuntimeConfigSnapshot,
      "billingFrozenRecheckSeconds" | "billingProviderRetrySeconds"
    >,
  ) {}

  private frozenReconcileIntervalMs(): number {
    return (this.runtimeConfig?.billingFrozenRecheckSeconds ?? 3600) * 1000;
  }
  private providerRetryIntervalMs(): number {
    return (this.runtimeConfig?.billingProviderRetrySeconds ?? 300) * 1000;
  }

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
      // A live contract alone is not evidence that Shopify lifted a freeze.
      // Hold the frozen state (and its existing schedule) under the row lock.
      const held = await this.database.$transaction(async (transaction) => {
        await lockSubscription(transaction, subscriptionId);
        const current = await transaction.subscription.findUnique({
          where: { id: subscriptionId },
          select: {
            status: true,
            lastSyncErrorCode: true,
            lastProviderLifecycleState: true,
          },
        });
        if (
          !current ||
          (current.status !== SubscriptionProjectionStatus.FROZEN &&
            !isBlockedUnfreezeAccountingState(current))
        )
          return false;
        const mapping = await resolveShopifyUsageEventMapping(
          transaction,
          active.planHandle,
          active.usageEventHandles,
        );
        await transaction.subscription.update({
          where: { id: subscriptionId },
          data: {
            unmappedShopifyUsageEventHandles: mapping.unmappedProviderHandles,
            nextReconcileAt: new Date(
              now.getTime() +
                (isBlockedUnfreezeAccountingState(current)
                  ? this.providerRetryIntervalMs()
                  : this.frozenReconcileIntervalMs()),
            ),
            lastSyncedAt: now,
          },
        });
        return true;
      });
      return held ? "handled" : "continue";
    }

    const ordering = await this.database.$transaction(async (transaction) => {
      await lockSubscription(transaction, subscriptionId);
      const current = await transaction.subscription.findUnique({
        where: { id: subscriptionId },
        select: {
          status: true,
          lastProviderLifecycleEventAt: true,
          lastProviderLifecycleEventId: true,
          lastSyncErrorCode: true,
          lastProviderLifecycleState: true,
        },
      });
      // Failed-unfreeze provenance is carried by the dedicated error code,
      // not the mutable lifecycle state. UPDATED/CREATED/scheduled cancellation
      // and repeated UNFROZEN evidence cannot clear it. A new FROZEN event
      // may still be recorded; a live plan cannot repair local accounting.
      if (
        current &&
        isBlockedUnfreezeAccountingState(current) &&
        lifecycle.state !== "FROZEN" &&
        !(lifecycle.state === "CANCELED" && !active) &&
        // A fresh UNFROZEN event or a verified same-cycle repair check may
        // resume restoration. Other provider events retain the block.
        !(
          active &&
          (lifecycle.state === "UNFROZEN" ||
            canRevalidateRepairedUnfreezePeriod(current, lifecycle.state)) &&
          !isStrictlyOlder(
            current.lastProviderLifecycleEventAt,
            current.lastProviderLifecycleEventId,
            lifecycle,
          )
        )
      ) {
        const mapping = active
          ? await resolveShopifyUsageEventMapping(
              transaction,
              active.planHandle,
              active.usageEventHandles,
            )
          : null;
        await transaction.subscription.update({
          where: { id: subscriptionId },
          data: {
            ...(mapping
              ? {
                  unmappedShopifyUsageEventHandles:
                    mapping.unmappedProviderHandles,
                }
              : {}),
            nextReconcileAt: new Date(
              now.getTime() + this.providerRetryIntervalMs(),
            ),
            lastSyncedAt: now,
            ...(isStrictlyOlder(
              current.lastProviderLifecycleEventAt,
              current.lastProviderLifecycleEventId,
              lifecycle,
            )
              ? {}
              : {
                  lastProviderLifecycleState: lifecycle.state,
                  lastProviderLifecycleEventId: lifecycle.id,
                  lastProviderLifecycleEventAt: lifecycle.occurredAt,
                }),
          },
        });
        return { kind: "handled" as const };
      }
      if (
        !isStrictlyOlder(
          current?.lastProviderLifecycleEventAt ?? null,
          current?.lastProviderLifecycleEventId ?? null,
          lifecycle,
        )
      ) {
        return { kind: "continue" as const };
      }
      if (current?.status === SubscriptionProjectionStatus.FROZEN) {
        const mapping = active
          ? await resolveShopifyUsageEventMapping(
              transaction,
              active.planHandle,
              active.usageEventHandles,
            )
          : null;
        await transaction.subscription.update({
          where: { id: subscriptionId },
          data: {
            ...(mapping
              ? {
                  unmappedShopifyUsageEventHandles:
                    mapping.unmappedProviderHandles,
                }
              : {}),
            nextReconcileAt: new Date(
              now.getTime() + this.frozenReconcileIntervalMs(),
            ),
            lastSyncedAt: now,
          },
        });
        return { kind: "handled" as const };
      }
      if (!active) {
        await transaction.subscription.update({
          where: { id: subscriptionId },
          data: {
            nextReconcileAt: new Date(
              now.getTime() + this.providerRetryIntervalMs(),
            ),
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
        select: {
          status: true,
          planId: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          lastSyncErrorCode: true,
        },
      });
    });
    if (
      !active &&
      current?.status === SubscriptionProjectionStatus.FROZEN &&
      lifecycle.state === "UNFROZEN"
    ) {
      await this.recordUnfrozenWithoutContract(subscriptionId, lifecycle, now);
      return "handled";
    }
    if (!active) {
      await this.recordUnresolved(shopId, subscriptionId, now, lifecycle);
      return "handled";
    }
    if (
      current?.status === SubscriptionProjectionStatus.FROZEN &&
      lifecycle.state !== "UNFROZEN"
    ) {
      await this.holdFrozenNonterminal(subscriptionId, lifecycle, active, now);
      return "handled";
    }
    const repairCheck =
      current !== null &&
      canRevalidateRepairedUnfreezePeriod(current, lifecycle.state);
    if (
      (current?.status !== SubscriptionProjectionStatus.FROZEN &&
        !(current && isBlockedUnfreezeAccountingState(current))) ||
      (lifecycle.state !== "UNFROZEN" && !repairCheck)
    )
      return "continue";
    // The existing operational plan is checked under the subscription lock.
    // Only a missing plan triggers a separate, concurrency-safe catalogue
    // materialisation; the subsequent restoration locks and checks again.
    let restored = await this.restore(
      shopId,
      subscriptionId,
      active,
      lifecycle,
      now,
      true,
    );
    if (restored === "materialize") {
      await new BillingPlanMaterializationService(
        this.database,
        this.logger,
      ).materializeIfMissing(active.planHandle);
      restored = await this.restore(
        shopId,
        subscriptionId,
        active,
        lifecycle,
        now,
        false,
      );
    }
    if (restored !== "restored") return "handled";
    try {
      await this.resumeService.schedule({ shopId, trigger: "unfreeze" });
    } catch (error) {
      this.logger.warn("billing.recovery_capacity_resume.enqueue_failed", {
        shopId,
        errorMessage:
          error instanceof Error ? error.message : "unknown failure",
        error: error,
      });
    }
    return "restored";
  }

  private async holdFrozenNonterminal(
    subscriptionId: string,
    lifecycle: PartnerSubscriptionLifecycleEvent,
    active: PartnerSubscription,
    now: Date,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await lockSubscription(transaction, subscriptionId);
      const current = await transaction.subscription.findUnique({
        where: { id: subscriptionId },
        select: {
          status: true,
          lastProviderLifecycleEventAt: true,
          lastProviderLifecycleEventId: true,
        },
      });
      if (!current || current.status !== SubscriptionProjectionStatus.FROZEN)
        return;
      const older = isStrictlyOlder(
        current.lastProviderLifecycleEventAt,
        current.lastProviderLifecycleEventId,
        lifecycle,
      );
      const mapping = await resolveShopifyUsageEventMapping(
        transaction,
        active.planHandle,
        active.usageEventHandles,
      );
      await transaction.subscription.update({
        where: { id: subscriptionId },
        data: {
          unmappedShopifyUsageEventHandles: mapping.unmappedProviderHandles,
          lastSyncedAt: now,
          nextReconcileAt: new Date(
            now.getTime() + this.frozenReconcileIntervalMs(),
          ),
          ...(older
            ? {}
            : {
                lastProviderLifecycleState: lifecycle.state,
                lastProviderLifecycleEventId: lifecycle.id,
                lastProviderLifecycleEventAt: lifecycle.occurredAt,
              }),
        },
      });
    });
  }

  private async freeze(
    subscriptionId: string,
    lifecycle: PartnerSubscriptionLifecycleEvent,
    active: PartnerSubscription | null,
    now: Date,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await lockSubscription(transaction, subscriptionId);
      const current = await transaction.subscription.findUnique({
        where: { id: subscriptionId },
        select: {
          status: true,
          lastProviderLifecycleEventAt: true,
          lastProviderLifecycleEventId: true,
          lastSyncErrorCode: true,
        },
      });
      if (
        isStrictlyOlder(
          current?.lastProviderLifecycleEventAt ?? null,
          current?.lastProviderLifecycleEventId ?? null,
          lifecycle,
        )
      ) {
        if (current?.status === SubscriptionProjectionStatus.FROZEN) {
          await transaction.subscription.update({
            where: { id: subscriptionId },
            data: {
              nextReconcileAt: new Date(
                now.getTime() + this.frozenReconcileIntervalMs(),
              ),
              lastSyncedAt: now,
            },
          });
        }
        return;
      }
      const replay = isSameEvent(
        current?.lastProviderLifecycleEventAt ?? null,
        current?.lastProviderLifecycleEventId ?? null,
        lifecycle,
      );
      const mapping = active
        ? await resolveShopifyUsageEventMapping(
            transaction,
            active.planHandle,
            active.usageEventHandles,
          )
        : null;
      const clearError =
        current?.lastSyncErrorCode === "UNFROZEN_LIVE_CONTRACT_PENDING" ||
        current?.lastSyncErrorCode === "PROVIDER_STATE_UNRESOLVED" ||
        current?.lastSyncErrorCode === "PARTNER_API_ERROR";
      await transaction.subscription.update({
        where: { id: subscriptionId },
        data: {
          status: SubscriptionProjectionStatus.FROZEN,
          ...(mapping
            ? {
                unmappedShopifyUsageEventHandles:
                  mapping.unmappedProviderHandles,
              }
            : {}),
          ...(active ? { cancelAtPeriodEnd: active.cancelAtPeriodEnd } : {}),
          nextReconcileAt: new Date(
            now.getTime() + this.frozenReconcileIntervalMs(),
          ),
          lastSyncedAt: now,
          ...(clearError
            ? { lastSyncErrorCode: null, lastSyncErrorAt: null }
            : {}),
          ...(replay
            ? {}
            : {
                lastProviderLifecycleState: lifecycle.state,
                lastProviderLifecycleEventId: lifecycle.id,
                lastProviderLifecycleEventAt: lifecycle.occurredAt,
              }),
        },
      });
    });
  }

  private async recordUnresolved(
    _shopId: string,
    subscriptionId: string,
    now: Date,
    lifecycle?: PartnerSubscriptionLifecycleEvent,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await lockSubscription(transaction, subscriptionId);
      const current = await transaction.subscription.findUnique({
        where: { id: subscriptionId },
        select: {
          status: true,
          lastProviderLifecycleEventAt: true,
          lastProviderLifecycleEventId: true,
          lastSyncErrorCode: true,
          lastProviderLifecycleState: true,
        },
      });
      const blocked =
        current !== null && isBlockedUnfreezeAccountingState(current);
      if (blocked) {
        await transaction.subscription.update({
          where: { id: subscriptionId },
          data: {
            nextReconcileAt: new Date(
              now.getTime() + this.providerRetryIntervalMs(),
            ),
            lastSyncedAt: now,
          },
        });
        return;
      }
      const frozen = current?.status === SubscriptionProjectionStatus.FROZEN;
      const older =
        lifecycle &&
        isStrictlyOlder(
          current?.lastProviderLifecycleEventAt ?? null,
          current?.lastProviderLifecycleEventId ?? null,
          lifecycle,
        );
      await transaction.subscription.update({
        where: { id: subscriptionId },
        data: {
          nextReconcileAt: new Date(
            now.getTime() +
              (frozen
                ? this.frozenReconcileIntervalMs()
                : this.providerRetryIntervalMs()),
          ),
          lastSyncedAt: now,
          lastSyncErrorCode:
            lifecycle?.state === "UNFROZEN" && !older
              ? "UNFROZEN_LIVE_CONTRACT_PENDING"
              : "PROVIDER_STATE_UNRESOLVED",
          lastSyncErrorAt: now,
          ...(lifecycle && !older
            ? {
                lastProviderLifecycleState: lifecycle.state,
                lastProviderLifecycleEventId: lifecycle.id,
                lastProviderLifecycleEventAt: lifecycle.occurredAt,
              }
            : {}),
        },
      });
    });
  }

  private async recordUnfrozenWithoutContract(
    subscriptionId: string,
    lifecycle: PartnerSubscriptionLifecycleEvent,
    now: Date,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await lockSubscription(transaction, subscriptionId);
      const current = await transaction.subscription.findUnique({
        where: { id: subscriptionId },
        select: {
          lastProviderLifecycleEventAt: true,
          lastProviderLifecycleEventId: true,
        },
      });
      if (
        isStrictlyOlder(
          current?.lastProviderLifecycleEventAt ?? null,
          current?.lastProviderLifecycleEventId ?? null,
          lifecycle,
        )
      )
        return;
      await transaction.subscription.update({
        where: { id: subscriptionId },
        data: {
          status: SubscriptionProjectionStatus.FROZEN,
          nextReconcileAt: new Date(
            now.getTime() + this.frozenReconcileIntervalMs(),
          ),
          lastSyncedAt: now,
          lastSyncErrorCode: "UNFROZEN_LIVE_CONTRACT_PENDING",
          lastSyncErrorAt: now,
          lastProviderLifecycleState: lifecycle.state,
          lastProviderLifecycleEventId: lifecycle.id,
          lastProviderLifecycleEventAt: lifecycle.occurredAt,
        },
      });
    });
  }

  private async restore(
    shopId: string,
    subscriptionId: string,
    provider: PartnerSubscription,
    lifecycle: PartnerSubscriptionLifecycleEvent,
    now: Date,
    mayMaterialize: boolean,
  ): Promise<"restored" | "handled" | "materialize"> {
    return this.database.$transaction(
      async (transaction): Promise<"restored" | "handled" | "materialize"> => {
        await lockSubscription(transaction, subscriptionId);
        const subscription = await transaction.subscription.findUnique({
          where: { id: subscriptionId },
          include: { billingPeriod: true, plan: true },
        });
        if (
          !subscription ||
          (subscription.status !== SubscriptionProjectionStatus.FROZEN &&
            !isBlockedUnfreezeAccountingState(subscription)) ||
          isStrictlyOlder(
            subscription.lastProviderLifecycleEventAt,
            subscription.lastProviderLifecycleEventId,
            lifecycle,
          )
        )
          return "handled";
        const plan = await transaction.billingPlan.findUnique({
          where: { shopifyPlanHandle: provider.planHandle },
        });
        if (!plan && mayMaterialize) return "materialize";
        if (!plan || !plan.active) {
          // A later Shopify catalogue/configuration mismatch must not erase a
          // previously persisted accounting failure or close its open period.
          // Admin receives the original incident and can inspect the observed
          // provider handle without losing the local credit evidence.
          if (isBlockedUnfreezeAccountingState(subscription)) {
            await this.preserveUnfreezeAccountingFailure(
              transaction,
              subscriptionId,
              subscription.lastSyncErrorCode!,
              provider,
              lifecycle,
              now,
            );
          } else {
            await this.updateUnfreezeFailure(
              transaction,
              subscriptionId,
              subscription,
              provider,
              lifecycle,
              now,
              plan ? "UNMAPPED_PLAN_HANDLE" : null,
              SubscriptionProjectionStatus.UNMAPPED,
            );
          }
          return "handled";
        }
        const planInput = {
          id: plan.id,
          active: plan.active,
          name: plan.name,
          kind: plan.kind,
          shopifyPlanHandle: plan.shopifyPlanHandle,
          includedRecoveryConversationAllowance:
            plan.includedRecoveryConversationAllowance,
          recoveryCreditPackEnabled: plan.recoveryCreditPackEnabled,
          shopifyUsageEventHandle: plan.shopifyUsageEventHandle,
          shopifyRecoveryCreditPackEventHandle:
            plan.shopifyRecoveryCreditPackEventHandle,
        };
        const configurationError = validateProviderPlan(planInput, provider);
        if (configurationError) {
          if (isBlockedUnfreezeAccountingState(subscription)) {
            await this.preserveUnfreezeAccountingFailure(
              transaction,
              subscriptionId,
              subscription.lastSyncErrorCode!,
              provider,
              lifecycle,
              now,
            );
          } else {
            await this.updateUnfreezeFailure(
              transaction,
              subscriptionId,
              subscription,
              provider,
              lifecycle,
              now,
              configurationError,
              configurationError === "UNMAPPED_PLAN_HANDLE"
                ? SubscriptionProjectionStatus.UNMAPPED
                : SubscriptionProjectionStatus.SYNC_ERROR,
            );
          }
          return "handled";
        }
        const samePlan = subscription.planId === plan.id;
        const sameCycle =
          samePlan &&
          subscription.currentPeriodStart?.getTime() ===
            provider.currentPeriodStart?.getTime() &&
          subscription.currentPeriodEnd?.getTime() ===
            provider.currentPeriodEnd?.getTime();
        // Provider truth alone cannot repair local accounting. A same-cycle
        // period conflict may recover only after a locked, read-only invariant
        // check. Other conflicts require separate verified repair evidence.
        let verifiedExistingPeriod = false;
        if (
          isUnresolvedUnfreezeAccountingError(subscription.lastSyncErrorCode)
        ) {
          const errorCode = unfreezeAccountingErrorCode(
            subscription.lastSyncErrorCode!,
          );
          // Only a same-cycle period conflict is automatically verifiable.
          // Failed usage flushes and lifetime Free-history conflicts require
          // external evidence; an active Shopify snapshot cannot clear them.
          verifiedExistingPeriod =
            errorCode === "UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT" &&
            sameCycle &&
            (await isSameCycleAccountingValid(transaction, {
              shopId,
              subscriptionId,
              provider,
              plan: planInput,
              subscription,
              verifyOutstandingReservations: true,
            }));
          if (!verifiedExistingPeriod) {
            await this.preserveUnfreezeAccountingFailure(
              transaction,
              subscriptionId,
              errorCode,
              provider,
              lifecycle,
              now,
            );
            return "handled";
          }
        }
        if (sameCycle) {
          // The blocked repair above already checked this invariant. Do not
          // issue a redundant counter read when it was just verified.
          const periodValid =
            verifiedExistingPeriod ||
            (await isSameCycleAccountingValid(transaction, {
              shopId,
              subscriptionId,
              provider,
              plan: planInput,
              subscription,
            }));
          if (!periodValid) {
            await transaction.subscription.update({
              where: { id: subscriptionId },
              data: {
                status: SubscriptionProjectionStatus.SYNC_ERROR,
                lastSyncErrorCode: "UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT",
                lastSyncErrorAt: now,
                lastSyncedAt: now,
                nextReconcileAt: new Date(
                  now.getTime() + this.providerRetryIntervalMs(),
                ),
                lastProviderLifecycleState: lifecycle.state,
                lastProviderLifecycleEventId: lifecycle.id,
                lastProviderLifecycleEventAt: lifecycle.occurredAt,
              },
            });
            return "handled";
          }
          const usageEventMapping = await resolveShopifyUsageEventMapping(
            transaction,
            provider.planHandle,
            provider.usageEventHandles,
          );
          const pendingPlan = provider.pendingPlanHandle
            ? await transaction.billingPlan.findUnique({
                where: { shopifyPlanHandle: provider.pendingPlanHandle },
                select: { id: true, active: true },
              })
            : null;
          await transaction.subscription.update({
            where: { id: subscriptionId },
            data: {
              unmappedShopifyUsageEventHandles:
                usageEventMapping.unmappedProviderHandles,
              status:
                provider.status === "TRIALING"
                  ? SubscriptionProjectionStatus.TRIALING
                  : SubscriptionProjectionStatus.ACTIVE,
              observedShopifyPlanHandle: provider.planHandle,
              providerSubscriptionId: provider.providerSubscriptionId,
              trialEndsAt: provider.trialEndsAt,
              cancelAtPeriodEnd: provider.cancelAtPeriodEnd,
              pendingShopifyPlanHandle: provider.pendingPlanHandle,
              pendingPlanId: pendingPlan?.active ? pendingPlan.id : null,
              pendingEffectiveAt: provider.pendingEffectiveAt,
              lastSyncedAt: now,
              lastSyncErrorCode: null,
              lastSyncErrorAt: null,
              lastProviderLifecycleState: lifecycle.state,
              lastProviderLifecycleEventId: lifecycle.id,
              lastProviderLifecycleEventAt: lifecycle.occurredAt,
              nextReconcileAt: provider.currentPeriodEnd
                ? nextCycleReconcileAt(provider.currentPeriodEnd, now)
                : new Date(now.getTime() + this.providerRetryIntervalMs()),
            },
          });
          return "restored";
        }
        await transaction.subscription.update({
          where: { id: subscriptionId },
          data: { status: SubscriptionProjectionStatus.ACTIVE },
        });
        const transition = samePlan
          ? await new SamePlanBillingPeriodRolloverService({
              $transaction: async (
                callback: (client: typeof transaction) => unknown,
              ) => callback(transaction),
            } as never).transitionInTransaction(transaction, {
              shopId,
              subscriptionId,
              provider,
              plan: planInput,
              now,
            })
          : await new ShopifyPlanChangeTransitionService({
              $transaction: async (
                callback: (client: typeof transaction) => unknown,
              ) => callback(transaction),
            } as never).transitionInTransaction(transaction, {
              shopId,
              subscriptionId,
              provider,
              plan: planInput,
              expectedCurrentPlanId: subscription.planId ?? "",
              now,
            });
        if (
          transition.kind !== "transitioned" &&
          transition.kind !== "unchanged"
        ) {
          await transaction.subscription.update({
            where: { id: subscriptionId },
            data: {
              status: SubscriptionProjectionStatus.SYNC_ERROR,
              lastSyncedAt: now,
              lastSyncErrorCode: "UNEXPECTED_IMMEDIATE_PLAN_CHANGE",
              lastSyncErrorAt: now,
              nextReconcileAt: new Date(
                now.getTime() + this.providerRetryIntervalMs(),
              ),
              lastProviderLifecycleState: lifecycle.state,
              lastProviderLifecycleEventId: lifecycle.id,
              lastProviderLifecycleEventAt: lifecycle.occurredAt,
            },
          });
          return "handled";
        }
        await transaction.subscription.update({
          where: { id: subscriptionId },
          data: {
            lastSyncedAt: now,
            lastSyncErrorCode: null,
            lastSyncErrorAt: null,
            lastProviderLifecycleState: lifecycle.state,
            lastProviderLifecycleEventId: lifecycle.id,
            lastProviderLifecycleEventAt: lifecycle.occurredAt,
          },
        });
        return "restored";
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /** Persist the original accounting failure without closing or replacing its evidence. */
  private async preserveUnfreezeAccountingFailure(
    transaction: Prisma.TransactionClient,
    subscriptionId: string,
    errorCode: string,
    provider: PartnerSubscription,
    lifecycle: PartnerSubscriptionLifecycleEvent,
    now: Date,
  ): Promise<void> {
    await transaction.subscription.update({
      where: { id: subscriptionId },
      data: {
        status: SubscriptionProjectionStatus.SYNC_ERROR,
        observedShopifyPlanHandle: provider.planHandle,
        lastSyncErrorCode: unfreezeAccountingErrorCode(errorCode),
        lastSyncedAt: now,
        nextReconcileAt: new Date(
          now.getTime() + this.providerRetryIntervalMs(),
        ),
        lastProviderLifecycleState: lifecycle.state,
        lastProviderLifecycleEventId: lifecycle.id,
        lastProviderLifecycleEventAt: lifecycle.occurredAt,
      },
    });
  }

  private async updateUnfreezeFailure(
    transaction: Prisma.TransactionClient,
    subscriptionId: string,
    subscription: Prisma.SubscriptionGetPayload<{
      include: { billingPeriod: true; plan: true };
    }>,
    provider: PartnerSubscription,
    lifecycle: PartnerSubscriptionLifecycleEvent,
    now: Date,
    errorCode: string | null,
    status: SubscriptionProjectionStatus,
  ): Promise<void> {
    const mapping = await resolveShopifyUsageEventMapping(
      transaction,
      provider.planHandle,
      provider.usageEventHandles,
    );
    const pendingPlan = provider.pendingPlanHandle
      ? await transaction.billingPlan.findUnique({
          where: { shopifyPlanHandle: provider.pendingPlanHandle },
          select: { id: true, active: true },
        })
      : null;
    const unknownPlan = errorCode === null;
    const unmapped = status === SubscriptionProjectionStatus.UNMAPPED;
    // Detach the former current cycle without deleting its history. The
    // canonical close releases outstanding reservations and closes the paid
    // allowance counter atomically with the status transition.
    if (
      unmapped &&
      subscription.billingPeriod?.status === BillingPeriodStatus.OPEN
    ) {
      const previousKind =
        subscription.billingPeriod.planKindSnapshot ?? subscription.plan?.kind;
      if (!previousKind)
        throw new Error(
          "Open billing period plan kind is missing during unfreeze unmapping",
        );
      await closeBillingPeriod(transaction, {
        billingPeriodId: subscription.billingPeriod.id,
        planKind: previousKind,
        closedAt: now,
        closeReason: BillingPeriodCloseReason.PLAN_CHANGED,
        openPeriodFailureMessage:
          "Billing period was not open while unmapping an unfrozen Shopify contract",
      });
    }
    await transaction.subscription.update({
      where: { id: subscriptionId },
      data: {
        status,
        ...(unmapped
          ? {
              planId: null,
              billingPeriodId: null,
              currentPeriodStart: null,
              currentPeriodEnd: null,
              trialEndsAt: null,
            }
          : {}),
        unmappedShopifyUsageEventHandles: mapping.unmappedProviderHandles,
        observedShopifyPlanHandle: provider.planHandle,
        providerSubscriptionId: provider.providerSubscriptionId,
        pendingShopifyPlanHandle: provider.pendingPlanHandle,
        pendingPlanId: pendingPlan?.active ? pendingPlan.id : null,
        pendingEffectiveAt: provider.pendingEffectiveAt,
        cancelAtPeriodEnd: provider.pendingPlanHandle
          ? false
          : provider.cancelAtPeriodEnd,
        lastSyncedAt: now,
        lastSyncErrorCode: errorCode,
        lastSyncErrorAt: unknownPlan ? null : now,
        nextReconcileAt: unknownPlan
          ? null
          : new Date(now.getTime() + this.providerRetryIntervalMs()),
        lastProviderLifecycleState: lifecycle.state,
        lastProviderLifecycleEventId: lifecycle.id,
        lastProviderLifecycleEventAt: lifecycle.occurredAt,
      },
    });
  }

  private async cancel(
    shopId: string,
    subscriptionId: string,
    lifecycle: PartnerSubscriptionLifecycleEvent,
    now: Date,
  ): Promise<void> {
    await this.database.$transaction(
      async (transaction) => {
        await lockSubscription(transaction, subscriptionId);
        const subscription = await transaction.subscription.findUnique({
          where: { id: subscriptionId },
          include: { billingPeriod: true },
        });
        if (
          !subscription ||
          isStrictlyOlder(
            subscription.lastProviderLifecycleEventAt,
            subscription.lastProviderLifecycleEventId,
            lifecycle,
          )
        )
          return;
        const established =
          subscription.planId !== null ||
          subscription.providerSubscriptionId !== null ||
          subscription.billingPeriodId !== null;
        if (
          !established &&
          subscription.status === SubscriptionProjectionStatus.NO_CONTRACT
        )
          return;
        const period = subscription.billingPeriod;
        if (period?.status === BillingPeriodStatus.OPEN) {
          await closeBillingPeriod(transaction, {
            billingPeriodId: period.id,
            planKind: period.planKindSnapshot ?? BillingPlanKind.FREE,
            closedAt: now,
            closeReason: BillingPeriodCloseReason.CONTRACT_ENDED,
            openPeriodFailureMessage:
              "Billing period was not open while closing contract",
          });
        }
        await transaction.subscription.update({
          where: { id: subscriptionId },
          data: {
            planId: null,
            observedShopifyPlanHandle: null,
            status: SubscriptionProjectionStatus.NO_CONTRACT,
            billingPeriodId: null,
            currentPeriodStart: null,
            currentPeriodEnd: null,
            trialEndsAt: null,
            cancelAtPeriodEnd: false,
            providerSubscriptionId: null,
            pendingShopifyPlanHandle: null,
            pendingPlanId: null,
            pendingEffectiveAt: null,
            nextReconcileAt: null,
            lastSyncedAt: now,
            unmappedShopifyUsageEventHandles: [],
            lastSyncErrorCode: null,
            lastSyncErrorAt: null,
            lastProviderLifecycleState: lifecycle.state,
            lastProviderLifecycleEventId: lifecycle.id,
            lastProviderLifecycleEventAt: lifecycle.occurredAt,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}

async function isSameCycleAccountingValid(
  transaction: Prisma.TransactionClient,
  input: {
    shopId: string;
    subscriptionId: string;
    provider: PartnerSubscription;
    plan: {
      id: string;
      kind: BillingPlanKind;
      includedRecoveryConversationAllowance: number | null;
    };
    subscription: Prisma.SubscriptionGetPayload<{
      include: { billingPeriod: true; plan: true };
    }>;
    verifyOutstandingReservations?: boolean;
  },
): Promise<boolean> {
  const period = input.subscription.billingPeriod;
  if (
    !period ||
    period.id !== input.subscription.billingPeriodId ||
    period.status !== BillingPeriodStatus.OPEN ||
    period.shopId !== input.shopId ||
    period.subscriptionId !== input.subscriptionId ||
    period.planId !== input.plan.id ||
    period.shopifyPlanHandleSnapshot !== input.provider.planHandle ||
    period.planKindSnapshot !== input.plan.kind ||
    period.periodStart.getTime() !==
      input.provider.currentPeriodStart?.getTime() ||
    period.periodEnd.getTime() !== input.provider.currentPeriodEnd?.getTime()
  )
    return false;

  const counter = await transaction.billingPeriodEntitlementCounter.findUnique({
    where: {
      billingPeriodId_counter: {
        billingPeriodId: period.id,
        counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
      },
    },
  });
  if (input.plan.kind === BillingPlanKind.FREE) return counter === null;
  const allowance = input.plan.includedRecoveryConversationAllowance;
  if (
    !counter ||
    allowance === null ||
    counter.billingPeriodId !== period.id ||
    counter.shopId !== input.shopId ||
    counter.grantedQuantity !== allowance ||
    period.includedRecoveryCreditsGranted !== allowance
  )
    return false;
  const quantities = [
    counter.grantedQuantity,
    counter.committedQuantity,
    counter.reservedQuantity,
    counter.forfeitedQuantity,
  ];
  if (
    !quantities.every(
      (quantity) => Number.isSafeInteger(quantity) && quantity >= 0,
    ) ||
    counter.committedQuantity +
      counter.reservedQuantity +
      counter.forfeitedQuantity >
      counter.grantedQuantity
  )
    return false;
  if (input.verifyOutstandingReservations) {
    // Reconcile the counter with the durable reservation ledger before
    // clearing an existing accounting error. Ordinary unfreeze avoids this read.
    const outstanding = await transaction.usageReservation.aggregate({
      where: {
        billingPeriodEntitlementCounterId: counter.id,
        status: {
          in: [
            UsageReservationStatus.RESERVED,
            UsageReservationStatus.AMBIGUOUS,
          ],
        },
      },
      _sum: { quantity: true },
    });
    return Number(outstanding._sum.quantity ?? 0) === counter.reservedQuantity;
  }
  return true;
}

function validateProviderPlan(
  plan: {
    active: boolean;
    kind: BillingPlanKind;
    includedRecoveryConversationAllowance: number | null;
    recoveryCreditPackEnabled: boolean;
    shopifyRecoveryCreditPackEventHandle: string | null;
  },
  provider: PartnerSubscription,
):
  | "UNMAPPED_PLAN_HANDLE"
  | "MISSING_BILLING_CYCLE"
  | "INVALID_INCLUDED_ALLOWANCE"
  | "MISSING_USAGE_METER"
  | null {
  if (!plan.active) return "UNMAPPED_PLAN_HANDLE";
  const needsCycle =
    plan.kind === BillingPlanKind.PAID_METERED ||
    (plan.kind === BillingPlanKind.FREE && plan.recoveryCreditPackEnabled);
  if (
    needsCycle &&
    (!provider.currentPeriodStart ||
      !provider.currentPeriodEnd ||
      provider.currentPeriodStart >= provider.currentPeriodEnd)
  ) {
    return "MISSING_BILLING_CYCLE";
  }
  if (plan.kind === BillingPlanKind.PAID_METERED) {
    if (
      !Number.isSafeInteger(plan.includedRecoveryConversationAllowance) ||
      (plan.includedRecoveryConversationAllowance ?? -1) < 0
    )
      return "INVALID_INCLUDED_ALLOWANCE";
  }
  if (
    plan.recoveryCreditPackEnabled &&
    (!plan.shopifyRecoveryCreditPackEventHandle ||
      !provider.usageEventHandles.includes(
        plan.shopifyRecoveryCreditPackEventHandle,
      ))
  )
    return "MISSING_USAGE_METER";
  return null;
}

function nextCycleReconcileAt(periodEnd: Date, now: Date): Date {
  const preCloseAt = new Date(
    periodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS,
  );
  return now < preCloseAt ? preCloseAt : periodEnd;
}

function isStrictlyOlder(
  persistedAt: Date | null,
  persistedId: string | null,
  incoming: PartnerSubscriptionLifecycleEvent,
): boolean {
  const occurredAt = incoming.occurredAt?.getTime?.();
  return (
    persistedAt instanceof Date &&
    occurredAt !== undefined &&
    (persistedAt.getTime() > occurredAt ||
      (persistedAt.getTime() === occurredAt &&
        persistedId !== null &&
        persistedId > incoming.id))
  );
}

function isSameEvent(
  persistedAt: Date | null,
  persistedId: string | null,
  incoming: PartnerSubscriptionLifecycleEvent,
): boolean {
  const occurredAt = incoming.occurredAt?.getTime?.();
  return (
    persistedAt instanceof Date &&
    occurredAt !== undefined &&
    persistedAt.getTime() === occurredAt &&
    persistedId === incoming.id
  );
}

async function lockSubscription(
  transaction: Prisma.TransactionClient,
  subscriptionId: string,
): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`
    SELECT "id" FROM "billing"."Subscription" WHERE "id" = ${subscriptionId} FOR UPDATE
  `);
}
