import type { PrismaClient } from "@prisma/client";
import type {
  CartActivityContractInput,
  CheckoutCreatedContractInput,
  CheckoutUpdatedContractInput,
} from "../../events/shopify-contract-adapter.js";
import type { AbandonedCheckoutLookupInput } from "../../domain/abandoned-checkout.js";
import type { RecoverySnapshotBuilderService } from "./recovery-snapshot-builder.service.js";
import type { findLatestRecovery } from "./latest-recovery.js";
import type { pendingRecoveryCandidateService } from "../pending-recovery-candidate.service.js";
import type { shopExecutionEligibilityService } from "../shop-execution-eligibility.service.js";
import type { abandonedCheckoutLookupService } from "../abandoned-checkout-lookup.service.js";
import type { ShopExecutionDenialReason } from "../shop-execution-eligibility.service.js";
import {
  recoveryCapacityResumeService,
} from "../recovery-capacity-resume.service.js";
import { recoveryPolicyService } from "../recovery-policy.service.js";

type PendingCandidatePort = Pick<
  typeof pendingRecoveryCandidateService,
  "scheduleFromCheckoutCreated" | "refreshCandidateActivity" | "scheduleFromCheckoutUpdated" | "withCheckoutLock"
>;
type ExecutionEligibilityPort = Pick<
  typeof shopExecutionEligibilityService,
  "resolveShopById" | "evaluateResolvedShop"
>;
type AbandonedCheckoutLookupPort = Pick<typeof abandonedCheckoutLookupService, "lookup">;
type LatestRecoveryLookup = typeof findLatestRecovery;
type SnapshotLineItemSerializer = Pick<RecoverySnapshotBuilderService, "serializeLineItems">;
type RecoveryResumeScheduler = Pick<typeof recoveryCapacityResumeService, "schedule">;
type RecoveryPolicyResolver = Pick<typeof recoveryPolicyService, "resolve">;

export type CheckoutRefreshResult =
  | { kind: "pending"; outcome: string; jobId?: string }
  | { kind: "refreshed"; recoveryId: string; status: string }
  | { kind: "discarded"; reason: string }
  | { kind: "ignored"; reason: string };

export class CheckoutEventOrchestratorService {
  constructor(
    private readonly database: PrismaClient,
    private readonly pendingRecoveryCandidateService: PendingCandidatePort,
    private readonly shopExecutionEligibilityService: ExecutionEligibilityPort,
    private readonly findLatestRecovery: LatestRecoveryLookup,
    private readonly abandonedCheckoutLookupService: AbandonedCheckoutLookupPort,
    private readonly snapshotBuilder: SnapshotLineItemSerializer,
    private readonly recoveryResumeScheduler: RecoveryResumeScheduler = recoveryCapacityResumeService,
    private readonly recoveryPolicyResolver: RecoveryPolicyResolver = recoveryPolicyService,
  ) {}

  async handleCheckoutCreatedContract(event: CheckoutCreatedContractInput) {
    const scheduled = await this.pendingRecoveryCandidateService.scheduleFromCheckoutCreated(event);

    if (scheduled.outcome === "discarded-shop-unavailable") {
      return {
        kind: "ignored",
        reason: "shop-unavailable",
        shopDomain: scheduled.shopDomain,
        checkoutToken: event.checkoutToken,
        source: "v2",
      } as const;
    }
    if (scheduled.outcome === "discarded-subscription-frozen") {
      return {
        kind: "ignored",
        reason: "subscription-frozen",
        shopDomain: scheduled.shopDomain,
        checkoutToken: event.checkoutToken,
        source: "v2",
      } as const;
    }

    return {
      kind: "scheduled",
      outcome: scheduled.outcome,
      delayMinutes: scheduled.delayMinutes,
      shopDomain: event.shopDomain,
      checkoutToken: event.checkoutToken,
      source: "v2",
    } as const;
  }

  async recordExternalActivity(
    recoveryId: string,
    activityAt: Date,
    checkoutIdentity?: { shopId: string; checkoutToken: string },
  ) {
    const identity = checkoutIdentity ?? await this.database.checkoutRecovery.findUnique({
      where: { id: recoveryId },
      select: { shopId: true, checkoutToken: true },
    });
    if (!identity) return { count: 0 };

    return this.pendingRecoveryCandidateService.withCheckoutLock(
      identity.shopId,
      identity.checkoutToken,
      () => this.database.checkoutRecovery.updateMany({
        where: {
          id: recoveryId,
          status: { in: ["DETECTED", "MESSAGE_SENT", "ENGAGED"] },
          lastExternalActivityAt: { lt: activityAt },
        },
        data: { lastExternalActivityAt: activityAt },
      }),
    );
  }

  async handleCheckoutUpdatedContract(
    event: CheckoutUpdatedContractInput,
  ): Promise<CheckoutRefreshResult> {
    const shop = await this.database.shop.findUnique({
      where: { domain: event.shopDomain },
      select: {
        id: true,
        status: true,
        platform: true,
        onboardingCompleted: true,
        subscription: {
          select: {
            status: true,
            lastProviderLifecycleState: true,
          },
        },
      },
    });
    if (!shop) {
      return { kind: "discarded", reason: "shop-not-found" } as const;
    }
    const execution = this.shopExecutionEligibilityService.evaluateResolvedShop(
      shop,
      "recovery",
    );
    if (!execution.allowed) {
      return { kind: "ignored", reason: lifecycleReason(execution.reason) } as const;
    }

    const pending = await this.pendingRecoveryCandidateService.refreshCandidateActivity({
      shopId: shop.id,
      checkoutToken: event.checkoutToken,
      cartToken: null,
      activityAt: event.activityAt,
      isEmpty: null,
      ...(event.cartToken !== undefined ? { checkoutCartToken: event.cartToken } : {}),
      ...(event.checkoutCreatedAt !== undefined
        ? { checkoutCreatedAt: event.checkoutCreatedAt }
        : {}),
      ...(event.abandonedCheckoutUrl !== undefined
        ? { abandonedCheckoutUrl: event.abandonedCheckoutUrl }
        : {}),
      ...(event.internationalContext
        ? { internationalContext: event.internationalContext }
        : {}),
    });
    if (pending.outcome !== "not-found" && pending.outcome !== "not-reschedulable") {
      return {
        kind: "pending",
        outcome: pending.outcome,
        ...( "jobId" in pending ? { jobId: pending.jobId } : {}),
      };
    }

    const recovery = await this.findLatestRecovery(shop.id, event.checkoutToken);
    if (!recovery) {
      const scheduled = await this.pendingRecoveryCandidateService.scheduleFromCheckoutUpdated({
        shopDomain: event.shopDomain,
        checkoutToken: event.checkoutToken,
        ...(event.cartToken !== undefined ? { cartToken: event.cartToken } : {}),
        ...(event.checkoutCreatedAt !== undefined
          ? { checkoutCreatedAt: event.checkoutCreatedAt }
          : {}),
        ...(event.abandonedCheckoutUrl !== undefined
          ? { abandonedCheckoutUrl: event.abandonedCheckoutUrl }
          : {}),
        activityAt: event.activityAt,
        ...(event.internationalContext
          ? { internationalContext: event.internationalContext }
          : {}),
      });
      if (scheduled.outcome === "discarded-order-completed") {
        return { kind: "ignored", reason: "order-completed" } as const;
      }
      return {
        kind: "pending",
        outcome: scheduled.outcome,
        ...( "jobId" in scheduled ? { jobId: scheduled.jobId } : {}),
      } as const;
    }

    if (["COMPLETED", "CANCELLED"].includes(recovery.status)) {
      return {
        kind: "ignored",
        reason: `terminal-${recovery.status.toLowerCase()}`,
      } as const;
    }

    if (recovery.status === "EXPIRED") {
      const scheduled = await this.pendingRecoveryCandidateService.scheduleFromCheckoutUpdated({
        shopDomain: event.shopDomain,
        checkoutToken: event.checkoutToken,
        cartToken: recovery.cartToken,
        checkoutCreatedAt: recovery.detectedAt.toISOString(),
        abandonedCheckoutUrl: recovery.checkoutUrl,
        activityAt: event.activityAt,
        ...(event.internationalContext
          ? { internationalContext: event.internationalContext }
          : {}),
      });
      return {
        kind: "pending",
        outcome: scheduled.outcome,
        ...( "jobId" in scheduled ? { jobId: scheduled.jobId } : {}),
      } as const;
    }

    const lookupInput: AbandonedCheckoutLookupInput = {
      shopId: shop.id,
      shopDomain: event.shopDomain,
      checkoutToken: event.checkoutToken,
      cartToken: recovery.cartToken,
      abandonedCheckoutUrl: recovery.checkoutUrl,
      checkoutCreatedAt: recovery.detectedAt
        ? recovery.detectedAt.toISOString()
        : null,
    };

    await this.recordExternalActivity(recovery.id, new Date(event.activityAt), {
      shopId: shop.id,
      checkoutToken: event.checkoutToken,
    });

    const outcome = await this.abandonedCheckoutLookupService.lookup(lookupInput);
    if (outcome.kind === "provider-error") {
      throw new Error(
        `Abandoned checkout provider error while refreshing recovery ${recovery.id}: ${outcome.message}`,
      );
    }

    if (outcome.kind !== "found") {
      return {
        kind: "discarded",
        reason: `lookup-${outcome.kind}`,
      } as const;
    }

    const checkout = outcome.checkout;
    const refreshed = await this.database.$transaction(async (transaction) => {
      return transaction.checkoutRecovery.updateMany({
        where: {
          id: recovery.id,
          status: { in: ["DETECTED", "MESSAGE_SENT", "ENGAGED"] },
        },
        data: {
          currency: checkout.currencyCode,
          totalPrice: checkout.totalPrice,
          checkoutUrl: checkout.abandonedCheckoutUrl,
          lineItems: this.snapshotBuilder.serializeLineItems(checkout.lineItems),
        },
      });
    });

    if (refreshed.count === 0) {
      return { kind: "ignored", reason: "already-transitioned" } as const;
    }

    if (
      recovery.status === "DETECTED" &&
      (recovery.admissionBlockReason == null ||
        recovery.admissionBlockReason === "WHATSAPP_RECIPIENT_SUPPRESSED")
    ) {
      const current = await this.database.checkoutRecovery.findUnique({
        where: { id: recovery.id },
        select: { lastExternalActivityAt: true },
      });
      if (!current) return { kind: "ignored", reason: "already-transitioned" } as const;
      const policy = await this.recoveryPolicyResolver.resolve(shop.id);
      const dueAt = new Date(
        current.lastExternalActivityAt.getTime() + policy.recoveryDelayMinutes * 60_000,
      );
      const trigger = `recipient-suppression-${recovery.id}-checkout-update-${current.lastExternalActivityAt.getTime()}`;
      const jobId = await this.recoveryResumeScheduler.schedule({
        shopId: shop.id,
        recoveryId: recovery.id,
        trigger,
      }, dueAt);
      return { kind: "pending", outcome: "suppression-resume-scheduled", jobId } as const;
    }

    return {
      kind: "refreshed",
      recoveryId: recovery.id,
      status: recovery.status,
    } as const;
  }

  async handleCartActivityContract(event: CartActivityContractInput) {
    const shop = await this.shopExecutionEligibilityService.resolveShopById(event.shopId);
    if (!shop) {
      return { kind: "ignored", reason: "shop-unavailable" } as const;
    }
    const execution = this.shopExecutionEligibilityService.evaluateResolvedShop(
      shop,
      "recovery",
    );
    if (!execution.allowed) {
      return { kind: "ignored", reason: lifecycleReason(execution.reason) } as const;
    }
    const result = await this.pendingRecoveryCandidateService.refreshCandidateActivity({
      shopId: event.shopId,
      checkoutToken: null,
      cartToken: event.cartToken,
      activityAt: event.activityAt,
      isEmpty: event.isEmpty,
    });

    return {
      kind: "pending",
      outcome: result.outcome,
      ...( "jobId" in result ? { jobId: result.jobId } : {}),
    } as const;
  }
}

function lifecycleReason(reason: ShopExecutionDenialReason) {
  return reason === "CONTRACT_REQUIRED"
    ? "contract-required"
    : reason === "SUBSCRIPTION_FROZEN"
      ? "subscription-frozen"
      : "shop-unavailable";
}