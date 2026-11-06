import type { CommerceDiscountConditionFacts } from "@modainteract/moda-interact-shared/commerce";
import { CommerceOfferSchema, CommerceDiscountDetailsSchema } from "@modainteract/moda-interact-shared/commerce";
import type { z } from "zod";
import { decimalToMinorUnits, isValidDecimal } from "./money.js";

export type DiscountEligibilityDecision = Readonly<{
  offerId: string; verdict: "SUPPORTED" | "NOT_APPLICABLE" | "UNVERIFIABLE";
  eligibleLineKeys: readonly string[]; reasonCodes: readonly string[];
}>;
export type DiscountCombinationDecision = Readonly<{
  verdict: "SUPPORTED" | "UNVERIFIABLE" | "INCOMPATIBLE";
  offerIds: readonly string[]; reasonCodes: readonly string[];
}>;
export type ObservedDiscount = Readonly<{
  offer: z.infer<typeof CommerceOfferSchema>;
  details: z.infer<typeof CommerceDiscountDetailsSchema>;
  eligibility: DiscountEligibilityDecision;
}>;
export type DiscountEvaluationPurchase = Readonly<{
  provider: "SHOPIFY" | "WOOCOMMERCE";
  mode: "NONE" | "FIXED" | "AI_BEST_APPLICABLE";
  authorisedDiscountIds: readonly string[];
  currency: string | null;
  lines: readonly Readonly<{
    lineKey: string; productId: string | null; variantId: string | null;
    categoryIds: readonly string[] | null; collectionIds: readonly string[] | null;
    isSaleItem: boolean | null; quantity: number | null;
  }>[];
  currentMerchandiseSubtotal: null | Readonly<{ amountDecimal: string; currency: string }>;
}>;

const combinationOnly = new Set(["COMBINATION_POLICY_NOT_REPRESENTED_IN_SHARED_FACTS"]);
const active = new Set(["ACTIVE", "ENABLED"]);
const disabled = new Set(["DISABLED", "EXPIRED", "REMOVED", "DELETED", "INACTIVE"]);
type Line = DiscountEvaluationPurchase["lines"][number];
type Offer = z.infer<typeof CommerceOfferSchema>;
type Details = z.infer<typeof CommerceDiscountDetailsSchema>;

function decision(offerId: string, verdict: DiscountEligibilityDecision["verdict"], eligibleLineKeys: readonly string[] = [], reasonCodes: readonly string[] = []): DiscountEligibilityDecision {
  return Object.freeze({ offerId, verdict, eligibleLineKeys: Object.freeze([...eligibleLineKeys]),
    reasonCodes: Object.freeze([...new Set(reasonCodes)].slice(0, 16)) });
}
function effectiveAmount(value: string | null, provider: CommerceDiscountConditionFacts["provider"]):
  | { effective: false } | { effective: true; amount: string } | { invalid: true } {
  if (value === null) return { effective: false };
  const amount = value.trim();
  if (provider === "WOOCOMMERCE" && (amount === "" || /^0(?:\.0+)?$/.test(amount))) return { effective: false };
  return isValidDecimal(amount) ? { effective: true, amount } : { invalid: true };
}
function lineMatches(line: Line, facts: CommerceDiscountConditionFacts): "match" | "miss" | "unknown" {
  const target = facts.targeting;
  const sets: Array<{ ids: readonly string[]; lineIds: readonly string[] | null }> = [];
  switch (target.kind) {
    case "ALL": return "match";
    case "UNKNOWN": return "unknown";
    case "PRODUCTS": sets.push({ ids: target.includedProductIds, lineIds: line.productId ? [line.productId] : null }); break;
    case "VARIANTS": sets.push({ ids: target.includedVariantIds, lineIds: line.variantId ? [line.variantId] : null }); break;
    case "CATEGORIES": sets.push({ ids: target.includedCategoryIds, lineIds: line.categoryIds }); break;
    case "COLLECTIONS": sets.push({ ids: target.includedCollectionIds, lineIds: line.collectionIds }); break;
    case "MIXED":
      if (target.includedProductIds.length) sets.push({ ids: target.includedProductIds, lineIds: line.productId ? [line.productId] : null });
      if (target.includedVariantIds.length) sets.push({ ids: target.includedVariantIds, lineIds: line.variantId ? [line.variantId] : null });
      if (target.includedCategoryIds.length) sets.push({ ids: target.includedCategoryIds, lineIds: line.categoryIds });
      if (target.includedCollectionIds.length) sets.push({ ids: target.includedCollectionIds, lineIds: line.collectionIds });
  }
  if (!sets.length) return "miss";
  let unknown = false;
  if (sets.some(({ ids, lineIds }) => {
    if (lineIds === null) { unknown = true; return false; }
    return ids.some((id) => lineIds.includes(id));
  })) return "match";
  return unknown ? "unknown" : "miss";
}
function lineExcluded(line: Line, facts: CommerceDiscountConditionFacts): "excluded" | "clear" | "unknown" {
  const target = facts.targeting;
  let unknown = false;
  for (const { ids, lineIds } of [
    { ids: target.excludedProductIds, lineIds: line.productId ? [line.productId] : null },
    { ids: target.excludedVariantIds, lineIds: line.variantId ? [line.variantId] : null },
    { ids: target.excludedCategoryIds, lineIds: line.categoryIds },
    { ids: target.excludedCollectionIds, lineIds: line.collectionIds },
  ]) {
    if (!ids.length) continue;
    if (lineIds === null) { unknown = true; continue; }
    if (ids.some((id) => lineIds.includes(id))) return "excluded";
  }
  return unknown ? "unknown" : "clear";
}

export function evaluatePurchaseDiscount(input: {
  purchase: DiscountEvaluationPurchase;
  offerFromOptions: Offer | null;
  details: Details | null;
  evaluatedAt: Date;
}): DiscountEligibilityDecision {
  const { purchase, offerFromOptions: option, details } = input;
  const id = option?.offerId ?? details?.offer.offerId ?? "unknown";
  if (!(input.evaluatedAt instanceof Date) || !Number.isFinite(input.evaluatedAt.getTime())) return decision(id, "UNVERIFIABLE", [], ["EVALUATION_TIME_INVALID"]);
  if (purchase.mode === "NONE") return decision(id, "NOT_APPLICABLE", [], ["POLICY_NONE"]);
  if (purchase.mode === "FIXED" && option && !purchase.authorisedDiscountIds.includes(option.offerId)) return decision(id, "NOT_APPLICABLE", [], ["OFFER_NOT_SELECTED"]);
  if (!option || !details || option.offerId !== details.offer.offerId || details.providerDiscountId === null || details.facts.provider !== purchase.provider)
    return decision(id, "UNVERIFIABLE", [], ["SOURCE_IDENTITY_OR_POLICY_UNVERIFIED"]);
  if (option.method !== details.offer.method || option.code !== details.offer.code || option.startsAt !== details.offer.startsAt || option.endsAt !== details.offer.endsAt)
    return decision(id, "UNVERIFIABLE", [], ["OFFER_METHOD_OR_CODE_MISMATCH"]);
  if (option.support === "UNSUPPORTED" || details.offer.support === "UNSUPPORTED") return decision(id, "NOT_APPLICABLE", [], ["OFFER_UNSUPPORTED"]);
  if (option.support !== "SUPPORTED" || details.offer.support !== "SUPPORTED") return decision(id, "UNVERIFIABLE", [], ["OFFER_SUPPORT_UNKNOWN"]);
  if (option.method === "CODE" && (!option.code || !option.code.trim() || /[\r\n]/.test(option.code))) return decision(id, "UNVERIFIABLE", [], ["DELIVERABLE_CODE_UNVERIFIED"]);
  const facts = details.facts;
  if (facts.unavailableAt !== null) return decision(id, "NOT_APPLICABLE", [], ["PROVIDER_UNAVAILABLE"]);
  const status = facts.providerStatus.trim().toUpperCase();
  if (disabled.has(status)) return decision(id, "NOT_APPLICABLE", [], ["PROVIDER_STATUS_DISABLED"]);
  if (!active.has(status)) return decision(id, "UNVERIFIABLE", [], ["PROVIDER_STATUS_UNKNOWN"]);
  for (const [date, edge] of [[option.startsAt, "future"], [option.endsAt, "expired"]] as const) {
    if (!date) continue;
    const at = Date.parse(date);
    if (!Number.isFinite(at)) return decision(id, "UNVERIFIABLE", [], ["PROVIDER_DATE_INVALID"]);
    if (edge === "future" && at > input.evaluatedAt.getTime()) return decision(id, "NOT_APPLICABLE", [], ["OFFER_NOT_STARTED"]);
    if (edge === "expired" && at <= input.evaluatedAt.getTime()) return decision(id, "NOT_APPLICABLE", [], ["OFFER_EXPIRED"]);
  }
  const targetingReasons = [...facts.unrepresentedConditions, ...details.offer.reasonCodes];
  if (targetingReasons.some((reason) => /TARGET|EXCLUSION|COLLECTION|CATEGORY|VARIANT|PRODUCT_ID|PAGINATION/i.test(reason)))
    return decision(id, "UNVERIFIABLE", [], ["TARGETING_INCOMPLETE"]);
  const minimum = effectiveAmount(facts.minimumSubtotal, facts.provider);
  const maximum = effectiveAmount(facts.maximumSubtotal, facts.provider);
  if ("invalid" in minimum || "invalid" in maximum) return decision(id, "UNVERIFIABLE", [], ["SUBTOTAL_AMOUNT_INVALID"]);
  const thresholds = [minimum, maximum].filter((value): value is { effective: true; amount: string } => "effective" in value && value.effective);
  if (thresholds.length) {
    const subtotal = purchase.currentMerchandiseSubtotal;
    if (!subtotal || !purchase.currency || subtotal.currency !== purchase.currency || facts.subtotalRequirementCurrency !== purchase.currency)
      return decision(id, "UNVERIFIABLE", [], ["CURRENT_SUBTOTAL_UNVERIFIED"]);
    const minor = decimalToMinorUnits(subtotal.amountDecimal, purchase.currency);
    const amounts = thresholds.map(({ amount }) => decimalToMinorUnits(amount, purchase.currency!));
    if (minor === null || amounts.some((value) => value === null)) return decision(id, "UNVERIFIABLE", [], ["SUBTOTAL_CURRENCY_PRECISION_UNVERIFIED"]);
    let cursor = 0;
    if ("effective" in minimum && minimum.effective && minor! < amounts[cursor++]!) return decision(id, "NOT_APPLICABLE", [], ["MINIMUM_SUBTOTAL_NOT_MET"]);
    if ("effective" in maximum && maximum.effective && minor! > amounts[cursor]!) return decision(id, "NOT_APPLICABLE", [], ["MAXIMUM_SUBTOTAL_EXCEEDED"]);
  }
  if (facts.minimumQuantity !== null) return decision(id, "UNVERIFIABLE", [], ["MINIMUM_QUANTITY_SCOPE_UNKNOWN"]);
  if (["UNKNOWN", "OTHER", "BUY_X_GET_Y"].includes(facts.discountKind)) return decision(id, "UNVERIFIABLE", [], ["DISCOUNT_KIND_UNSUPPORTED_OR_UNKNOWN"]);
  if (facts.usageLimit === null || facts.perCustomerLimit === null || facts.usageLimit > 0 && facts.usageCount === null ||
      facts.provider !== "WOOCOMMERCE" && facts.usageLimit === 0) return decision(id, "UNVERIFIABLE", [], ["USAGE_LIMIT_UNOBSERVED"]);
  if (facts.usageLimit > 0 && facts.usageCount !== null && facts.usageCount >= facts.usageLimit) return decision(id, "NOT_APPLICABLE", [], ["USAGE_LIMIT_EXHAUSTED"]);
  if (facts.perCustomerLimit > 0) return decision(id, "UNVERIFIABLE", [], ["PER_CUSTOMER_LIMIT_UNVERIFIED"]);
  if (facts.customerScope !== "ALL") return decision(id, "UNVERIFIABLE", [], ["CUSTOMER_SCOPE_UNVERIFIED"]);
  if (facts.excludesSaleItems === null) return decision(id, "UNVERIFIABLE", [], ["SALE_ITEM_RESTRICTION_UNOBSERVED"]);
  const target = facts.targeting;
  const needsCategories = (target.kind === "CATEGORIES" || target.kind === "MIXED") &&
    target.includedCategoryIds.length > 0 || target.excludedCategoryIds.length > 0;
  const needsCollections = (target.kind === "COLLECTIONS" || target.kind === "MIXED") &&
    target.includedCollectionIds.length > 0 || target.excludedCollectionIds.length > 0;
  if (purchase.lines.some((line) => needsCategories && line.categoryIds === null || needsCollections && line.collectionIds === null))
    return decision(id, "UNVERIFIABLE", [], ["TARGET_LINE_IDENTITY_UNKNOWN"]);
  const lineResults = purchase.lines.map((line) => ({ line, target: lineMatches(line, facts), exclusion: lineExcluded(line, facts) }));
  if (facts.completeness === "UNKNOWN" ||
      [...facts.unrepresentedConditions, ...details.offer.reasonCodes].some((reason) => !combinationOnly.has(reason)) ||
      facts.completeness === "PARTIAL" && facts.unrepresentedConditions.length === 0 && details.offer.reasonCodes.length === 0)
    return decision(id, "UNVERIFIABLE", [], ["SOURCE_FACTS_INCOMPLETE"]);
  const matched = lineResults.filter(({ target, exclusion }) => target === "match" && exclusion === "clear");
  if (facts.excludesSaleItems) {
    const nonSale = matched.filter(({ line }) => line.isSaleItem === false);
    if (!nonSale.length) return decision(id, matched.some(({ line }) => line.isSaleItem === null) ? "UNVERIFIABLE" : "NOT_APPLICABLE", [], ["SALE_ITEM_EXCLUSION"]);
    matched.splice(0, matched.length, ...nonSale);
  }
  const uncertain = lineResults.some(({ target, exclusion }) => target === "unknown" || exclusion === "unknown");
  const classes = facts.combination.discountClasses;
  const nonLine = classes !== null && classes.length > 0 && classes.every((value) => value === "ORDER" || value === "SHIPPING");
  if (matched.length === 0 && nonLine) return decision(id,
    uncertain ? "UNVERIFIABLE" : "SUPPORTED", [],
    [uncertain ? "TARGET_LINE_IDENTITY_UNKNOWN" : "SOURCE_SUPPORTED_NON_LINE_DISCOUNT"]);
  if (matched.length === 0) return decision(id, uncertain ? "UNVERIFIABLE" : "NOT_APPLICABLE", [], [uncertain ? "TARGET_LINE_IDENTITY_UNKNOWN" : "NO_MATCHING_CHECKOUT_LINES"]);
  if (uncertain) return decision(id, "UNVERIFIABLE", [], ["TARGET_LINE_IDENTITY_UNKNOWN"]);
  if (nonLine) return decision(id, "SUPPORTED", [], ["SOURCE_SUPPORTED_NON_LINE_DISCOUNT"]);
  return decision(id, "SUPPORTED", matched.map(({ line }) => line.lineKey));
}
