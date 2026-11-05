import type { CheckoutPriceReconciliation } from "../services/recovery-pricing/checkout-price-reconciliation.types.js";
import type {
  CheckoutEligibilityDecision, InitialOutreachAgentContext,
  InitialOutreachCommerceDiscountDetails, InitialOutreachCommerceOffer,
} from "./initial-outreach-offer.types.js";
import { evaluatePurchaseDiscount } from "../commerce/recommendations/eligibility.js";
import type { DiscountEvaluationPurchase } from "../commerce/recommendations/eligibility.js";

export type EvaluateCheckoutDiscountInput = Readonly<{
  context: InitialOutreachAgentContext;
  offerFromOptions: InitialOutreachCommerceOffer | null;
  details: InitialOutreachCommerceDiscountDetails | null;
  priceReconciliation: CheckoutPriceReconciliation | null;
  evaluatedAt: Date;
}>;

function reportMatchesContext(report: CheckoutPriceReconciliation | null, context: InitialOutreachAgentContext):
  report is CheckoutPriceReconciliation {
  if (!report || report.shopId !== context.shopId || report.checkoutRecoveryId !== context.checkoutRecoveryId ||
      report.outreachAttemptId !== context.outreachAttemptId || report.generation !== context.basket.generation ||
      report.basketFingerprint !== context.basket.fingerprint || report.lines.length !== context.basket.items.length) return false;
  return report.lines.every((line, index) => {
    const basket = context.basket.items[index];
    return basket !== undefined && line.lineKey === `line-${String(index + 1).padStart(4, "0")}` &&
      line.productId === basket.productId && line.variantId === basket.variantId && line.quantity === basket.quantity;
  });
}

export function evaluateCheckoutDiscount(input: EvaluateCheckoutDiscountInput): CheckoutEligibilityDecision {
  const context = input.context;
  const report = reportMatchesContext(input.priceReconciliation, context) && input.priceReconciliation.completeness === "COMPLETE"
    ? input.priceReconciliation : null;
  const purchase: DiscountEvaluationPurchase = {
    provider: context.platform,
    mode: context.mode,
    authorisedDiscountIds: context.authorisedDiscountIds,
    currency: context.basket.currency,
    lines: context.basket.items.map((line) => ({
      lineKey: line.lineKey, productId: line.productId, variantId: line.variantId,
      categoryIds: line.categoryIds, collectionIds: line.collectionIds,
      isSaleItem: line.isSaleItem, quantity: line.quantity,
    })),
    currentMerchandiseSubtotal: report?.currentMerchandiseSubtotal ?? null,
  };
  return evaluatePurchaseDiscount({ purchase,
    offerFromOptions: input.offerFromOptions, details: input.details, evaluatedAt: input.evaluatedAt });
}
