import {
  CommerceToolOutputs,
  InitialOutreachCheckoutOfferSetSchema,
} from "@modainteract/moda-interact-shared/commerce";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type {
  InitialOutreachAgentContext,
  InitialOutreachAgentResult,
  InitialOutreachCommerceDiscountDetails,
  InitialOutreachCommerceOffer,
  InitialOutreachCommerceProduct,
  ObservedCheckoutOffer,
} from "../../agents/initial-outreach-offer.types.js";
import { evaluateCheckoutDiscount } from "../../agents/initial-outreach-offer.eligibility.js";
import { selectCompatibleCheckoutOffers } from "../../agents/initial-outreach-offer.combinations.js";
import { productTargetMatches } from "../../agents/initial-outreach-offer-product-target.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import type { InitialOutreachAgentContextService } from "./initial-outreach-agent-context.service.js";
import { RecoveryOutreachMcpSelectorService } from "./recovery-outreach-mcp-selector.service.js";
import type { DiscountSourceFence, DiscountSourceFenceResult } from "./current-discount-source-fence.js";
import { readCurrentDiscountSourceFence } from "./current-discount-source-fence.js";
import type { CheckoutPriceReconciliation } from "../recovery-pricing/checkout-price-reconciliation.types.js";

const MCP_READ_BUDGET_MS = 15_000;
const logger = createLogger({
  serviceName: "moda-recovery-worker", environment: resolveDeploymentEnvironmentName(),
});

type ContextBuilder = Pick<InitialOutreachAgentContextService, "build">;
type Selector = Pick<RecoveryOutreachMcpSelectorService, "connect" | "tools" | "call" | "close">;

export type CurrentOutreachOfferAdmissionToken = Readonly<{
  shopId: string;
  checkoutRecoveryId: string;
  outreachAttemptId: string;
  generation: number;
  fingerprint: string;
  mode: InitialOutreachAgentContext["mode"];
  authorisedDiscountIds: readonly string[];
  priceReconciliation: CheckoutPriceReconciliation | null;
  sourceFence: DiscountSourceFence | null;
}>;

export type CurrentOutreachOfferDecision =
  | Readonly<{ kind: "VALIDATED"; result: Exclude<InitialOutreachAgentResult,
      { kind: "FAILURE" | "NO_VERIFIED_OFFER" }>; context: InitialOutreachAgentContext;
      admissionToken: CurrentOutreachOfferAdmissionToken }>
  | Readonly<{ kind: "NO_VERIFIED_OFFER"; result: Extract<InitialOutreachAgentResult,
      { kind: "NO_VERIFIED_OFFER" }>; context: InitialOutreachAgentContext;
      admissionToken: CurrentOutreachOfferAdmissionToken }>
  | Readonly<{ kind: "FAILURE"; reasonCode: string; retryable: boolean }>;

export type CurrentOutreachOfferRevalidationDependencies = Readonly<{
  contextBuilder: ContextBuilder;
  createSelector?: (input: { shopId: string; signal: AbortSignal }) => Selector;
  readFence?: (input: {
    shopId: string; checkoutRecoveryId: string; selectedOfferIds: readonly string[]; signal: AbortSignal;
  }) => Promise<DiscountSourceFenceResult>;
  clock?: () => Date;
  logger?: Pick<StructuredLogger, "warn" | "error">;
}>;

function fenceMatches(left: DiscountSourceFence, right: DiscountSourceFence): boolean {
  return left.shopId === right.shopId && left.platform === right.platform &&
    left.syncGeneration === right.syncGeneration &&
    JSON.stringify(left.selectedOfferIds) === JSON.stringify(right.selectedOfferIds) &&
    left.snapshotDigest === right.snapshotDigest;
}

function samePrice(left: CheckoutPriceReconciliation | null, right: CheckoutPriceReconciliation | null): boolean {
  if (left === null || right === null) return left === right;
  const { evaluatedAt: _leftAt, ...leftFacts } = left;
  const { evaluatedAt: _rightAt, ...rightFacts } = right;
  return JSON.stringify(leftFacts) === JSON.stringify(rightFacts);
}

function tokenFor(
  context: InitialOutreachAgentContext,
  sourceFence: DiscountSourceFence | null,
): CurrentOutreachOfferAdmissionToken {
  return Object.freeze({
    shopId: context.shopId,
    checkoutRecoveryId: context.checkoutRecoveryId,
    outreachAttemptId: context.outreachAttemptId,
    generation: context.basket.generation,
    fingerprint: context.basket.fingerprint,
    mode: context.mode,
    authorisedDiscountIds: Object.freeze([...context.authorisedDiscountIds]),
    priceReconciliation: context.priceReconciliation,
    sourceFence,
  });
}

function noOffer(
  context: InitialOutreachAgentContext,
  reason: string,
  discoveryIncomplete: boolean,
  sourceFence: DiscountSourceFence | null,
): CurrentOutreachOfferDecision {
  return {
    kind: "NO_VERIFIED_OFFER",
    result: { kind: "NO_VERIFIED_OFFER", reason, discoveryIncomplete },
    context,
    admissionToken: tokenFor(context, sourceFence),
  };
}

function candidateFromDetails(
  context: InitialOutreachAgentContext,
  details: InitialOutreachCommerceDiscountDetails,
  clock: () => Date,
): ObservedCheckoutOffer {
  const offer = details.offer as InitialOutreachCommerceOffer;
  return {
    offer,
    details,
    eligibility: evaluateCheckoutDiscount({
      context,
      offerFromOptions: offer,
      details,
      priceReconciliation: context.priceReconciliation,
      evaluatedAt: clock(),
    }),
  };
}

function makeCheckoutResult(
  context: InitialOutreachAgentContext,
  proposed: Extract<InitialOutreachAgentResult, { kind: "CHECKOUT_DISCOUNT" }>,
  candidates: readonly ObservedCheckoutOffer[],
  discoveryIncomplete: boolean,
): Extract<InitialOutreachAgentResult, { kind: "CHECKOUT_DISCOUNT" }> | null {
  const group = selectCompatibleCheckoutOffers({
    candidates,
    proposedOfferIds: proposed.offerSet.offers.map((offer) => offer.offerId),
  });
  if (group.verdict !== "SUPPORTED" || group.offerIds.length < 1) return null;
  const byId = new Map(candidates.map((candidate) => [candidate.offer.offerId, candidate]));
  const offers = group.offerIds.map((offerId) => {
    const candidate = byId.get(offerId);
    if (!candidate || candidate.eligibility.verdict !== "SUPPORTED" ||
        candidate.details.providerDiscountId === null) return null;
    return {
      offerId,
      providerDiscountId: candidate.details.providerDiscountId,
      method: candidate.offer.method,
      code: candidate.offer.method === "CODE" ? candidate.offer.code : null,
    };
  });
  if (offers.some((offer) => offer === null)) return null;
  const offerSet = InitialOutreachCheckoutOfferSetSchema.safeParse({
    schemaVersion: "moda.outreach.checkout-offers.v1", offers,
  });
  if (!offerSet.success) return null;
  const members = group.offerIds.map((offerId) => {
    const candidate = byId.get(offerId)!;
    return {
      offerId,
      providerDiscountId: candidate.details.providerDiscountId!,
      method: candidate.offer.method,
      code: candidate.offer.method === "CODE" ? candidate.offer.code : null,
      description: candidate.offer.title,
      eligibility: candidate.eligibility,
    };
  });
  return {
    kind: "CHECKOUT_DISCOUNT", offerSet: offerSet.data, members, group,
    shopId: context.shopId, checkoutRecoveryId: context.checkoutRecoveryId,
    outreachAttemptId: context.outreachAttemptId, generation: context.basket.generation,
    fingerprint: context.basket.fingerprint, priceReconciliation: context.priceReconciliation,
    discoveryIncomplete,
  };
}

function expectedSourceIds(proposed: InitialOutreachAgentResult): readonly string[] | null {
  if (proposed.kind === "CHECKOUT_DISCOUNT") return proposed.offerSet.offers.map((offer) => offer.offerId);
  if (proposed.kind === "ALTERNATIVE_PRODUCT_PROMOTION") return [proposed.offerId];
  return [];
}

export class CurrentOutreachOfferRevalidationService {
  private readonly createSelector: NonNullable<CurrentOutreachOfferRevalidationDependencies["createSelector"]>;
  private readonly readFence: NonNullable<CurrentOutreachOfferRevalidationDependencies["readFence"]>;
  private readonly clock: () => Date;
  private readonly log: Pick<StructuredLogger, "warn" | "error">;

  constructor(private readonly dependencies: CurrentOutreachOfferRevalidationDependencies) {
    this.createSelector = dependencies.createSelector ?? ((input) => new RecoveryOutreachMcpSelectorService(input));
    this.readFence = dependencies.readFence ?? readCurrentDiscountSourceFence;
    this.clock = dependencies.clock ?? (() => new Date());
    this.log = dependencies.logger ?? logger;
  }

  async revalidateCurrentOutreachOffer(input: Readonly<{
    shopId: string;
    checkoutRecoveryId: string;
    outreachAttemptId: string;
    proposed: InitialOutreachAgentResult;
    signal: AbortSignal;
  }>): Promise<CurrentOutreachOfferDecision> {
    const initial = await this.dependencies.contextBuilder.build(input);
    if (initial.shopId !== input.shopId || initial.checkoutRecoveryId !== input.checkoutRecoveryId ||
        initial.outreachAttemptId !== input.outreachAttemptId) {
      return { kind: "FAILURE", reasonCode: "CURRENT_CONTEXT_IDENTITY_MISMATCH", retryable: false };
    }
    if (input.proposed.kind === "FAILURE") {
      return { kind: "FAILURE", reasonCode: input.proposed.reasonCode, retryable: input.proposed.retryable };
    }
    const ids = expectedSourceIds(input.proposed);
    if (input.proposed.kind === "NO_VERIFIED_OFFER" || initial.mode === "NONE") {
      if (initial.mode !== "NONE" && input.proposed.kind === "NO_VERIFIED_OFFER" &&
          input.proposed.discoveryIncomplete) {
        return { kind: "FAILURE", reasonCode: "OFFER_DISCOVERY_INCOMPLETE", retryable: true };
      }
      return noOffer(initial, input.proposed.kind === "NO_VERIFIED_OFFER" ? input.proposed.reason : "POLICY_NONE",
        false, null);
    }
    if (!ids || ids.length < 1 || ids.length > 3 || new Set(ids).size !== ids.length ||
        initial.mode === "FIXED" && ids.some((id) => !initial.authorisedDiscountIds.includes(id)) ||
        input.proposed.shopId !== input.shopId || input.proposed.checkoutRecoveryId !== input.checkoutRecoveryId ||
        input.proposed.outreachAttemptId !== input.outreachAttemptId ||
        input.proposed.generation !== initial.basket.generation ||
        input.proposed.fingerprint !== initial.basket.fingerprint) {
      return { kind: "FAILURE", reasonCode: "PROPOSED_OFFER_STALE_OR_UNAUTHORISED", retryable: false };
    }

    const first = await this.readFence({ ...input, selectedOfferIds: ids });
    if (first.kind !== "AVAILABLE") {
      this.log.warn("recovery_offer.current_source.fence_unavailable", {
        shopId: input.shopId, recoveryId: input.checkoutRecoveryId,
        attemptId: input.outreachAttemptId, stage: "F1", reasonCode: first.reasonCode,
      });
      return { kind: "FAILURE", reasonCode: `SOURCE_FENCE_F1_${first.reasonCode}`, retryable: true };
    }
    const deadline = AbortSignal.timeout(MCP_READ_BUDGET_MS);
    const signal = AbortSignal.any([input.signal, deadline]);
    const selector = this.createSelector({ shopId: input.shopId, signal });
    let primaryError: unknown;
    let closeError: unknown;
    let discoveryIncomplete = false;
    const freshCandidates: ObservedCheckoutOffer[] = [];
    let freshProduct: InitialOutreachCommerceProduct | null = null;
    try {
      await selector.connect();
      await selector.tools();
      const proposedMembers = input.proposed.kind === "CHECKOUT_DISCOUNT"
        ? new Map(input.proposed.members.map((member) => [member.offerId, member])) : null;
      for (const offerId of ids) {
        signal.throwIfAborted();
        const result = await selector.call("commerce_get_discount_details", { offerId }, signal);
        if (result.status !== "OK") {
          discoveryIncomplete = true;
          this.log.warn("recovery_offer.current_source.mcp_member_unavailable", {
            shopId: input.shopId, attemptId: input.outreachAttemptId,
            tool: "commerce_get_discount_details", reasonCode: result.code,
          });
          continue;
        }
        const parsed = CommerceToolOutputs.commerce_get_discount_details.safeParse(result.data);
        const details = parsed.success ? parsed.data.details : null;
        if (!details || details.offer.offerId !== offerId || !details.providerDiscountId) {
          discoveryIncomplete = true;
          continue;
        }
        const previous = proposedMembers?.get(offerId);
        const proposedPromotion = input.proposed.kind === "ALTERNATIVE_PRODUCT_PROMOTION"
          ? input.proposed : null;
        if (previous && (details.providerDiscountId !== previous.providerDiscountId ||
            details.offer.method !== previous.method ||
            (details.offer.method === "CODE" && details.offer.code !== previous.code))) {
          discoveryIncomplete = true;
          continue;
        }
        if (proposedPromotion && (details.providerDiscountId !== proposedPromotion.providerDiscountId ||
            details.offer.method !== proposedPromotion.method ||
            (details.offer.method === "CODE" && details.offer.code !== proposedPromotion.code))) {
          discoveryIncomplete = true;
          continue;
        }
        freshCandidates.push(candidateFromDetails(initial, details as InitialOutreachCommerceDiscountDetails, this.clock));
      }

      if (input.proposed.kind === "ALTERNATIVE_PRODUCT_PROMOTION") {
        signal.throwIfAborted();
        const result = await selector.call("commerce_get_product", {
          productId: input.proposed.productId, variantId: input.proposed.variantId,
        }, signal);
        if (result.status === "OK") {
          const parsed = CommerceToolOutputs.commerce_get_product.safeParse(result.data);
          const product = parsed.success ? parsed.data.product : null;
          if (product && product.productId === input.proposed.productId &&
              product.variantId === input.proposed.variantId) freshProduct = product as InitialOutreachCommerceProduct;
        }
        if (!freshProduct) discoveryIncomplete = true;
      }
    } catch (error) {
      primaryError = error;
      this.log.error("recovery_offer.current_source.mcp_read_failed", {
        shopId: input.shopId, recoveryId: input.checkoutRecoveryId,
        attemptId: input.outreachAttemptId, source: "authenticated_mcp", error,
      });
      throw error;
    } finally {
      try {
        await selector.close();
      } catch (error) {
        if (primaryError === undefined) closeError = error;
        else this.log.warn("recovery_offer.current_source.mcp_close_failed", {
          shopId: input.shopId, attemptId: input.outreachAttemptId, source: "authenticated_mcp", error,
        });
      }
    }
    if (closeError !== undefined) {
      this.log.error("recovery_offer.current_source.mcp_close_failed", {
        shopId: input.shopId, attemptId: input.outreachAttemptId, source: "authenticated_mcp", error: closeError,
      });
      throw closeError;
    }
    if (deadline.aborted || input.signal.aborted) {
      return { kind: "FAILURE", reasonCode: "CURRENT_SOURCE_READ_DEADLINE", retryable: true };
    }
    const second = await this.readFence({ ...input, selectedOfferIds: ids });
    if (second.kind !== "AVAILABLE" || !fenceMatches(first.fence, second.fence)) {
      this.log.warn("recovery_offer.current_source.fence_changed", {
        shopId: input.shopId, recoveryId: input.checkoutRecoveryId,
        attemptId: input.outreachAttemptId, stage: "F2",
        firstDigestPrefix: first.fence.snapshotDigest.slice(0, 12),
        secondDigestPrefix: second.kind === "AVAILABLE" ? second.fence.snapshotDigest.slice(0, 12) : null,
        reasonCode: second.kind === "AVAILABLE" ? "SOURCE_CHANGED" : second.reasonCode,
      });
      return { kind: "FAILURE", reasonCode: "SOURCE_FENCE_F2_CHANGED", retryable: true };
    }
    const context = await this.dependencies.contextBuilder.build(input);
    if (context.mode !== initial.mode ||
        JSON.stringify(context.authorisedDiscountIds) !== JSON.stringify(initial.authorisedDiscountIds) ||
        context.basket.generation !== initial.basket.generation ||
        context.basket.fingerprint !== initial.basket.fingerprint ||
        !samePrice(context.priceReconciliation, initial.priceReconciliation)) {
      return { kind: "FAILURE", reasonCode: "CURRENT_CONTEXT_CHANGED_DURING_SOURCE_READ", retryable: true };
    }
    const admissionToken = tokenFor(context, second.fence);
    if (input.proposed.kind === "CHECKOUT_DISCOUNT") {
      const result = makeCheckoutResult(context, input.proposed, freshCandidates, discoveryIncomplete);
      if (!result) return noOffer(context, "NO_CURRENT_COMPATIBLE_OFFER", discoveryIncomplete, second.fence);
      return { kind: "VALIDATED", result, context, admissionToken };
    }
    if (input.proposed.kind !== "ALTERNATIVE_PRODUCT_PROMOTION") {
      return { kind: "FAILURE", reasonCode: "PROPOSED_OUTCOME_INVALID", retryable: false };
    }
    const alternative = input.proposed as Extract<InitialOutreachAgentResult,
      { kind: "ALTERNATIVE_PRODUCT_PROMOTION" }>;

    const candidate = freshCandidates.find((entry) => entry.offer.offerId === alternative.offerId);
    if (!candidate || !freshProduct ||
        !productTargetMatches(candidate, freshProduct, this.clock())) {
      return noOffer(context, "ALTERNATIVE_PRODUCT_NO_LONGER_VERIFIABLE", true, second.fence);
    }
    const validated = {
      kind: "ALTERNATIVE_PRODUCT_PROMOTION" as const,
      offerId: candidate.offer.offerId,
      providerDiscountId: candidate.details.providerDiscountId!,
      method: candidate.offer.method,
      code: candidate.offer.method === "CODE" ? candidate.offer.code : null,
      description: candidate.offer.title,
      productId: freshProduct.productId,
      variantId: freshProduct.variantId,
      product: { sourceTool: "commerce_get_product" as const, authenticatedShopId: input.shopId,
        shopId: input.shopId, product: freshProduct },
      shopId: input.shopId, checkoutRecoveryId: input.checkoutRecoveryId,
      outreachAttemptId: input.outreachAttemptId, generation: context.basket.generation,
      fingerprint: context.basket.fingerprint, discoveryIncomplete: false,
    } satisfies Extract<InitialOutreachAgentResult, { kind: "ALTERNATIVE_PRODUCT_PROMOTION" }>;
    return { kind: "VALIDATED", result: validated, context, admissionToken };
  }

  async validateAdmission(
    token: CurrentOutreachOfferAdmissionToken,
    signal: AbortSignal,
  ): Promise<boolean> {
    const context = await this.dependencies.contextBuilder.build({
      shopId: token.shopId, checkoutRecoveryId: token.checkoutRecoveryId,
      outreachAttemptId: token.outreachAttemptId, signal,
    });
    if (context.shopId !== token.shopId || context.checkoutRecoveryId !== token.checkoutRecoveryId ||
        context.outreachAttemptId !== token.outreachAttemptId || context.basket.generation !== token.generation ||
        context.basket.fingerprint !== token.fingerprint || context.mode !== token.mode ||
        JSON.stringify(context.authorisedDiscountIds) !== JSON.stringify(token.authorisedDiscountIds) ||
        !samePrice(context.priceReconciliation, token.priceReconciliation)) {
      this.log.warn("recovery_offer.current_source.admission_changed", {
        shopId: token.shopId, recoveryId: token.checkoutRecoveryId,
        attemptId: token.outreachAttemptId, stage: "F3", reasonCode: "CONTEXT_CHANGED",
        digestPrefix: token.sourceFence?.snapshotDigest.slice(0, 12) ?? null,
      });
      return false;
    }
    if (!token.sourceFence) return true;
    const current = await this.readFence({
      shopId: token.shopId, checkoutRecoveryId: token.checkoutRecoveryId,
      selectedOfferIds: token.sourceFence.selectedOfferIds, signal,
    });
    const matches = current.kind === "AVAILABLE" && fenceMatches(token.sourceFence, current.fence);
    if (!matches) {
      this.log.warn("recovery_offer.current_source.admission_changed", {
        shopId: token.shopId, recoveryId: token.checkoutRecoveryId,
        attemptId: token.outreachAttemptId, stage: "F3",
        reasonCode: current.kind === "AVAILABLE" ? "SOURCE_CHANGED" : current.reasonCode,
        digestPrefix: token.sourceFence.snapshotDigest.slice(0, 12),
        currentDigestPrefix: current.kind === "AVAILABLE" ? current.fence.snapshotDigest.slice(0, 12) : null,
      });
    }
    return matches;
  }
}