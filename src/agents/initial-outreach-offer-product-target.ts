import type {
  InitialOutreachCommerceProduct,
  ObservedCheckoutOffer,
} from "./initial-outreach-offer.types.js";

export function productTargetMatches(
  observed: ObservedCheckoutOffer,
  product: InitialOutreachCommerceProduct,
  evaluatedAt: Date,
): boolean {
  const option = observed.offer;
  const sourceOffer = observed.details.offer;
  const facts = observed.details.facts;
  if (option.offerId !== sourceOffer.offerId || option.method !== sourceOffer.method ||
      option.code !== sourceOffer.code || option.startsAt !== sourceOffer.startsAt ||
      option.endsAt !== sourceOffer.endsAt || option.support !== "SUPPORTED" ||
      sourceOffer.support !== "SUPPORTED" || facts.unavailableAt !== null ||
      !["ACTIVE", "ENABLED"].includes(facts.providerStatus.trim().toUpperCase()) ||
      !(evaluatedAt instanceof Date) || !Number.isFinite(evaluatedAt.getTime())) return false;
  const evaluatedMs = evaluatedAt.getTime();
  for (const [dateValue, boundary] of [[sourceOffer.startsAt, "future"], [sourceOffer.endsAt, "expired"]] as const) {
    if (dateValue === null) continue;
    const timestamp = Date.parse(dateValue);
    if (!Number.isFinite(timestamp) || boundary === "future" && timestamp > evaluatedMs ||
        boundary === "expired" && timestamp <= evaluatedMs) return false;
  }
  const targeting = observed.details.facts.targeting;
  const included = targeting.kind === "ALL" || [
    targeting.includedProductIds.length > 0 && targeting.includedProductIds.includes(product.productId),
    targeting.includedVariantIds.length > 0 && product.variantId !== null && targeting.includedVariantIds.includes(product.variantId),
    targeting.includedCategoryIds.length > 0 && product.categoryIds?.some((id) => targeting.includedCategoryIds.includes(id)) === true,
    targeting.includedCollectionIds.length > 0 && product.collectionIds?.some((id) => targeting.includedCollectionIds.includes(id)) === true,
  ].some(Boolean);
  if (!included) return false;
  if (targeting.excludedProductIds.includes(product.productId) ||
      product.variantId !== null && targeting.excludedVariantIds.includes(product.variantId) ||
      product.categoryIds?.some((id) => targeting.excludedCategoryIds.includes(id)) ||
      product.collectionIds?.some((id) => targeting.excludedCollectionIds.includes(id))) return false;
  if (facts.targeting.kind === "UNKNOWN" || facts.completeness !== "COMPLETE" ||
      observed.details.offer.support !== "SUPPORTED" || facts.unrepresentedConditions.length > 0 ||
      facts.minimumQuantity !== null || facts.minimumSubtotal !== null ||
      facts.maximumSubtotal !== null || facts.customerScope !== "ALL" || facts.excludesSaleItems === null ||
      facts.usageLimit === null || facts.perCustomerLimit === null ||
      facts.usageLimit > 0 && (facts.usageCount === null || facts.usageCount >= facts.usageLimit) ||
      facts.perCustomerLimit > 0) return false;
  if (facts.excludesSaleItems && product.saleEvidence?.salePrice !== null) return false;
  return true;
}