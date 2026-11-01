import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { RecoveryPolicyService } from "../recovery-policy.service.js";
import { checkoutOfferFingerprint, rankVerifiedOffers, verifiedDecision } from "./recovery-offer-evidence.js";
import { candidateKind, ShopifyReadOnlyOfferAdapter, WooReadOnlyOfferAdapter } from "./recovery-offer-providers.js";
import { PrismaRecoveryOfferRepository } from "./recovery-offer-repository.js";
import { RecoveryOfferTimeout, withinOfferDeadline } from "./recovery-offer-timeout.js";
import type {
  NoOfferReason, OfferPlatform, ReadOnlyOfferRecommender,
  ReadOnlyProviderEligibility, RecoveryOfferDecision, RecoveryOfferRepository,
  RecoveryOfferReporter, ResolveRecoveryOfferInput, VerifiedRecoveryOffer,
} from "./recovery-offer.types.js";

export type { ResolveRecoveryOfferInput, RecoveryOfferDecision, RecoveryOfferPolicy,
  VerifiedRecoveryOffer, PreviouslyPromisedOffer, RecoveryOfferRepository,
  ReadOnlyProviderEligibility, ReadOnlyOfferRecommender } from "./recovery-offer.types.js";

const logger = createLogger({
  serviceName: "moda-recovery-worker", environment: resolveDeploymentEnvironmentName(),
});
const MAX_CANDIDATES = 8;
const VERIFICATION_TIMEOUT_MS = 2_000;
const AI_TIMEOUT_MS = 1_500;

/** These failures must remain distinguishable from ordinary ineligibility.
 * Downstream BullMQ can retry rather than silently delivering an offer promise. */
export class RecoveryOfferEvaluationFailure extends Error {
  constructor(public readonly reason: "PROVIDER_FAILED" | "AI_FAILED", cause: unknown) {
    super(`recovery_offer_${reason.toLowerCase()}`, { cause });
    this.name = "RecoveryOfferEvaluationFailure";
  }
}

/** Standalone, read-only module. Never selects a Meta template, reserves credits,
 * writes a basket/coupon/order, or decides whether a WhatsApp send is allowed. */
export class RecoveryOfferResolver {
  constructor(
    private readonly repository: RecoveryOfferRepository = new PrismaRecoveryOfferRepository(),
    private readonly shopify: ReadOnlyProviderEligibility = new ShopifyReadOnlyOfferAdapter(),
    private readonly woo: ReadOnlyProviderEligibility = new WooReadOnlyOfferAdapter(),
    private readonly ai: ReadOnlyOfferRecommender | null = null,
    private readonly reporting: RecoveryOfferReporter = logger,
  ) {}

  /** Resolve an effective merchant/override policy via the existing owner when
   * an orchestrator doesn't already carry the immutable outreach snapshot. */
  async resolveWithCurrentPolicy(input: Omit<ResolveRecoveryOfferInput, "policy">,
    policies: Pick<RecoveryPolicyService, "resolve"> = new RecoveryPolicyService()): Promise<RecoveryOfferDecision> {
    let policy;
    try {
      policy = await policies.resolve(input.shopId, input.now);
    } catch (error) {
      this.reportException("recovery_offer.policy.failed", input.shopId, error);
      throw error;
    }
    return this.resolve({ ...input, policy });
  }

  async resolve(input: ResolveRecoveryOfferInput): Promise<RecoveryOfferDecision> {
    const shopId = typeof input?.shopId === "string" ? input.shopId : "unknown";
    const noOffer = (reason: NoOfferReason): RecoveryOfferDecision => {
      this.reporting.warn("recovery_offer.unavailable", {
        shopId, stage: input?.stage ?? "unknown", reason,
      });
      return Object.freeze({ kind: "NO_OFFER", reason });
    };
    try {
      if (!input || typeof input.shopId !== "string" || !input.shopId.trim() ||
          typeof input.checkoutRecoveryId !== "string" || !input.checkoutRecoveryId.trim() ||
          !(input.now instanceof Date) || !Number.isFinite(input.now.getTime()) ||
          !["INITIAL", "FOLLOW_UP"].includes(input.stage) ||
          !input.policy || !["NONE", "FIXED", "AI_BEST_APPLICABLE"].includes(input.policy.recoveryOfferMode)) {
        return noOffer("INVALID_CONTEXT");
      }
      // NONE requires neither a provider read nor an LLM evaluation.
      if (input.policy.recoveryOfferMode === "NONE") return noOffer("POLICY_NONE");
      const { stage, now, checkoutRecoveryId } = input;
      const previous = input.previouslyPromisedOffer;
      if (stage === "FOLLOW_UP" && !previous) return noOffer("PREVIOUS_OFFER_UNKNOWN");
      if (stage === "FOLLOW_UP" && previous?.kind === "NO_OFFER") return noOffer("PREVIOUS_OFFER_UNAVAILABLE");
      if (input.policy.recoveryOfferMode === "AI_BEST_APPLICABLE" && stage === "INITIAL" && !this.ai) {
        return noOffer("AI_UNAVAILABLE");
      }

      const shop = await this.repository.readShop(shopId);
      if (!shop || shop.id !== shopId || shop.status !== "ACTIVE" ||
          (shop.platform !== "SHOPIFY" && shop.platform !== "WOOCOMMERCE")) return noOffer("RECOVERY_UNAVAILABLE");
      const platform: OfferPlatform = shop.platform;
      const checkout = await this.repository.readCheckout(shopId, checkoutRecoveryId);
      if (!checkout || checkout.id !== checkoutRecoveryId || checkout.shopId !== shopId ||
          !["DETECTED", "MESSAGE_SENT", "ENGAGED"].includes(checkout.status)) return noOffer("RECOVERY_UNAVAILABLE");
      if (!checkout.checkoutToken || !checkout.currency || !/^[A-Z]{3}$/.test(checkout.currency) ||
          checkout.lineItems === null || !(checkout.updatedAt instanceof Date) ||
          !(checkout.lastExternalActivityAt instanceof Date) ||
          !Number.isFinite(checkout.updatedAt.getTime()) ||
          !Number.isFinite(checkout.lastExternalActivityAt.getTime()) ||
          checkout.updatedAt > now || checkout.lastExternalActivityAt > now) return noOffer("STALE_CHECKOUT");
      const fingerprint = checkoutOfferFingerprint(checkout);

      const catalogue = await this.repository.readCatalogue(shopId);
      if (!catalogue || catalogue.shopId !== shopId || catalogue.status !== "CURRENT" ||
          !catalogue.lastSuccessfulSyncAt || catalogue.lastSuccessfulSyncAt > now ||
          catalogue.unavailableAt !== null) return noOffer("CATALOGUE_UNAVAILABLE");
      const fixed = input.policy.recoveryOfferMode === "FIXED";
      const ids = fixed ? authorisedIds(input.policy) : null;
      if (fixed && (!ids || !ids.length)) return noOffer("NO_AUTHORISED_DISCOUNTS");
      if (ids !== null && ids.length > MAX_CANDIDATES) return noOffer("CANDIDATE_LIMIT");
      const candidates = await this.repository.readDiscounts(shopId, ids, MAX_CANDIDATES + 1);
      if (candidates.length > MAX_CANDIDATES) return noOffer("CANDIDATE_LIMIT");
      if (fixed && candidates.length !== ids!.length) return noOffer("CANDIDATE_UNAVAILABLE");
      if (!candidates.length) return noOffer("NO_ELIGIBLE_DISCOUNTS");

      const verified: VerifiedRecoveryOffer[] = [];
      const seen = new Set<string>();
      let unavailable = false;
      for (const candidate of candidates) {
        if (candidate.shopId !== shopId || seen.has(candidate.id)) return noOffer("CANDIDATE_UNAVAILABLE");
        seen.add(candidate.id);
        const kind = candidateKind(platform, candidate, now);
        if (!kind) {
          if (fixed) return noOffer("CANDIDATE_UNAVAILABLE");
          continue;
        }
        // Sequence 2 is strictly tied to the actual previous offer; a changed
        // policy/catalogue must never advertise a conflicting replacement.
        if (stage === "FOLLOW_UP" && previous && previous.kind !== "NO_OFFER" &&
            (candidate.shopifyDiscountNodeId !== previous.providerDiscountId ||
             kind !== previous.kind || (kind === "CODE_OFFER" &&
             previous.code !== candidate.singleRedeemCode))) continue;
        const reader = platform === "SHOPIFY" ? this.shopify : this.woo;
        let result;
        try {
          result = await withinOfferDeadline((signal) => reader.evaluate({
            shopId, checkout, checkoutFingerprint: fingerprint,
            discount: candidate, now, signal,
          }), VERIFICATION_TIMEOUT_MS);
        } catch (error) {
          if (error instanceof RecoveryOfferTimeout) {
            this.reporting.warn("recovery_offer.provider.timeout", { shopId, platform, stage });
            return noOffer("PROVIDER_VERIFICATION_UNAVAILABLE");
          }
          this.reportException("recovery_offer.provider.failed", shopId, error, platform);
          throw new RecoveryOfferEvaluationFailure("PROVIDER_FAILED", error);
        }
        if (result.outcome === "unavailable") { unavailable = true; continue; }
        if (result.outcome !== "eligible") continue;
        const selected = verifiedDecision({
          platform, shopId, checkout, discount: candidate,
          kind, evidence: result.evidence, now, fingerprint,
        });
        if (selected) verified.push(selected);
      }
      if (unavailable) {
        // Partial eligibility cannot establish the highest-saving FIXED choice.
        this.reporting.warn("recovery_offer.capability_gap", {
          shopId, platform, reason: "CHECKOUT_RULE_READER_UNAVAILABLE",
        });
        return noOffer("PROVIDER_VERIFICATION_UNAVAILABLE");
      }
      if (!verified.length) return noOffer(stage === "FOLLOW_UP" ?
        "PREVIOUS_OFFER_UNAVAILABLE" : "NO_ELIGIBLE_DISCOUNTS");
      const ranked = rankVerifiedOffers(verified);
      if (stage === "FOLLOW_UP") return ranked[0]!;
      if (fixed) return ranked[0]!;
      // AI may rank only independently verified choices. No fabricated values,
      // cart modification, or artificial conversation turns are permitted.
      if (!this.ai) return noOffer("AI_UNAVAILABLE");
      let recommendedId: string | null;
      try {
        recommendedId = await withinOfferDeadline((signal) => this.ai!.recommend({
          shopId, checkoutRecoveryId, currency: checkout.currency!,
          choices: Object.freeze(ranked.map((offer) => Object.freeze({
            catalogueDiscountId: offer.catalogueDiscountId,
            savingsMinor: offer.evidence.savingsMinor, kind: offer.kind,
          }))), maxOutputTokens: 32, signal,
        }), AI_TIMEOUT_MS);
      } catch (error) {
        if (error instanceof RecoveryOfferTimeout) {
          this.reporting.warn("recovery_offer.ai.timeout", { shopId, stage });
          return noOffer("AI_UNAVAILABLE");
        }
        this.reportException("recovery_offer.ai.failed", shopId, error);
        throw new RecoveryOfferEvaluationFailure("AI_FAILED", error);
      }
      return ranked.find((offer) => offer.catalogueDiscountId === recommendedId) ?? noOffer("AI_INCONCLUSIVE");
    } catch (error) {
      // Do not silently convert DB faults, coding errors, or untrusted adapter
      // failures into a normal verified business outcome. Shared logger only.
      if (!(error instanceof RecoveryOfferEvaluationFailure)) {
        this.reportException("recovery_offer.resolve.failed", shopId, error);
      }
      throw error;
    }
  }

  private reportException(event: string, shopId: string, error: unknown, platform?: string): void {
    this.reporting.error(event, {
      shopId, ...(platform ? { platform } : {}),
      errorType: error instanceof Error ? error.name : "unknown",
    });
  }
}

/** Trust only exact internal discount row IDs already supplied by the effective
 * merchant policy. A Woo 'anchor' ID never supplies a redeem code. */
function authorisedIds(policy: ResolveRecoveryOfferInput["policy"]): string[] {
  const values = policy.authorisedDiscountIds ??
    (policy.fixedShopifyDiscountId ? [policy.fixedShopifyDiscountId] : []);
  const unique = [...new Set(values)];
  if (unique.some((value) => typeof value !== "string" || !value.trim() || value.length > 128)) return [];
  return unique.sort();
}

export const recoveryOfferResolver = new RecoveryOfferResolver();

/** Background-local function seam for the thin outbound integration tasks. */
export function resolveRecoveryOffer(input: ResolveRecoveryOfferInput): Promise<RecoveryOfferDecision> {
  return recoveryOfferResolver.resolve(input);
}
