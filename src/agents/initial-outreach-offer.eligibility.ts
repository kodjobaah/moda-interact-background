import type {
  CommerceDiscountConditionFacts,
} from "@modainteract/moda-interact-shared/commerce";
import type { CheckoutPriceReconciliation } from "../services/recovery-pricing/checkout-price-reconciliation.types.js";
import type {
  CheckoutEligibilityDecision,
  InitialOutreachAgentContext,
  InitialOutreachCommerceDiscountDetails,
  InitialOutreachCommerceOffer,
} from "./initial-outreach-offer.types.js";

const COMBINATION_ONLY_REASONS = new Set([
  "COMBINATION_POLICY_NOT_REPRESENTED_IN_SHARED_FACTS",
]);
const ACTIVE_STATUSES = new Set(["ACTIVE", "ENABLED"]);
const DISABLED_STATUSES = new Set(["DISABLED", "EXPIRED", "REMOVED", "DELETED", "INACTIVE"]);
const MAX_REASON_CODES = 16;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export type EvaluateCheckoutDiscountInput = Readonly<{
  context: InitialOutreachAgentContext;
  offerFromOptions: InitialOutreachCommerceOffer | null;
  details: InitialOutreachCommerceDiscountDetails | null;
  priceReconciliation: CheckoutPriceReconciliation | null;
  evaluatedAt: Date;
}>;

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].slice(0, MAX_REASON_CODES);
}

function decision(
  offerId: string,
  verdict: CheckoutEligibilityDecision["verdict"],
  eligibleLineKeys: readonly string[] = [],
  reasonCodes: readonly string[] = [],
): CheckoutEligibilityDecision {
  return Object.freeze({ offerId, verdict, eligibleLineKeys: Object.freeze([...eligibleLineKeys]),
    reasonCodes: Object.freeze(unique(reasonCodes)) });
}

function reportMatchesContext(
  report: CheckoutPriceReconciliation | null,
  context: InitialOutreachAgentContext,
): report is CheckoutPriceReconciliation {
  if (!report || report.shopId !== context.shopId ||
      report.checkoutRecoveryId !== context.checkoutRecoveryId ||
      report.outreachAttemptId !== context.outreachAttemptId ||
      report.generation !== context.basket.generation ||
      report.basketFingerprint !== context.basket.fingerprint ||
      report.lines.length !== context.basket.items.length) return false;
  return report.lines.every((line, index) => {
    const basketLine = context.basket.items[index];
    return basketLine !== undefined && line.lineKey === `line-${String(index + 1).padStart(4, "0")}` &&
      line.productId === basketLine.productId && line.variantId === basketLine.variantId &&
      line.quantity === basketLine.quantity;
  });
}

function currencyExponent(currency: string): number | null {
  try {
    const format = new Intl.NumberFormat("en", { style: "currency", currency });
    const options = format.resolvedOptions();
    const exponent = options.maximumFractionDigits;
    return typeof exponent === "number" && Number.isInteger(exponent) && exponent >= 0 && exponent <= 4 &&
      options.minimumFractionDigits === exponent ? exponent : null;
  } catch {
    return null;
  }
}

function minorUnits(value: string, exponent: number): bigint | null {
  if (!DECIMAL.test(value)) return null;
  const [whole = "", fraction = ""] = value.split(".");
  if (fraction.length > exponent) return null;
  try {
    return BigInt(`${whole}${fraction.padEnd(exponent, "0")}`);
  } catch {
    return null;
  }
}

function effectiveAmount(value: string | null, provider: CommerceDiscountConditionFacts["provider"]):
  { effective: false } | { effective: true; amount: string } | { invalid: true } {
  if (value === null) return { effective: false };
  const normalized = value.trim();
  if (provider === "WOOCOMMERCE" && (normalized === "" || /^0(?:\.0+)?$/.test(normalized))) {
    return { effective: false };
  }
  if (!DECIMAL.test(normalized)) return { invalid: true };
  return { effective: true, amount: normalized };
}

function hasIncompleteTargeting(facts: CommerceDiscountConditionFacts, offer: InitialOutreachCommerceOffer): boolean {
  const reasons = [...facts.unrepresentedConditions, ...offer.reasonCodes];
  return reasons.some((reason) => /TARGET|EXCLUSION|COLLECTION|CATEGORY|VARIANT|PRODUCT_ID|PAGINATION/i.test(reason));
}

function lineMatches(line: InitialOutreachAgentContext["basket"]["items"][number], facts: CommerceDiscountConditionFacts):
  | { kind: "match" }
  | { kind: "miss" }
  | { kind: "unknown" } {
  const targets = facts.targeting;
  const sets: Array<{ ids: readonly string[]; lineIds: readonly string[] | null }> = [];
  switch (targets.kind) {
    case "ALL":
      return { kind: "match" };
    case "PRODUCTS":
      sets.push({ ids: targets.includedProductIds, lineIds: line.productId ? [line.productId] : null });
      break;
    case "VARIANTS":
      sets.push({ ids: targets.includedVariantIds, lineIds: line.variantId ? [line.variantId] : null });
      break;
    case "CATEGORIES":
      sets.push({ ids: targets.includedCategoryIds, lineIds: line.categoryIds });
      break;
    case "COLLECTIONS":
      sets.push({ ids: targets.includedCollectionIds, lineIds: line.collectionIds });
      break;
    case "MIXED":
      if (targets.includedProductIds.length) sets.push({ ids: targets.includedProductIds, lineIds: line.productId ? [line.productId] : null });
      if (targets.includedVariantIds.length) sets.push({ ids: targets.includedVariantIds, lineIds: line.variantId ? [line.variantId] : null });
      if (targets.includedCategoryIds.length) sets.push({ ids: targets.includedCategoryIds, lineIds: line.categoryIds });
      if (targets.includedCollectionIds.length) sets.push({ ids: targets.includedCollectionIds, lineIds: line.collectionIds });
      break;
    default:
      return { kind: "unknown" };
  }
  if (sets.length === 0) return { kind: "miss" };
  let unknown = false;
  const included = sets.some(({ ids, lineIds }) => {
    if (lineIds === null) { unknown = true; return false; }
    return ids.some((id) => lineIds.includes(id));
  });
  if (included) return { kind: "match" };
  return unknown ? { kind: "unknown" } : { kind: "miss" };
}

function lineExcluded(line: InitialOutreachAgentContext["basket"]["items"][number], facts: CommerceDiscountConditionFacts):
  | "excluded"
  | "clear"
  | "unknown" {
  const target = facts.targeting;
  const exclusions = [
    { ids: target.excludedProductIds, lineIds: line.productId ? [line.productId] : null },
    { ids: target.excludedVariantIds, lineIds: line.variantId ? [line.variantId] : null },
    { ids: target.excludedCategoryIds, lineIds: line.categoryIds },
    { ids: target.excludedCollectionIds, lineIds: line.collectionIds },
  ];
  let unknown = false;
  for (const { ids, lineIds } of exclusions) {
    if (ids.length === 0) continue;
    if (lineIds === null) { unknown = true; continue; }
    if (ids.some((id) => lineIds.includes(id))) return "excluded";
  }
  return unknown ? "unknown" : "clear";
}

function classifyCompleteness(facts: CommerceDiscountConditionFacts, offer: InitialOutreachCommerceOffer):
  | "eligible"
  | "unknown" {
  if (facts.completeness === "UNKNOWN") return "unknown";
  const reasons = [...facts.unrepresentedConditions, ...offer.reasonCodes];
  if (reasons.some((reason) => !COMBINATION_ONLY_REASONS.has(reason))) return "unknown";
  if (facts.completeness === "PARTIAL" && reasons.length === 0) return "unknown";
  return "eligible";
}

export function evaluateCheckoutDiscount(input: EvaluateCheckoutDiscountInput): CheckoutEligibilityDecision {
  const option = input.offerFromOptions;
  const details = input.details;
  const requestedId = option?.offerId ?? details?.offer.offerId ?? "unknown";
  const context = input.context;
  if (!(input.evaluatedAt instanceof Date) || !Number.isFinite(input.evaluatedAt.getTime())) {
    return decision(requestedId, "UNVERIFIABLE", [], ["EVALUATION_TIME_INVALID"]);
  }
  if (context.mode === "NONE") return decision(requestedId, "NOT_APPLICABLE", [], ["POLICY_NONE"]);
  if (context.mode === "FIXED" && option && !context.authorisedDiscountIds.includes(option.offerId)) {
    return decision(requestedId, "NOT_APPLICABLE", [], ["OFFER_NOT_SELECTED"]);
  }
  if (!option || !details || option.offerId !== details.offer.offerId ||
      details.providerDiscountId === null || details.facts.provider !== context.platform) {
    return decision(requestedId, "UNVERIFIABLE", [], ["SOURCE_IDENTITY_OR_POLICY_UNVERIFIED"]);
  }
    if (option.method !== details.offer.method || option.code !== details.offer.code ||
      option.startsAt !== details.offer.startsAt || option.endsAt !== details.offer.endsAt) {
    return decision(requestedId, "UNVERIFIABLE", [], ["OFFER_METHOD_OR_CODE_MISMATCH"]);
  }
  if (option.support === "UNSUPPORTED" || details.offer.support === "UNSUPPORTED") {
    return decision(requestedId, "NOT_APPLICABLE", [], ["OFFER_UNSUPPORTED"]);
  }
  if (option.support !== "SUPPORTED" || details.offer.support !== "SUPPORTED") {
    return decision(requestedId, "UNVERIFIABLE", [], ["OFFER_SUPPORT_UNKNOWN"]);
  }
  if (option.method === "CODE" && (!option.code || option.code.trim() === "" || /[\r\n]/.test(option.code))) {
    return decision(requestedId, "UNVERIFIABLE", [], ["DELIVERABLE_CODE_UNVERIFIED"]);
  }
  if (details.facts.unavailableAt !== null) return decision(requestedId, "NOT_APPLICABLE", [], ["PROVIDER_UNAVAILABLE"]);
  const status = details.facts.providerStatus.trim().toUpperCase();
  if (DISABLED_STATUSES.has(status)) return decision(requestedId, "NOT_APPLICABLE", [], ["PROVIDER_STATUS_DISABLED"]);
  if (!ACTIVE_STATUSES.has(status)) return decision(requestedId, "UNVERIFIABLE", [], ["PROVIDER_STATUS_UNKNOWN"]);
  const evaluatedMs = input.evaluatedAt.getTime();
  for (const [dateValue, boundary] of [[option.startsAt, "future"], [option.endsAt, "expired"]] as const) {
    if (dateValue === null) continue;
    const timestamp = Date.parse(dateValue);
    if (!Number.isFinite(timestamp)) return decision(requestedId, "UNVERIFIABLE", [], ["PROVIDER_DATE_INVALID"]);
    if (boundary === "future" && timestamp > evaluatedMs) return decision(requestedId, "NOT_APPLICABLE", [], ["OFFER_NOT_STARTED"]);
    if (boundary === "expired" && timestamp <= evaluatedMs) return decision(requestedId, "NOT_APPLICABLE", [], ["OFFER_EXPIRED"]);
  }
  if (hasIncompleteTargeting(details.facts, details.offer)) {
    return decision(requestedId, "UNVERIFIABLE", [], ["TARGETING_INCOMPLETE"]);
  }

  const facts = details.facts;
  const min = effectiveAmount(facts.minimumSubtotal, facts.provider);
  const max = effectiveAmount(facts.maximumSubtotal, facts.provider);
  if ("invalid" in min || "invalid" in max) return decision(requestedId, "UNVERIFIABLE", [], ["SUBTOTAL_AMOUNT_INVALID"]);
  const effectiveThresholds = [min, max].filter((value): value is { effective: true; amount: string } =>
    "effective" in value && value.effective);
  if (effectiveThresholds.length > 0) {
    const report = input.priceReconciliation;
    const subtotal = reportMatchesContext(report, context) && report.completeness === "COMPLETE"
      ? report.currentMerchandiseSubtotal
      : null;
    if (!subtotal || subtotal.currency !== context.basket.currency ||
        facts.subtotalRequirementCurrency !== context.basket.currency) {
      return decision(requestedId, "UNVERIFIABLE", [], ["CURRENT_SUBTOTAL_UNVERIFIED"]);
    }
    const exponent = currencyExponent(context.basket.currency);
    const subtotalMinor = exponent === null ? null : minorUnits(subtotal.amountDecimal, exponent);
    const thresholdMinors = exponent === null ? null : effectiveThresholds.map((value) => minorUnits(value.amount, exponent));
    if (subtotalMinor === null || thresholdMinors === null || thresholdMinors.some((value) => value === null)) {
      return decision(requestedId, "UNVERIFIABLE", [], ["SUBTOTAL_CURRENCY_PRECISION_UNVERIFIED"]);
    }
    let thresholdIndex = 0;
    if ("effective" in min && min.effective) {
      const minMinor = thresholdMinors[thresholdIndex++]!;
      if (subtotalMinor < minMinor) return decision(requestedId, "NOT_APPLICABLE", [], ["MINIMUM_SUBTOTAL_NOT_MET"]);
    }
    if ("effective" in max && max.effective) {
      const maxMinor = thresholdMinors[thresholdIndex]!;
      if (subtotalMinor > maxMinor) return decision(requestedId, "NOT_APPLICABLE", [], ["MAXIMUM_SUBTOTAL_EXCEEDED"]);
    }
  }
  if (facts.minimumQuantity !== null) return decision(requestedId, "UNVERIFIABLE", [], ["MINIMUM_QUANTITY_SCOPE_UNKNOWN"]);
  if (["UNKNOWN", "OTHER", "BUY_X_GET_Y"].includes(facts.discountKind)) {
    return decision(requestedId, "UNVERIFIABLE", [], ["DISCOUNT_KIND_UNSUPPORTED_OR_UNKNOWN"]);
  }
  if (facts.usageLimit === null || facts.perCustomerLimit === null ||
      facts.usageLimit > 0 && facts.usageCount === null) {
    return decision(requestedId, "UNVERIFIABLE", [], ["USAGE_LIMIT_UNOBSERVED"]);
  }
  if (facts.provider !== "WOOCOMMERCE" && facts.usageLimit === 0) {
    return decision(requestedId, "UNVERIFIABLE", [], ["USAGE_LIMIT_UNOBSERVED"]);
  }
  if (facts.usageLimit !== null && facts.usageLimit > 0 && facts.usageCount !== null && facts.usageCount >= facts.usageLimit) {
    return decision(requestedId, "NOT_APPLICABLE", [], ["USAGE_LIMIT_EXHAUSTED"]);
  }
  if (facts.perCustomerLimit !== null && facts.perCustomerLimit > 0) {
    return decision(requestedId, "UNVERIFIABLE", [], ["PER_CUSTOMER_LIMIT_UNVERIFIED"]);
  }
  if (facts.customerScope !== "ALL") return decision(requestedId, "UNVERIFIABLE", [], ["CUSTOMER_SCOPE_UNVERIFIED"]);
  if (facts.excludesSaleItems === null) return decision(requestedId, "UNVERIFIABLE", [], ["SALE_ITEM_RESTRICTION_UNOBSERVED"]);

  const lineResults = context.basket.items.map((line) => ({
    line,
    target: lineMatches(line, facts),
    exclusion: lineExcluded(line, facts),
  }));
  if (classifyCompleteness(facts, details.offer) === "unknown") {
    return decision(requestedId, "UNVERIFIABLE", [], ["SOURCE_FACTS_INCOMPLETE"]);
  }
  const matched = lineResults.filter(({ target, exclusion }) => target.kind === "match" && exclusion === "clear");
  if (facts.excludesSaleItems) {
    const nonSale = matched.filter(({ line }) => line.isSaleItem === false);
    if (nonSale.length === 0) {
      return decision(requestedId, matched.some(({ line }) => line.isSaleItem === null) ? "UNVERIFIABLE" : "NOT_APPLICABLE", [], ["SALE_ITEM_EXCLUSION"]);
    }
    matched.splice(0, matched.length, ...nonSale);
  }
  const uncertainTarget = lineResults.some(({ target, exclusion }) => target.kind === "unknown" || exclusion === "unknown");
  const classes = facts.combination.discountClasses;
  const orderOrShippingOnly = classes !== null && classes.length > 0 &&
    classes.every((value) => value === "ORDER" || value === "SHIPPING");
  if (matched.length === 0 && orderOrShippingOnly) {
    return decision(requestedId, "SUPPORTED", [], ["SOURCE_SUPPORTED_NON_LINE_DISCOUNT"]);
  }
  if (matched.length === 0) {
    return decision(requestedId, uncertainTarget ? "UNVERIFIABLE" : "NOT_APPLICABLE", [], [uncertainTarget ? "TARGET_LINE_IDENTITY_UNKNOWN" : "NO_MATCHING_CHECKOUT_LINES"]);
  }
  if (uncertainTarget) return decision(requestedId, "UNVERIFIABLE", [], ["TARGET_LINE_IDENTITY_UNKNOWN"]);
  if (orderOrShippingOnly) return decision(requestedId, "SUPPORTED", [], ["SOURCE_SUPPORTED_NON_LINE_DISCOUNT"]);
  return decision(requestedId, "SUPPORTED", matched.map(({ line }) => line.lineKey));
}