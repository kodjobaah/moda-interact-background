import { createInternationalizationRuntime } from "@modainteract/moda-interact-shared/internationalization";
import { BRIEF_PRODUCT_COPY } from "./brief-product-list.js";
import { canonicalJson, CommerceProductSchema, type CommerceFinalResponse, type CommerceTurnIdentity, type Digest } from "@modainteract/moda-interact-shared/commerce";
import { CommerceVerifiedPresentationSchema, formatObservedMoney, verifyCommerceProductFacts, verifyCommerceOptionFacts, renderCommerceProductFacts, renderProductOptionFacts, type CommerceVerifiedPresentation } from "@modainteract/moda-interact-shared/commerce/presentation";
import type { TerminalDecisionBinding, TerminalDecisionInput, TerminalDecisionResult } from "@modainteract/moda-interact-shared/commerce/runner";
export type RecoveryIdentityMode = "PRODUCT_DETAILS" | "PRODUCT_OPTIONS";
export function recoveryIdentityMode(toolName: string): RecoveryIdentityMode | null {
  return toolName === "recovery_complete_details" ? "PRODUCT_DETAILS" : toolName === "recovery_complete_options" ? "PRODUCT_OPTIONS" : null;
}
export type RecoveryIdentityDecisionReceipt = Readonly<{ binding: TerminalDecisionBinding; mode: RecoveryIdentityMode; canonicalSha256: string }>;
export function captureRecoveryIdentityDecision(input: TerminalDecisionInput, result: TerminalDecisionResult, digest: Digest): RecoveryIdentityDecisionReceipt | null {
  const mode = recoveryIdentityMode(input.call.name);
  return mode && result.kind === "decision" ? Object.freeze({ binding: input.binding, mode, canonicalSha256: digest(canonicalJson(result.value)) }) : null;
}
/** Called only after the host has independently refreshed/verified facts. Raw
 * provider transport and ordinary model replies are never changed by this. */
export function renderRefreshedRecoveryIdentityDecision(input: {
  receipt: RecoveryIdentityDecisionReceipt; original: CommerceFinalResponse; turn: CommerceTurnIdentity;
  responseContractHash: string; presentation: CommerceVerifiedPresentation; currentProducts: readonly unknown[]; digest: Digest;
}): string {
  const { receipt } = input;
  if (canonicalJson(receipt.binding.turn) !== canonicalJson(input.turn) || receipt.binding.responseContractHash !== input.responseContractHash ||
      receipt.canonicalSha256 !== input.digest(canonicalJson(input.original)) || input.original.answerKind !== "ANSWER") throw new Error("IDENTITY_DECISION_BINDING_INVALID");
  const p = CommerceVerifiedPresentationSchema.parse(input.presentation);
  if (p.disposition !== receipt.mode) throw new Error("IDENTITY_DECISION_PRESENTATION_INVALID");
  const field = receipt.mode === "PRODUCT_DETAILS" ? "productDetailSelections" : "productOptionSelections";
  const selected = input.original.details[field];
  const facts = receipt.mode === "PRODUCT_DETAILS" ? p.productFacts : p.optionFacts;
  if (!Array.isArray(selected) || !selected.length || canonicalJson(selected.map(pair => [pair.productId, pair.variantId])) !== canonicalJson(facts.map(pair => [pair.productId, pair.variantId]))) throw new Error("IDENTITY_DECISION_PAIR_INVALID");
  if (receipt.mode === "PRODUCT_OPTIONS") {
    const proof = verifyCommerceOptionFacts(selected, input.currentProducts);
    if (proof.kind !== "verified" || canonicalJson(proof.optionFacts) !== canonicalJson(p.optionFacts)) throw new Error("IDENTITY_DECISION_FACTS_INVALID");
    return renderProductOptionFacts(p.optionFacts, p.locale);
  }
  const proof = verifyCommerceProductFacts(selected, input.currentProducts);
  if (proof.kind !== "verified" || canonicalJson(proof.productFacts) !== canonicalJson(p.productFacts)) throw new Error("IDENTITY_DECISION_FACTS_INVALID");
  const runtime = createInternationalizationRuntime({ locale: p.locale, catalogue: {} });
  return p.productFacts.map(fact => {
    const parsed = CommerceProductSchema.safeParse(input.currentProducts.find(product => product && typeof product === "object" && "productId" in product && "variantId" in product && product.productId === fact.productId && product.variantId === fact.variantId));
    if (!parsed.success) throw new Error("IDENTITY_DECISION_PRODUCT_INVALID");
    const product = parsed.data;
    const body = renderCommerceProductFacts([fact], p.locale);
    if (product.unitPrice === null || product.currency === null) return body;
    const money = formatObservedMoney(product.unitPrice, product.currency, runtime);
    if (money === null) throw new Error("IDENTITY_DECISION_PRICE_INVALID");
    return `${body}\n${BRIEF_PRODUCT_COPY[p.locale][1]}: ${money} ${product.currency}`;
  }).join("\n\n");
}
