import { InitialOutreachEvaluationResultSchema, type InitialOutreachRenderInput } from "@modainteract/moda-interact-shared/commerce/outreach";
/** Synthetic fixed test evidence only; production must run the evaluator. */
export function readyEvaluation(shopId = "shop-1", runId = "attempt-1", rawLines: unknown = [{ title: "Saved item", quantity: 1 }]): InitialOutreachRenderInput["evaluation"] {
 const lines = Array.isArray(rawLines) && rawLines.length ? rawLines : [{ title: "Saved item", quantity: 1 }];
 const result = InitialOutreachEvaluationResultSchema.parse({ kind: "ready", schemaVersion: 1, shopId, runId, basketFingerprint: "b".repeat(64), evaluatedAt: "2026-10-25T13:30:00.000Z",
  lines: lines.map((line, i) => ({ lineKey: `line-${String(i+1).padStart(4,"0")}`, productId: `gid://shopify/Product/${i+1}`, variantId: null, quantity: typeof line.quantity === "number" && line.quantity > 0 ? line.quantity : 1,
   checkoutUnitPrice: "12.00", comparison: "EQUAL", currentProduct: { productId: `gid://shopify/Product/${i+1}`, variantId: null, title: typeof line.title === "string" && line.title.trim() ? line.title : "Saved item", url: null, available: true, unitPrice: "12.00", currency: "GBP", productType: null, vendor: null, observedAt: "2026-10-25T13:30:00.000Z" } })),
  currentMerchandiseSubtotal: { amountDecimal: "12.00", currency: "GBP" }, offerDecision: { kind: "NO_VERIFIED_OFFER", reasonCode: "POLICY_NONE", discoveryIncomplete: false }, toolActivity: [] });
 if(result.kind!=="ready")throw Error("invalid fixture");return result;
}
