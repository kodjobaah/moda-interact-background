import type {
  CheckoutOfferGroupDecision,
  ObservedCheckoutOffer,
} from "./initial-outreach-offer.types.js";

const MAX_REASON_CODES = 16;
type PairVerdict = "SUPPORTED" | "UNVERIFIABLE" | "INCOMPATIBLE";

function reasons(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].slice(0, MAX_REASON_CODES));
}

function result(
  verdict: PairVerdict,
  offerIds: readonly string[],
  reasonCodes: readonly string[],
): CheckoutOfferGroupDecision {
  return Object.freeze({ verdict, offerIds: Object.freeze([...offerIds]), reasonCodes: reasons(reasonCodes) });
}

function classPermissionKey(discountClass: "ORDER" | "PRODUCT" | "SHIPPING"):
  "orderDiscounts" | "productDiscounts" | "shippingDiscounts" {
  return discountClass === "ORDER" ? "orderDiscounts"
    : discountClass === "PRODUCT" ? "productDiscounts" : "shippingDiscounts";
}

function pairShopify(a: ObservedCheckoutOffer, b: ObservedCheckoutOffer): { verdict: PairVerdict; reasonCodes: string[] } {
  const factsA = a.details.facts.combination;
  const factsB = b.details.facts.combination;
  const classesA = factsA.discountClasses;
  const classesB = factsB.discountClasses;
  if (!classesA?.length || !classesB?.length || !factsA.combinesWith || !factsB.combinesWith) {
    return { verdict: "UNVERIFIABLE", reasonCodes: ["COMBINATION_CLASSES_UNKNOWN"] };
  }
  let unknown = false;
  for (const classA of classesA) {
    const permission = factsB.combinesWith[classPermissionKey(classA)];
    if (permission === false) return { verdict: "INCOMPATIBLE", reasonCodes: ["RECIPROCAL_CLASS_PERMISSION_FALSE"] };
    if (permission === null) unknown = true;
  }
  for (const classB of classesB) {
    const permission = factsA.combinesWith[classPermissionKey(classB)];
    if (permission === false) return { verdict: "INCOMPATIBLE", reasonCodes: ["RECIPROCAL_CLASS_PERMISSION_FALSE"] };
    if (permission === null) unknown = true;
  }
  if (unknown) return { verdict: "UNVERIFIABLE", reasonCodes: ["RECIPROCAL_CLASS_PERMISSION_UNKNOWN"] };

  const productProduct = classesA.includes("PRODUCT") && classesB.includes("PRODUCT");
  if (!productProduct) return { verdict: "SUPPORTED", reasonCodes: [] };
  const lineKeysA = a.eligibility.eligibleLineKeys;
  const lineKeysB = b.eligibility.eligibleLineKeys;
  if (lineKeysA.length === 0 || lineKeysB.length === 0) {
    return { verdict: "UNVERIFIABLE", reasonCodes: ["PRODUCT_LINE_OVERLAP_UNKNOWN"] };
  }
  const overlaps = lineKeysA.some((lineKey) => lineKeysB.includes(lineKey));
  if (!overlaps) return { verdict: "SUPPORTED", reasonCodes: [] };
  if (factsA.shopifyPlus === false || factsB.shopifyPlus === false ||
      factsA.combinesWith.productDiscounts === false || factsB.combinesWith.productDiscounts === false) {
    return { verdict: "INCOMPATIBLE", reasonCodes: ["SAME_LINE_PRODUCT_COMBINATION_DISABLED"] };
  }
  if (factsA.shopifyPlus === null || factsB.shopifyPlus === null ||
      factsA.discountTags === null || factsB.discountTags === null ||
      factsA.allowedSameLineProductTags === null || factsB.allowedSameLineProductTags === null) {
    return { verdict: "UNVERIFIABLE", reasonCodes: ["SAME_LINE_PRODUCT_FACTS_UNKNOWN"] };
  }
  const aIntoB = factsA.discountTags.some((tag) => factsB.allowedSameLineProductTags!.includes(tag));
  const bIntoA = factsB.discountTags.some((tag) => factsA.allowedSameLineProductTags!.includes(tag));
  if (!aIntoB || !bIntoA) return { verdict: "INCOMPATIBLE", reasonCodes: ["SAME_LINE_PRODUCT_TAGS_NOT_RECIPROCAL"] };
  return { verdict: "SUPPORTED", reasonCodes: ["SHOPIFY_NATIVE_CHECKOUT_VALIDATION_REQUIRED"] };
}

function pairWoo(a: ObservedCheckoutOffer, b: ObservedCheckoutOffer): { verdict: PairVerdict; reasonCodes: string[] } {
  const individualA = a.details.facts.individualUse;
  const individualB = b.details.facts.individualUse;
  if (individualA === true || individualB === true) {
    return { verdict: "INCOMPATIBLE", reasonCodes: ["WOO_INDIVIDUAL_USE"] };
  }
  if (individualA === null || individualB === null) {
    return { verdict: "UNVERIFIABLE", reasonCodes: ["WOO_INDIVIDUAL_USE_UNKNOWN"] };
  }
  const unknownExtension = [...a.details.facts.unrepresentedConditions, ...b.details.facts.unrepresentedConditions]
    .some((value) => /EXTENSION|COMBINATION|COUPON_RULE/i.test(value) &&
      value !== "COMBINATION_POLICY_NOT_REPRESENTED_IN_SHARED_FACTS");
  if (unknownExtension) return { verdict: "UNVERIFIABLE", reasonCodes: ["WOO_EXTENSION_COMPATIBILITY_UNKNOWN"] };
  return { verdict: "SUPPORTED", reasonCodes: ["WOO_NATIVE_CHECKOUT_VALIDATION_REQUIRED"] };
}

function pairVerdict(a: ObservedCheckoutOffer, b: ObservedCheckoutOffer): { verdict: PairVerdict; reasonCodes: string[] } {
  if (a.details.facts.provider !== b.details.facts.provider) {
    return { verdict: "INCOMPATIBLE", reasonCodes: ["CROSS_PROVIDER_PAIR"] };
  }
  return a.details.facts.provider === "SHOPIFY" ? pairShopify(a, b) : pairWoo(a, b);
}

export function selectCompatibleCheckoutOffers(input: Readonly<{
  candidates: readonly ObservedCheckoutOffer[];
  proposedOfferIds: readonly string[];
}>): CheckoutOfferGroupDecision {
  const proposals = input.proposedOfferIds.slice(0, 3);
  const candidateById = new Map(input.candidates.map((candidate) => [candidate.offer.offerId, candidate]));
  const ordered: ObservedCheckoutOffer[] = [];
  const seenIds = new Set<string>();
  const seenProviderIds = new Set<string>();
  const seenCodes = new Set<string>();
  for (const offerId of proposals) {
    if (seenIds.has(offerId)) continue;
    seenIds.add(offerId);
    const candidate = candidateById.get(offerId);
    if (!candidate || candidate.eligibility.verdict !== "SUPPORTED" || !candidate.details.providerDiscountId) continue;
    const providerId = candidate.details.providerDiscountId;
    const code = candidate.offer.method === "CODE" ? candidate.offer.code : null;
    if (seenProviderIds.has(providerId) || code && seenCodes.has(code)) continue;
    seenProviderIds.add(providerId);
    if (code) seenCodes.add(code);
    ordered.push(candidate);
  }
  if (ordered.length === 0) return result("UNVERIFIABLE", [], ["NO_INDIVIDUALLY_SUPPORTED_CANDIDATE"]);

  let best: ObservedCheckoutOffer[] = [ordered[0]!];
  let bestReasons: string[] = [];
  for (let mask = 1; mask < (1 << ordered.length); mask += 1) {
    const subset = ordered.filter((_candidate, index) => (mask & (1 << index)) !== 0);
    if (subset.length < 2 || subset.length < best.length) continue;
    const pairResults: Array<{ verdict: PairVerdict; reasonCodes: string[] }> = [];
    for (let left = 0; left < subset.length; left += 1) {
      for (let right = left + 1; right < subset.length; right += 1) {
        pairResults.push(pairVerdict(subset[left]!, subset[right]!));
      }
    }
    if (pairResults.every((pair) => pair.verdict === "SUPPORTED")) {
      if (subset.length > best.length) {
        best = subset;
        bestReasons = pairResults.flatMap((pair) => pair.reasonCodes);
      }
    }
  }
  const verdict = best.length > 1 ? "SUPPORTED" : "SUPPORTED";
  const warnings = bestReasons.length ? bestReasons : ["SINGLETON_REQUIRES_NATIVE_CHECKOUT_VALIDATION"];
  return result(verdict, best.map((candidate) => candidate.offer.offerId), warnings);
}