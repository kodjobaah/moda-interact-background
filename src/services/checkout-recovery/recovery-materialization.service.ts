import type { RecoveryCheckoutSeed } from "../../events/checkout-events.js";
import { toLookupInput, type NormalizedAbandonedCheckout } from "../../domain/abandoned-checkout.js";
import type { PendingRecoveryCandidate } from "../../domain/pending-recovery-candidate.js";
import type { AbandonedCheckoutLookupService } from "../abandoned-checkout-lookup.service.js";
import type { PendingRecoveryCandidateService } from "../pending-recovery-candidate.service.js";
import type { ShopExecutionEligibilityService } from "../shop-execution-eligibility.service.js";
import type { RecoverySnapshotBuilderService } from "./recovery-snapshot-builder.service.js";
import type { findLatestRecovery } from "./latest-recovery.js";
import type { RecoveryRecipientResolverService } from "./recovery-recipient-resolver.service.js";
import { InitialOutreachHeldError, type InitialOutreachProgress } from "./recovery-initiation.service.js";

export type MaturedCandidateMaterializationResult =
  | { outcome: "recovery-created"; checkoutToken: string }
  | { outcome: "recovery-reentered"; checkoutToken: string }
  | { outcome: "recovery-reconciled"; checkoutToken: string; recoveryId: string }
  | { outcome: "deferred-initial-outreach"; checkoutToken: string; recoveryId: string; reason: "pre-permit-refused" | "provider-rejected" | "recipient-unreachable" }
  | { outcome: "deferred-no-recipient"; checkoutToken: string }
  | { outcome: "discarded-admission-denied"; checkoutToken: string }
  | { outcome: "no-op-existing"; checkoutToken: string; status: string }
  | { outcome: "discarded-terminal"; checkoutToken: string; status: string }
  | { outcome: "discarded-superseded"; checkoutToken: string }
  | { outcome: "discarded-not-found"; checkoutToken: string }
  | { outcome: "discarded-not-recoverable"; checkoutToken: string }
  | { outcome: "discarded-ambiguous"; checkoutToken: string }
  | { outcome: "discarded-bound-exceeded"; checkoutToken: string }
  | { outcome: "discarded-order-completed"; checkoutToken: string }
  | { outcome: "deferred-lookup-unavailable"; checkoutToken: string }
  | {
      outcome: "discarded-shop-unavailable";
      checkoutToken: string;
      reason?: "CONTRACT_REQUIRED" | "SUBSCRIPTION_FROZEN" | "SHOP_UNAVAILABLE" | "UNMAPPED_PLAN" | "SYNC_ERROR";
    };

type RecoveryMaterializationDependencies = {
  executionEligibility: Pick<ShopExecutionEligibilityService, "evaluate">;
  abandonedCheckoutLookup: Pick<AbandonedCheckoutLookupService, "resolveShopDomain" | "lookup">;
  pendingRecoveryCandidate: Pick<PendingRecoveryCandidateService,
    "withCheckoutLock" | "hasOrderProcessed" | "findCandidateJobIdByCheckout">;
  findLatestRecovery: typeof findLatestRecovery;
  snapshotBuilder: Pick<RecoverySnapshotBuilderService, "build">;
  recipientResolver: Pick<RecoveryRecipientResolverService, "resolve">;
  continueInitialOutreach?: (input: { shopId: string; recoveryId: string }) => Promise<InitialOutreachProgress>;
  initiate: (seed: RecoveryCheckoutSeed, generation: number, recipient: string) => Promise<unknown>;
  noticeMissingRecipient?: (shopId: string, checkoutToken: string) => Promise<void>;
};

export class RecoveryMaterializationService {
  constructor(private readonly dependencies: RecoveryMaterializationDependencies) {}

  async materialize(
    candidate: PendingRecoveryCandidate,
    options: { jobId?: string; retrySuppressionAdmission?: boolean } = {},
  ): Promise<MaturedCandidateMaterializationResult> {
    return this.dependencies.pendingRecoveryCandidate.withCheckoutLock(
      candidate.shopId,
      candidate.checkoutToken,
      async () => {
        const existing = await this.dependencies.findLatestRecovery(candidate.shopId, candidate.checkoutToken);
        let generation = 1;
        const reenterSuppressionRetry = options.retrySuppressionAdmission &&
          existing?.status === "DETECTED";
        let continueExistingGeneration = false;
        if (existing) {
          if (this.dependencies.continueInitialOutreach) {
            const progress = await this.dependencies.continueInitialOutreach({
              shopId: candidate.shopId,
              recoveryId: existing.id,
            });
            if (progress.kind === "reconciled") {
              return { outcome: "recovery-reconciled", checkoutToken: candidate.checkoutToken, recoveryId: progress.recoveryId } as const;
            }
            if (progress.kind === "blocked") {
              return { outcome: "deferred-initial-outreach", checkoutToken: candidate.checkoutToken, recoveryId: progress.recoveryId, reason: progress.reason } as const;
            }
            if (progress.kind === "held") {
              throw new InitialOutreachHeldError(progress.recoveryId, progress.reason, progress.creditReason);
            }
          }
          if (["DETECTED", "MESSAGE_SENT", "ENGAGED"].includes(existing.status)) {
            if (existing.status !== "DETECTED") {
              return { outcome: "no-op-existing", checkoutToken: candidate.checkoutToken, status: existing.status } as const;
            }
            if (this.dependencies.continueInitialOutreach) {
              continueExistingGeneration = true;
              generation = existing.generation;
            } else if (!reenterSuppressionRetry) {
              return {
                outcome: "no-op-existing",
                checkoutToken: candidate.checkoutToken,
                status: existing.status,
              } as const;
            } else {
              generation = existing.generation;
              continueExistingGeneration = true;
            }
          } else {
            generation = existing.generation + 1;
          }
          if (["COMPLETED", "CANCELLED"].includes(existing.status)) {
            return {
              outcome: "discarded-terminal",
              checkoutToken: candidate.checkoutToken,
              status: existing.status,
            } as const;
          }
        }

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

        const indexedJobId = options.jobId
          ? await this.dependencies.pendingRecoveryCandidate.findCandidateJobIdByCheckout({
            shopId: candidate.shopId,
            checkoutToken: candidate.checkoutToken,
          })
          : null;
        if (indexedJobId && indexedJobId !== options.jobId) {
          return { outcome: "discarded-superseded", checkoutToken: candidate.checkoutToken } as const;
        }

        const shopDomain = await this.dependencies.abandonedCheckoutLookup.resolveShopDomain(candidate.shopId);

        if (!candidate.abandonedCheckoutUrl || !candidate.checkoutCreatedAt) {
          return {
            outcome: "deferred-lookup-unavailable",
            checkoutToken: candidate.checkoutToken,
          } as const;
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
        const recipient = await this.dependencies.recipientResolver.resolve(seed);
        if (!recipient) {
          await this.dependencies.noticeMissingRecipient?.(candidate.shopId, candidate.checkoutToken);
          return { outcome: "deferred-no-recipient", checkoutToken: candidate.checkoutToken } as const;
        }
        const initiated = await this.dependencies.initiate(seed, generation, recipient);
        if (initiated === null) {
          return { outcome: "discarded-admission-denied", checkoutToken: candidate.checkoutToken } as const;
        }

        if (reenterSuppressionRetry || continueExistingGeneration) {
          return { outcome: "recovery-reentered", checkoutToken: seed.checkoutToken } as const;
        }
        return { outcome: "recovery-created", checkoutToken: seed.checkoutToken } as const;
      },
    );
  }
}