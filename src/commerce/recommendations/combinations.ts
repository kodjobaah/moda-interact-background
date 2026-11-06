import type { DiscountCombinationDecision, ObservedDiscount } from "./eligibility.js";

const MAX_REASONS = 16;
type Verdict = DiscountCombinationDecision["verdict"];
function result(verdict: Verdict, offerIds: readonly string[], reasonCodes: readonly string[]): DiscountCombinationDecision {
  return Object.freeze({ verdict, offerIds: Object.freeze([...offerIds]), reasonCodes: Object.freeze([...new Set(reasonCodes)].slice(0, MAX_REASONS)) });
}
function permissionKey(value: "ORDER" | "PRODUCT" | "SHIPPING"): "orderDiscounts" | "productDiscounts" | "shippingDiscounts" {
  return value === "ORDER" ? "orderDiscounts" : value === "PRODUCT" ? "productDiscounts" : "shippingDiscounts";
}
function pair(a: ObservedDiscount, b: ObservedDiscount): { verdict: Verdict; reasons: string[] } {
  if (a.details.facts.provider !== b.details.facts.provider) return { verdict: "INCOMPATIBLE", reasons: ["CROSS_PROVIDER_PAIR"] };
  if (a.details.facts.provider === "WOOCOMMERCE") {
    const left = a.details.facts.individualUse;
    const right = b.details.facts.individualUse;
    if (left === true || right === true) return { verdict: "INCOMPATIBLE", reasons: ["WOO_INDIVIDUAL_USE"] };
    if (left === null || right === null) return { verdict: "UNVERIFIABLE", reasons: ["WOO_INDIVIDUAL_USE_UNKNOWN"] };
    const extension = [...a.details.facts.unrepresentedConditions, ...b.details.facts.unrepresentedConditions]
      .some((value) => /EXTENSION|COMBINATION|COUPON_RULE/i.test(value) && value !== "COMBINATION_POLICY_NOT_REPRESENTED_IN_SHARED_FACTS");
    return extension ? { verdict: "UNVERIFIABLE", reasons: ["WOO_EXTENSION_COMPATIBILITY_UNKNOWN"] }
      : { verdict: "SUPPORTED", reasons: ["WOO_NATIVE_CHECKOUT_VALIDATION_REQUIRED"] };
  }
  const fa = a.details.facts.combination;
  const fb = b.details.facts.combination;
  const ca = fa.discountClasses;
  const cb = fb.discountClasses;
  if (!ca?.length || !cb?.length || !fa.combinesWith || !fb.combinesWith)
    return { verdict: "UNVERIFIABLE", reasons: ["COMBINATION_CLASSES_UNKNOWN"] };
  let unknown = false;
  for (const cls of ca) {
    const allowed = fb.combinesWith[permissionKey(cls)];
    if (allowed === false) return { verdict: "INCOMPATIBLE", reasons: ["RECIPROCAL_CLASS_PERMISSION_FALSE"] };
    if (allowed === null) unknown = true;
  }
  for (const cls of cb) {
    const allowed = fa.combinesWith[permissionKey(cls)];
    if (allowed === false) return { verdict: "INCOMPATIBLE", reasons: ["RECIPROCAL_CLASS_PERMISSION_FALSE"] };
    if (allowed === null) unknown = true;
  }
  if (unknown) return { verdict: "UNVERIFIABLE", reasons: ["RECIPROCAL_CLASS_PERMISSION_UNKNOWN"] };
  if (!(ca.includes("PRODUCT") && cb.includes("PRODUCT"))) return { verdict: "SUPPORTED", reasons: [] };
  const left = a.eligibility.eligibleLineKeys;
  const right = b.eligibility.eligibleLineKeys;
  if (!left.length || !right.length) return { verdict: "UNVERIFIABLE", reasons: ["PRODUCT_LINE_OVERLAP_UNKNOWN"] };
  if (!left.some((key) => right.includes(key))) return { verdict: "SUPPORTED", reasons: [] };
  if (fa.shopifyPlus === false || fb.shopifyPlus === false || fa.combinesWith.productDiscounts === false || fb.combinesWith.productDiscounts === false)
    return { verdict: "INCOMPATIBLE", reasons: ["SAME_LINE_PRODUCT_COMBINATION_DISABLED"] };
  if (fa.shopifyPlus === null || fb.shopifyPlus === null || fa.discountTags === null || fb.discountTags === null ||
      fa.allowedSameLineProductTags === null || fb.allowedSameLineProductTags === null)
    return { verdict: "UNVERIFIABLE", reasons: ["SAME_LINE_PRODUCT_FACTS_UNKNOWN"] };
  const reciprocal = fa.discountTags.some((tag) => fb.allowedSameLineProductTags!.includes(tag)) &&
    fb.discountTags.some((tag) => fa.allowedSameLineProductTags!.includes(tag));
  return reciprocal ? { verdict: "SUPPORTED", reasons: ["SHOPIFY_NATIVE_CHECKOUT_VALIDATION_REQUIRED"] }
    : { verdict: "INCOMPATIBLE", reasons: ["SAME_LINE_PRODUCT_TAGS_NOT_RECIPROCAL"] };
}

export function selectCompatibleOffers(input: Readonly<{ candidates: readonly ObservedDiscount[]; proposedOfferIds: readonly string[] }>): DiscountCombinationDecision {
  const candidateById = new Map(input.candidates.map((candidate) => [candidate.offer.offerId, candidate]));
  const ordered: ObservedDiscount[] = [];
  const ids = new Set<string>();
  const providers = new Set<string>();
  const codes = new Set<string>();
  for (const id of input.proposedOfferIds.slice(0, 3)) {
    if (ids.has(id)) continue;
    ids.add(id);
    const candidate = candidateById.get(id);
    if (!candidate || candidate.eligibility.verdict !== "SUPPORTED" || !candidate.details.providerDiscountId) continue;
    const code = candidate.offer.method === "CODE" ? candidate.offer.code : null;
    if (providers.has(candidate.details.providerDiscountId) || code && codes.has(code)) continue;
    providers.add(candidate.details.providerDiscountId);
    if (code) codes.add(code);
    ordered.push(candidate);
  }
  if (!ordered.length) return result("UNVERIFIABLE", [], ["NO_INDIVIDUALLY_SUPPORTED_CANDIDATE"]);
  let best = [ordered[0]!];
  let reasons: string[] = [];
  for (let mask = 1; mask < 1 << ordered.length; mask += 1) {
    const subset = ordered.filter((_value, index) => (mask & (1 << index)) !== 0);
    if (subset.length < 2 || subset.length < best.length) continue;
    const pairs = subset.flatMap((_left, left) => subset.slice(left + 1).map((right) => pair(subset[left]!, right)));
    if (pairs.every((value) => value.verdict === "SUPPORTED") && subset.length > best.length) {
      best = subset;
      reasons = pairs.flatMap((value) => value.reasons);
    }
  }
  return result("SUPPORTED", best.map((candidate) => candidate.offer.offerId),
    reasons.length ? reasons : ["SINGLETON_REQUIRES_NATIVE_CHECKOUT_VALIDATION"]);
}
