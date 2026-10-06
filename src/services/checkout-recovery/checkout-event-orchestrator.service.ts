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

type PendingCandidatePort = Pick<
  typeof pendingRecoveryCandidateService,
  "scheduleFromCheckoutCreated" | "refreshCandidateActivity" | "scheduleFromCheckoutUpdated"
>;
type ExecutionEligibilityPort = Pick<
  typeof shopExecutionEligibilityService,
  "resolveShopById" | "evaluateResolvedShop"
>;
type AbandonedCheckoutLookupPort = Pick<typeof abandonedCheckoutLookupService, "lookup">;
type LatestRecoveryLookup = typeof findLatestRecovery;
type SnapshotLineItemSerializer = Pick<RecoverySnapshotBuilderService, "serializeLineItems">;

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

  async recordExternalActivity(recoveryId: string, activityAt: Date) {
    return this.database.checkoutRecovery.updateMany({
      where: {
        id: recoveryId,
        status: { in: ["DETECTED", "MESSAGE_SENT", "ENGAGED"] },
        lastExternalActivityAt: { lt: activityAt },
      },
      data: { lastExternalActivityAt: activityAt },
    });
  }

  async handleCheckoutUpdatedContract(
    event: CheckoutUpdatedContractInput,
  ): Promise<CheckoutRefreshResult> {
    const shop = await this.database.shop.findUnique({
      where: { domain: event.shopDomain },
      select: {
        id: true,
        status: true,
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
      ...(event.internationalContext
        ? { internationalContext: event.internationalContext }
        : {}),
    });
    if (pending.outcome !== "not-found") {
      return {
        kind: "pending",
        outcome: pending.outcome,
        ...( "jobId" in pending ? { jobId: pending.jobId } : {}),
      };
    }

    const recovery = await this.findLatestRecovery(shop.id, event.checkoutToken);
    if (!recovery) {
      return { kind: "discarded", reason: "recovery-not-found" } as const;
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

    await this.recordExternalActivity(recovery.id, new Date(event.activityAt));

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