import { readCommerceRecommendationSelection } from "@modainteract/moda-interact-shared/commerce";

export { readCommerceRecommendationSelection as readRecommendationSelection };
export type RecommendationSelection = NonNullable<ReturnType<typeof readCommerceRecommendationSelection>>;
