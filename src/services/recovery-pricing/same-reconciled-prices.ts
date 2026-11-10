import { isDeepStrictEqual } from "node:util";
import type { CheckoutPriceReconciliation } from "./checkout-price-reconciliation.types.js";

function priceFacts(report: CheckoutPriceReconciliation) {
  const { evaluatedAt: _evaluatedAt, lines, ...facts } = report;
  return {
    ...facts,
    lines: lines.map(({ catalogueObservedAt, ...line }) => ({
      ...line, cataloguePriceObserved: catalogueObservedAt !== null,
    })),
  };
}

/** Fresh reads have different timestamps even when every price and eligibility fact agrees. */
export function sameReconciledPrices(left: CheckoutPriceReconciliation | null, right: CheckoutPriceReconciliation | null): boolean {
  return left === null || right === null ? left === right : isDeepStrictEqual(priceFacts(left), priceFacts(right));
}
