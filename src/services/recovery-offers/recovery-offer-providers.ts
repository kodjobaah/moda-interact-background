import { deliverableWooCode } from "../../providers/woo-coupon-normalization.js";
import type {
  DiscountOfferCandidate, OfferKind, OfferPlatform, ProviderEligibilityResult,
  ReadOnlyProviderEligibility,
} from "./recovery-offer.types.js";

/** Catalogue eligibility is necessary, but not sufficient to verify a discount
 * for a particular checkout. No Woo anchor ID implies a chosen redeem code. */
export function candidateKind(
  platform: OfferPlatform, row: DiscountOfferCandidate, now: Date,
): OfferKind | null {
  if (!row.isAvailable || row.unavailableAt !== null || row.shopifyDiscountNodeId.length === 0 ||
      row.startsAt && row.startsAt > now || row.endsAt && row.endsAt <= now) return null;
  if (platform === "WOOCOMMERCE") {
    if (!/^woo:coupon:[1-9]\d*$/.test(row.shopifyDiscountNodeId) ||
        !row.providerType.startsWith("WooCoupon:") || row.method !== "CODE" ||
        row.providerStatus !== "ACTIVE" || !row.fixedSelectable ||
        row.codeCount !== 1 || !deliverableWooCode(row.singleRedeemCode)) return null;
    const snapshot = row.providerSnapshot;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) ||
        (snapshot as { provider?: unknown }).provider !== "WOOCOMMERCE" ||
        (snapshot as { codeDeliverable?: unknown }).codeDeliverable !== true ||
        (snapshot as { code?: unknown }).code !== row.singleRedeemCode ||
        (snapshot as { expiryUnverified?: unknown }).expiryUnverified === true ||
        (snapshot as { couponId?: unknown }).couponId !== Number(row.shopifyDiscountNodeId.slice(11))) return null;
    return "CODE_OFFER";
  }
  if (row.shopifyDiscountNodeId.startsWith("woo:") ||
      row.providerType.includes("App") ||
      row.providerStatus !== "ACTIVE" || !row.fixedSelectable) return null;
  if (row.method === "AUTOMATIC") return "AUTOMATIC_OFFER";
  return row.method === "CODE" && row.codeCount === 1 &&
    deliverableWooCode(row.singleRedeemCode) ? "CODE_OFFER" : null;
}

/** A missing approved per-checkout evaluator is an explicit capability gap.
 * The existing catalogues/readers provide coupon listings but not proven
 * checkout-specific redemption, stacking, usage or customer restrictions.
 * Commerce's current Shopify evaluator also leaves rounding semantics unknown.
 */
const noProviderEvaluator: ReadOnlyProviderEligibility = {
  async evaluate(): Promise<ProviderEligibilityResult> {
    return { outcome: "unavailable" };
  },
};

export class ShopifyReadOnlyOfferAdapter implements ReadOnlyProviderEligibility {
  constructor(private readonly checkoutEvaluator: ReadOnlyProviderEligibility = noProviderEvaluator) {}
  evaluate(input: Parameters<ReadOnlyProviderEligibility["evaluate"]>[0]): Promise<ProviderEligibilityResult> {
    return this.checkoutEvaluator.evaluate(input);
  }
}

export class WooReadOnlyOfferAdapter implements ReadOnlyProviderEligibility {
  constructor(private readonly checkoutEvaluator: ReadOnlyProviderEligibility = noProviderEvaluator) {}
  evaluate(input: Parameters<ReadOnlyProviderEligibility["evaluate"]>[0]): Promise<ProviderEligibilityResult> {
    return this.checkoutEvaluator.evaluate(input);
  }
}
