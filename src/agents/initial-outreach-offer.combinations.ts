import type { CheckoutOfferGroupDecision, ObservedCheckoutOffer } from "./initial-outreach-offer.types.js";
import { selectCompatibleOffers } from "../commerce/recommendations/combinations.js";

export function selectCompatibleCheckoutOffers(input: Readonly<{
  candidates: readonly ObservedCheckoutOffer[];
  proposedOfferIds: readonly string[];
}>): CheckoutOfferGroupDecision {
  return selectCompatibleOffers(input);
}
