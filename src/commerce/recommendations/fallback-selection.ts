import type { RecommendationSelection } from "./disposition.js";
import type { TurnRecommendationObservations } from "./observations.js";

export function selectFallbackRecommendation(input: {
  selection: RecommendationSelection["productRecommendations"];
  observations: TurnRecommendationObservations;
  currentProductIds?: ReadonlySet<string>;
  basketProductIds?: ReadonlySet<string>;
}): NonNullable<RecommendationSelection["productRecommendations"]>[number] | null {
  const proposals = input.selection ?? [];
  const observed = [
    ...input.observations.all("commerce_get_product"),
    ...input.observations.all("commerce_search_products"),
  ];
  const candidates = proposals.filter((proposal) => observed.some((record) => {
    const args = record.arguments;
    const output = record.output as { product?: { productId: string; variantId: string | null; available: boolean | null; url: string | null } | null;
      products?: Array<{ productId: string; variantId: string | null; available: boolean | null; url: string | null }> };
    const product = output.product?.productId === proposal.productId && output.product.variantId === proposal.variantId
      ? output.product
      : output.products?.find((item) => item.productId === proposal.productId && item.variantId === proposal.variantId);
    const matchingGet = record.toolName === "commerce_get_product" && args.productId === proposal.productId && args.variantId === proposal.variantId;
    return Boolean(product?.available === true && product.url && (matchingGet || record.toolName === "commerce_search_products"));
  }));
  const rank = (proposal: NonNullable<RecommendationSelection["productRecommendations"]>[number]) =>
    input.currentProductIds?.has(proposal.productId) ? 0 : input.basketProductIds?.has(proposal.productId) ? 1 : 2;
  return candidates.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}
