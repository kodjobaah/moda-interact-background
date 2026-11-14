import type { CommerceFinalResponse } from "@modainteract/moda-interact-shared/commerce";
import type { CommerceVerifiedPresentation } from "@modainteract/moda-interact-shared/commerce/presentation";

const DISCOVERY_TOOLS = new Set(["commerce_resolve_product_categories", "commerce_search_products", "commerce_get_product"]);
export function isCatalogueDiscoveryTool(name: string): boolean {
  return DISCOVERY_TOOLS.has(name);
}

/** Attempt authority is recorded only by the host after current-turn argument,
 * grant and availability checks. Taxonomy labels and historical prose are not
 * independently verified shop inventory or shipping presentation. */
export function shouldReferAfterUngroundedDiscovery(input: {
  attempted: boolean;
  answerKind: CommerceFinalResponse["answerKind"];
  presentation: Pick<CommerceVerifiedPresentation, "products" | "productFacts" | "optionFacts">;
  shippingVerified: boolean;
}): boolean {
  return input.attempted && input.answerKind === "ANSWER" &&
    input.presentation.products.length === 0 && (input.presentation.productFacts?.length ?? 0) === 0 &&
    input.presentation.optionFacts.length === 0 && !input.shippingVerified;
}
