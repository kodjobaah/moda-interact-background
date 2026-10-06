import type { RecoveryCheckoutSeed } from "../../events/checkout-events.js";
import { toLookupInput, type NormalizedAbandonedCheckout } from "../../domain/abandoned-checkout.js";
import type { PendingRecoveryCandidate } from "../../domain/pending-recovery-candidate.js";
import type { AbandonedCheckoutLookupService } from "../abandoned-checkout-lookup.service.js";
import type { PendingRecoveryCandidateService } from "../pending-recovery-candidate.service.js";
import type { ShopExecutionEligibilityService } from "../shop-execution-eligibility.service.js";
import type { RecoverySnapshotBuilderService } from "./recovery-snapshot-builder.service.js";
import type { findLatestRecovery } from "./latest-recovery.js";

export type MaturedCandidateMaterializationResult =
  | { outcome: "recovery-created"; checkoutToken: string }
  | { outcome: "no-op-existing"; checkoutToken: string; status: string }
  | { outcome: "discarded-terminal"; checkoutToken: string; status: string }
  | { outcome: "discarded-not-found"; checkoutToken: string }
  | { outcome: "discarded-not-recoverable"; checkoutToken: string }
  | { outcome: "discarded-ambiguous"; checkoutToken: string }
  | { outcome: "discarded-bound-exceeded"; checkoutToken: string }
  | { outcome: "discarded-order-completed"; checkoutToken: string }
  | {
      outcome: "discarded-shop-unavailable";
      checkoutToken: string;
      reason?: "CONTRACT_REQUIRED" | "SUBSCRIPTION_FROZEN" | "SHOP_UNAVAILABLE" | "UNMAPPED_PLAN" | "SYNC_ERROR";
    };

type RecoveryMaterializationDependencies = {
  executionEligibility: Pick<ShopExecutionEligibilityService, "evaluate">;
  abandonedCheckoutLookup: Pick<AbandonedCheckoutLookupService, "resolveShopDomain" | "lookup">;
  pendingRecoveryCandidate: Pick<PendingRecoveryCandidateService, "withCheckoutLock" | "hasOrderProcessed">;
  findLatestRecovery: typeof findLatestRecovery;
  snapshotBuilder: Pick<RecoverySnapshotBuilderService, "build">;
  initiate: (seed: RecoveryCheckoutSeed, generation?: number) => Promise<unknown>;
};

export class RecoveryMaterializationService {
  constructor(private readonly dependencies: RecoveryMaterializationDependencies) {}

  async materialize(
    candidate: PendingRecoveryCandidate,
  ): Promise<MaturedCandidateMaterializationResult> {
    const execution = await this.dependencies.executionEligibility.evaluate(
      candidate.shopId,
      undefined,
      "recovery",
    );
    if (!execution.allowed) {
      return {
        outcome: "discarded-shop-unavailable",
        checkoutToken: candidate.checkoutToken,
        ...(execution.reason !== "SHOP_UNAVAILABLE" ? { reason: execution.reason } : {}),
      } as const;
    }
    const shopDomain = await this.dependencies.abandonedCheckoutLookup.resolveShopDomain(candidate.shopId);

    return this.dependencies.pendingRecoveryCandidate.withCheckoutLock(
      candidate.shopId,
      candidate.checkoutToken,
      async () => {
        const lockedExecution = await this.dependencies.executionEligibility.evaluate(
          candidate.shopId,
          undefined,
          "recovery",
        );
        if (!lockedExecution.allowed) {
          return {
            outcome: "discarded-shop-unavailable",
            checkoutToken: candidate.checkoutToken,
            ...(lockedExecution.reason !== "SHOP_UNAVAILABLE" ? { reason: lockedExecution.reason } : {}),
          } as const;
        }

        if (await this.dependencies.pendingRecoveryCandidate.hasOrderProcessed(candidate.shopId, candidate.checkoutToken)) {
          return {
            outcome: "discarded-order-completed",
            checkoutToken: candidate.checkoutToken,
          } as const;
        }

        const existing = await this.dependencies.findLatestRecovery(candidate.shopId, candidate.checkoutToken);
        let generation = 1;
        if (existing) {
          if (["DETECTED", "MESSAGE_SENT", "ENGAGED"].includes(existing.status)) {
            return {
              outcome: "no-op-existing",
              checkoutToken: candidate.checkoutToken,
              status: existing.status,
            } as const;
          }
          if (["COMPLETED", "CANCELLED"].includes(existing.status)) {
            return {
              outcome: "discarded-terminal",
              checkoutToken: candidate.checkoutToken,
              status: existing.status,
            } as const;
          }
          generation = existing.generation + 1;
        }

        const outcome = await this.dependencies.abandonedCheckoutLookup.lookup(
          toLookupInput(candidate, shopDomain),
        );
        if (outcome.kind === "provider-error") {
          throw new Error(
            `Abandoned checkout provider error while materializing candidate: ${outcome.message}`,
          );
        }
        if (outcome.kind === "not-found") {
          return { outcome: "discarded-not-found", checkoutToken: candidate.checkoutToken } as const;
        }
        if (outcome.kind === "ambiguous") {
          return { outcome: "discarded-ambiguous", checkoutToken: candidate.checkoutToken } as const;
        }
        if (outcome.kind === "bounded-limit-exceeded") {
          return { outcome: "discarded-bound-exceeded", checkoutToken: candidate.checkoutToken } as const;
        }

        const checkout: NormalizedAbandonedCheckout = outcome.checkout;
        if (checkout.completedAt != null) {
          return { outcome: "discarded-not-recoverable", checkoutToken: candidate.checkoutToken } as const;
        }

        const seed = await this.dependencies.snapshotBuilder.build(candidate, shopDomain, checkout);
        if (generation === 1) {
          await this.dependencies.initiate(seed);
        } else {
          await this.dependencies.initiate(seed, generation);
        }

        return { outcome: "recovery-created", checkoutToken: seed.checkoutToken } as const;
      },
    );
  }
}