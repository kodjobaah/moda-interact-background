import {
  CommerceAnswerPresentationSelectionSchema,
  CommerceProductRecommendationSelectionSchema,
} from "@modainteract/moda-interact-shared/commerce";
import type { CommerceFinalResponse } from "@modainteract/moda-interact-shared/commerce";

export type RecommendationSelection = Readonly<{
  productRecommendationVersion?: "1";
  productRecommendations?: CommerceFinalResponse["details"] extends infer _ ? readonly {
    scope: "PRODUCT_ONLY" | "ADD_TO_BASKET" | "REPLACE_BASKET_LINE";
    basketLineId: string | null; productId: string; variantId: string | null; quantity: number;
    promotionKind: "NONE" | "NATIVE_SALE" | "DISCOUNT"; offerIds: readonly string[];
  }[] : never;
  responseDisposition?: "STANDARD" | "OUT_OF_SCOPE_REDIRECT" | "SHIPPING_INFORMATION_UNVERIFIED";
  shippingInformationSelection?: Readonly<{ productId: string | null; variantId: string | null }>;
}>;

export function readRecommendationSelection(details: Record<string, unknown>): RecommendationSelection | null {
  const recommendation = CommerceProductRecommendationSelectionSchema.safeParse({
    ...(Object.hasOwn(details, "productRecommendationVersion") ? { productRecommendationVersion: details.productRecommendationVersion } : {}),
    ...(Object.hasOwn(details, "productRecommendations") ? { productRecommendations: details.productRecommendations } : {}),
  });
  const presentation = CommerceAnswerPresentationSelectionSchema.safeParse({
    ...(Object.hasOwn(details, "responseDisposition") ? { responseDisposition: details.responseDisposition } : {}),
    ...(Object.hasOwn(details, "shippingInformationSelection") ? { shippingInformationSelection: details.shippingInformationSelection } : {}),
  });
  const recommendationData = recommendation.success ? recommendation.data : null;
  const hasVersion = recommendationData?.productRecommendationVersion !== undefined;
  const hasProducts = recommendationData?.productRecommendations !== undefined;
  const recommendationsValid = recommendationData !== null && hasVersion === hasProducts;
  const disposition = presentation.success
    ? presentation.data.responseDisposition
    : CommerceAnswerPresentationSelectionSchema.safeParse({ responseDisposition: details.responseDisposition }).success
      ? details.responseDisposition as RecommendationSelection["responseDisposition"] : undefined;
  const shippingSelection = presentation.success
    ? presentation.data.shippingInformationSelection
    : CommerceAnswerPresentationSelectionSchema.safeParse({
        shippingInformationSelection: details.shippingInformationSelection,
      }).success ? details.shippingInformationSelection as RecommendationSelection["shippingInformationSelection"] : undefined;
  const validShipping = shippingSelection && disposition &&
    (!shippingSelection.variantId || Boolean(shippingSelection.productId)) ? shippingSelection : undefined;
  if (!recommendationsValid && disposition === undefined && validShipping === undefined) return null;
  return Object.freeze({
    ...(recommendationsValid && recommendationData.productRecommendationVersion !== undefined ? { productRecommendationVersion: recommendationData.productRecommendationVersion } : {}),
    ...(recommendationsValid && recommendationData.productRecommendations !== undefined ? { productRecommendations: recommendationData.productRecommendations } : {}),
    ...(disposition === undefined ? {} : { responseDisposition: disposition }),
    ...(validShipping === undefined ? {} : { shippingInformationSelection: validShipping }),
  });
}
