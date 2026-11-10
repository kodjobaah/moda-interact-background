import { normalizeCommerceProductSelections, commerceProductSelectionConflict } from '@modainteract/moda-interact-shared/commerce';
import { verifyCommerceAnswerPresentationSelection } from "@modainteract/moda-interact-shared/commerce";
import type { CommerceFinalResponse } from "@modainteract/moda-interact-shared/commerce";
import type { ModaSupportedLanguageTag } from "@modainteract/moda-interact-shared/internationalization";
import { CommerceVerifiedPresentationSchema, verifyCommerceOptionFacts, verifyCommerceProductFacts, type CommerceVerifiedPresentation } from "@modainteract/moda-interact-shared/commerce/presentation";
export type PresentationProductPair = Readonly<{ productId: string; variantId: string | null }>;
const key = (p: PresentationProductPair) => JSON.stringify([p.productId, p.variantId]);
export class PresentationVerificationError extends Error {
 readonly stage = "presentation.verify";
 constructor(readonly code: string) { super(code); this.name = "PresentationVerificationError"; }
}
/** Model output selects references; only fresh provider reads supply facts. */
export async function prepareProductFactsPresentation(input: {
 envelope: CommerceFinalResponse; authorizedPairs: readonly PresentationProductPair[];
 readProduct: (pair: PresentationProductPair) => Promise<unknown>;
 consumeBudget: () => void; assertCurrent: () => void | Promise<void>;
 brandName: string | null; locale: ModaSupportedLanguageTag; storeUrl: string;
}): Promise<CommerceVerifiedPresentation | null> {
 input={...input,envelope:{...input.envelope,details:normalizeCommerceProductSelections(input.envelope.details)}};
 const conflict=commerceProductSelectionConflict(input.envelope.details);if(conflict)throw new PresentationVerificationError(conflict);
 if (input.envelope.answerKind === "REFER_TO_STORE") return null;
 const selection = verifyCommerceAnswerPresentationSelection(Object.fromEntries(
  ["productOptionSelections", "productDetailSelections", "responseDisposition", "shippingInformationSelection"]
   .filter(name => Object.hasOwn(input.envelope.details, name)).map(name => [name, input.envelope.details[name]]),
 ));
 if (selection.kind !== "verified") throw new PresentationVerificationError("INVALID_SELECTION");
 const options = selection.selection.productOptionSelections ?? [], products = selection.selection.productDetailSelections ?? [];
 const selected = products.length ? products : options;
 if (!selected.length) return null;
 const authorized = new Set(input.authorizedPairs.map(key));
 if (selected.some(pair => !authorized.has(key(pair)))) throw new PresentationVerificationError("UNOBSERVED_SELECTION");
 const refreshed: unknown[] = [];
 for (const pair of selected) {
  await input.assertCurrent(); input.consumeBudget();
  const output = await input.readProduct(pair);
  await input.assertCurrent();
  refreshed.push(output && typeof output === "object" && "product" in output ? output.product : output);
 }
 const result = products.length ? verifyCommerceProductFacts(selected, refreshed) : verifyCommerceOptionFacts(selected, refreshed);
 if (result.kind !== "verified") throw new PresentationVerificationError(result.reason);
 const projection = CommerceVerifiedPresentationSchema.safeParse({schemaVersion: 1, brandName: input.brandName, locale: input.locale,
  disposition: products.length ? "PRODUCT_DETAILS" : "PRODUCT_OPTIONS", storeUrl: input.storeUrl,
  products: [], optionFacts: "optionFacts" in result ? result.optionFacts : [], productFacts: "productFacts" in result ? result.productFacts : [],
  requiresShipping: null, policyUrl: null, includeNoVerifiedOffer: false});
 if (!projection.success) throw new PresentationVerificationError("INVALID_PROJECTION");
 return projection.data;
}
