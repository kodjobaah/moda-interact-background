import type { RecoveryCheckoutSeed } from "../../events/checkout-events.js";
import {
  toLookupInput,
  type NormalizedAbandonedCheckout,
} from "../../domain/abandoned-checkout.js";
import type { PendingRecoveryCandidate } from "../../domain/pending-recovery-candidate.js";
import type { AbandonedCheckoutLookupService } from "../abandoned-checkout-lookup.service.js";
import type { PendingRecoveryCandidateService } from "../pending-recovery-candidate.service.js";
import type { ShopExecutionEligibilityService } from "../shop-execution-eligibility.service.js";
import type { RecoverySnapshotBuilderService } from "./recovery-snapshot-builder.service.js";
import type { findLatestRecovery } from "./latest-recovery.js";
import type { RecoveryRecipientResolverService } from "./recovery-recipient-resolver.service.js";
import {
  InitialOutreachHeldError,
  type InitialOutreachProgress,
} from "./recovery-initiation.service.js";
import {
  shopifyCheckoutConsentMaterializationService,
  type ShopifyCheckoutConsentMaterialization,
} from "../shopify-checkout-consent-materialization.service.js";
import { selectStoredShopifyCheckoutPhone } from "../shopify-whatsapp-consent/phone-resolution.js";

export type MaturedCandidateMaterializationResult =
  | { outcome: "recovery-created"; checkoutToken: string; recoveryId?: string }
  | {
      outcome: "recovery-reentered";
      checkoutToken: string;
      recoveryId?: string;
    }
  | {
      outcome: "recovery-reconciled";
      checkoutToken: string;
      recoveryId: string;
    }
  | {
      outcome: "deferred-initial-outreach";
      checkoutToken: string;
      recoveryId: string;
      reason:
        "pre-permit-refused" | "provider-rejected" | "recipient-unreachable";
    }
  | { outcome: "deferred-no-recipient"; checkoutToken: string }
  | { outcome: "discarded-admission-denied"; checkoutToken: string }
  | { outcome: "no-op-existing"; checkoutToken: string; status: string }
  | { outcome: "discarded-terminal"; checkoutToken: string; status: string }
  | { outcome: "discarded-superseded"; checkoutToken: string }
  | { outcome: "discarded-not-found"; checkoutToken: string }
  | { outcome: "discarded-not-recoverable"; checkoutToken: string }
  | { outcome: "discarded-consent-revoked"; checkoutToken: string }
  | { outcome: "discarded-consent-invalid"; checkoutToken: string }
  | { outcome: "deferred-consent-checkout-binding"; checkoutToken: string }
  | { outcome: "deferred-consent-identity-or-recipient"; checkoutToken: string }
  | { outcome: "discarded-consent-stop"; checkoutToken: string }
  | { outcome: "discarded-ambiguous"; checkoutToken: string }
  | { outcome: "discarded-bound-exceeded"; checkoutToken: string }
  | { outcome: "discarded-order-completed"; checkoutToken: string }
  | { outcome: "deferred-lookup-unavailable"; checkoutToken: string }
  | {
      outcome: "discarded-shop-unavailable";
      checkoutToken: string;
      reason?:
        | "CONTRACT_REQUIRED"
        | "SUBSCRIPTION_FROZEN"
        | "SHOP_UNAVAILABLE"
        | "UNMAPPED_PLAN"
        | "SYNC_ERROR";
    };

type RecoveryMaterializationDependencies = {
  executionEligibility: Pick<ShopExecutionEligibilityService, "evaluate">;
  abandonedCheckoutLookup: Pick<
    AbandonedCheckoutLookupService,
    "resolveShopDomain" | "lookup"
  >;
  pendingRecoveryCandidate: Pick<
    PendingRecoveryCandidateService,
    "withCheckoutLock" | "hasOrderProcessed" | "findCandidateJobIdByCheckout"
  >;
  findLatestRecovery: typeof findLatestRecovery;
  snapshotBuilder: Pick<RecoverySnapshotBuilderService, "build">;
  recipientResolver: Pick<RecoveryRecipientResolverService, "resolve">;
  consentReceipt?: Pick<
    typeof shopifyCheckoutConsentMaterializationService,
    "materialize"
  >;
  continueInitialOutreach?: (input: {
    shopId: string;
    recoveryId: string;
  }) => Promise<InitialOutreachProgress>;
  initiate: (
    seed: RecoveryCheckoutSeed,
    generation: number,
    recipient: string,
    customerId?: string,
  ) => Promise<unknown>;
  noticeMissingRecipient?: (
    shopId: string,
    checkoutToken: string,
    seed?: RecoveryCheckoutSeed,
  ) => Promise<void>;
};

export class RecoveryMaterializationService {
  constructor(
    private readonly dependencies: RecoveryMaterializationDependencies,
  ) {}

  async materialize(
    candidate: PendingRecoveryCandidate,
    options: { jobId?: string; retrySuppressionAdmission?: boolean } = {},
  ): Promise<MaturedCandidateMaterializationResult> {
    return this.dependencies.pendingRecoveryCandidate.withCheckoutLock(
      candidate.shopId,
      candidate.checkoutToken,
      async () => {
        const existing = await this.dependencies.findLatestRecovery(
          candidate.shopId,
          candidate.checkoutToken,
        );
        let generation = 1;
        const reenterSuppressionRetry = Boolean(
          options.retrySuppressionAdmission && existing?.status === "DETECTED",
        );
        let continueExistingGeneration = false;
        if (existing) {
          if (["COMPLETED", "CANCELLED"].includes(existing.status)) {
            return {
              outcome: "discarded-terminal",
              checkoutToken: candidate.checkoutToken,
              status: existing.status,
            } as const;
          }
          if (
            ["DETECTED", "MESSAGE_SENT", "ENGAGED"].includes(existing.status)
          ) {
            generation = existing.generation;
            continueExistingGeneration =
              existing.status === "DETECTED" &&
              (Boolean(this.dependencies.continueInitialOutreach) ||
                reenterSuppressionRetry);
          } else {
            generation = existing.generation + 1;
          }
        }

        const lockedExecution =
          await this.dependencies.executionEligibility.evaluate(
            candidate.shopId,
            undefined,
            "recovery",
          );
        if (!lockedExecution.allowed) {
          return {
            outcome: "discarded-shop-unavailable",
            checkoutToken: candidate.checkoutToken,
            ...(lockedExecution.reason !== "SHOP_UNAVAILABLE"
              ? { reason: lockedExecution.reason }
              : {}),
          } as const;
        }

        if (
          await this.dependencies.pendingRecoveryCandidate.hasOrderProcessed(
            candidate.shopId,
            candidate.checkoutToken,
          )
        ) {
          return {
            outcome: "discarded-order-completed",
            checkoutToken: candidate.checkoutToken,
          } as const;
        }

        const indexedJobId = options.jobId
          ? await this.dependencies.pendingRecoveryCandidate.findCandidateJobIdByCheckout(
              {
                shopId: candidate.shopId,
                checkoutToken: candidate.checkoutToken,
              },
            )
          : null;
        if (indexedJobId && indexedJobId !== options.jobId) {
          return {
            outcome: "discarded-superseded",
            checkoutToken: candidate.checkoutToken,
          } as const;
        }

        const shopDomain =
          await this.dependencies.abandonedCheckoutLookup.resolveShopDomain(
            candidate.shopId,
          );

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
          return {
            outcome: "discarded-not-found",
            checkoutToken: candidate.checkoutToken,
          } as const;
        }
        if (outcome.kind === "ambiguous") {
          return {
            outcome: "discarded-ambiguous",
            checkoutToken: candidate.checkoutToken,
          } as const;
        }
        if (outcome.kind === "bounded-limit-exceeded") {
          return {
            outcome: "discarded-bound-exceeded",
            checkoutToken: candidate.checkoutToken,
          } as const;
        }

        const checkout: NormalizedAbandonedCheckout = outcome.checkout;
        if (checkout.completedAt != null) {
          return {
            outcome: "discarded-not-recoverable",
            checkoutToken: candidate.checkoutToken,
          } as const;
        }

        const seedBase = await this.dependencies.snapshotBuilder.build(
          candidate,
          shopDomain,
          checkout,
        );
        const consentReceipt = await (
          this.dependencies.consentReceipt ??
          shopifyCheckoutConsentMaterializationService
        ).materialize({
          candidate,
          checkout,
          seed: seedBase,
        });
        const consentOutcome = mapConsentOutcome(
          candidate.checkoutToken,
          consentReceipt,
        );
        if (consentOutcome) return consentOutcome;
        if (consentReceipt.status === "MATERIALISED_REVOKED") {
          return {
            outcome: "discarded-consent-revoked",
            checkoutToken: candidate.checkoutToken,
          } as const;
        }
        if (consentReceipt.status === "MATERIALISED_GRANTED") {
          const seed = {
            ...seedBase,
            customer: {
              ...seedBase.customer,
              phone: `+${consentReceipt.recipient}`,
            },
          };
          const result = await this.continueOrInitiateExisting(
            candidate,
            existing,
            generation,
            continueExistingGeneration,
            reenterSuppressionRetry,
            seed,
            consentReceipt.recipient,
            consentReceipt.customerId,
          );
          return result;
        }

        const stored = await selectStoredShopifyCheckoutPhone({
          shopId: candidate.shopId,
          checkout,
        });
        if (!stored) {
          await this.dependencies.noticeMissingRecipient?.(
            candidate.shopId,
            candidate.checkoutToken,
            seedBase,
          );
          return {
            outcome: "deferred-no-recipient",
            checkoutToken: candidate.checkoutToken,
          } as const;
        }
        const seed = {
          ...seedBase,
          customer: { ...seedBase.customer, phone: `+${stored.recipient}` },
        };
        const result = await this.continueOrInitiateExisting(
          candidate,
          existing,
          generation,
          continueExistingGeneration,
          reenterSuppressionRetry,
          seed,
          stored.recipient,
          stored.customerId,
        );
        return result;
      },
    );
  }

  private async continueOrInitiateExisting(
    candidate: PendingRecoveryCandidate,
    existing: Awaited<
      ReturnType<RecoveryMaterializationDependencies["findLatestRecovery"]>
    >,
    generation: number,
    continueExistingGeneration: boolean,
    reenterSuppressionRetry: boolean,
    seed: RecoveryCheckoutSeed,
    recipient: string,
    customerId?: string,
  ): Promise<MaturedCandidateMaterializationResult> {
    if (
      existing &&
      this.dependencies.continueInitialOutreach &&
      ["DETECTED", "MESSAGE_SENT", "ENGAGED"].includes(existing.status)
    ) {
      const progress = await this.dependencies.continueInitialOutreach({
        shopId: candidate.shopId,
        recoveryId: existing.id,
      });
      if (progress.kind === "reconciled") {
        return {
          outcome: "recovery-reconciled",
          checkoutToken: candidate.checkoutToken,
          recoveryId: progress.recoveryId,
        };
      }
      if (progress.kind === "blocked") {
        return {
          outcome: "deferred-initial-outreach",
          checkoutToken: candidate.checkoutToken,
          recoveryId: progress.recoveryId,
          reason: progress.reason,
        };
      }
      if (progress.kind === "held") {
        throw new InitialOutreachHeldError(
          progress.recoveryId,
          progress.reason,
          progress.creditReason,
        );
      }
      if (existing.status !== "DETECTED") {
        return {
          outcome: "no-op-existing",
          checkoutToken: candidate.checkoutToken,
          status: existing.status,
        };
      }
    } else if (
      existing &&
      ["MESSAGE_SENT", "ENGAGED"].includes(existing.status)
    ) {
      return {
        outcome: "no-op-existing",
        checkoutToken: candidate.checkoutToken,
        status: existing.status,
      };
    } else if (
      existing?.status === "DETECTED" &&
      !continueExistingGeneration &&
      !reenterSuppressionRetry
    ) {
      return {
        outcome: "no-op-existing",
        checkoutToken: candidate.checkoutToken,
        status: existing.status,
      };
    }

    const initiated = await this.dependencies.initiate(
      seed,
      generation,
      recipient,
      customerId,
    );
    if (initiated === null) {
      return {
        outcome: "discarded-admission-denied",
        checkoutToken: candidate.checkoutToken,
      };
    }

    // The initiation port already has the persisted recovery. Reuse its
    // identity for diagnostics; never issue another SELECT only for logging.
    const recoveryId =
      typeof initiated === "object" &&
      initiated !== null &&
      "id" in initiated &&
      typeof initiated.id === "string"
        ? initiated.id
        : undefined;
    if (reenterSuppressionRetry || continueExistingGeneration) {
      return {
        outcome: "recovery-reentered",
        checkoutToken: seed.checkoutToken,
        ...(recoveryId ? { recoveryId } : {}),
      };
    }
    return {
      outcome: "recovery-created",
      checkoutToken: seed.checkoutToken,
      ...(recoveryId ? { recoveryId } : {}),
    };
  }
}

function mapConsentOutcome(
  checkoutToken: string,
  result: ShopifyCheckoutConsentMaterialization,
): MaturedCandidateMaterializationResult | null {
  switch (result.status) {
    case "NO_EXPLICIT_CHOICE":
    case "MATERIALISED_GRANTED":
    case "MATERIALISED_REVOKED":
      return null;
    case "INVALID_OR_AMBIGUOUS_RECEIPT":
      return { outcome: "discarded-consent-invalid", checkoutToken };
    case "DEFER_CHECKOUT_BINDING":
      return { outcome: "deferred-consent-checkout-binding", checkoutToken };
    case "DEFER_IDENTITY_OR_RECIPIENT":
      return {
        outcome: "deferred-consent-identity-or-recipient",
        checkoutToken,
      };
    case "BLOCKED_STOP":
      return { outcome: "discarded-consent-stop", checkoutToken };
    case "MATERIALISATION_FAILURE":
      throw new Error(
        `Shopify checkout consent materialisation failed: ${result.reason}`,
        {
          ...(result.cause !== undefined ? { cause: result.cause } : {}),
        },
      );
  }
}
