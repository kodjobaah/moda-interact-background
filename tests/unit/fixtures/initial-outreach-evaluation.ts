import { InitialOutreachEvaluationResultSchema, type InitialOutreachRenderInput } from "@modainteract/moda-interact-shared/commerce/outreach";
/** Synthetic fixed test evidence only; production must run the evaluator. */
export function readyEvaluation(shopId = "shop-1", runId = "attempt-1", rawLines: unknown = [{ title: "Saved item", quantity: 1 }], offer?: { kind: string; code?: string; codes?: readonly string[]; description?: string } | null): InitialOutreachRenderInput["evaluation"] {
 const lines = Array.isArray(rawLines) && rawLines.length ? rawLines : [{ title: "Saved item", quantity: 1 }];
 const result = InitialOutreachEvaluationResultSchema.parse({ kind: "ready", schemaVersion: 1, shopId, runId, basketFingerprint: "b".repeat(64), evaluatedAt: "2026-10-25T13:30:00.000Z",
  lines: lines.map((line, i) => ({ lineKey: `line-${String(i+1).padStart(4,"0")}`, productId: `gid://shopify/Product/${i+1}`, variantId: null, quantity: typeof line.quantity === "number" && line.quantity > 0 ? line.quantity : 1,
   checkoutUnitPrice: "12.00", comparison: "EQUAL", currentProduct: { selectedOptions: line.selectedOptions ?? [], productId: `gid://shopify/Product/${i+1}`, variantId: null, title: typeof line.title === "string" && line.title.trim() ? line.title : "Saved item", url: null, available: true, unitPrice: "12.00", currency: "GBP", productType: null, vendor: null, observedAt: "2026-10-25T13:30:00.000Z" } })),
  currentMerchandiseSubtotal: { amountDecimal: "12.00", currency: "GBP" }, offerDecision: offer ? (() => {
   const codes = offer.kind === "CODE_OFFER" ? [...(offer.codes ?? [offer.code ?? "SAVE10"])] : [null];
   const members = codes.map((code, i) => ({ offerId: `offer-${i+1}`, providerDiscountId: `provider-${i+1}`, method: offer.kind === "CODE_OFFER" ? "CODE" : "AUTOMATIC", code, description: offer.description ?? "Verified discount", eligibility: { offerId: `offer-${i+1}`, verdict: "SUPPORTED", eligibleLineKeys: ["line-0001"], reasonCodes: [] } }));
   return { kind: "CHECKOUT_DISCOUNT", offerSet: { schemaVersion: "moda.outreach.checkout-offers.v1", offers: members.map(({offerId,providerDiscountId,method,code})=>({offerId,providerDiscountId,method,code})) }, members, group: { verdict: "SUPPORTED", offerIds: members.map(m=>m.offerId), reasonCodes: [] }, discoveryIncomplete: false };
  })() : { kind: "NO_VERIFIED_OFFER", reasonCode: "POLICY_NONE", discoveryIncomplete: false }, toolActivity: [] });
 if(result.kind!=="ready")throw Error("invalid fixture");return result;
}
