import { describe, expect, it } from "vitest";
import { planRecommendationRefreshes } from "../../../../src/commerce/recommendations/revalidation.js";

const proposal = (productId: string, offerIds: readonly string[] = []) => ({
  proposal: {
    scope: "PRODUCT_ONLY" as const, basketLineId: null, productId, variantId: "v-1", quantity: 1,
    promotionKind: offerIds.length ? "DISCOUNT" as const : "NONE" as const, offerIds,
  },
  productCallKey: `product:${productId}`, basketCallKeys: [], offerIds,
});

describe("planRecommendationRefreshes", () => {
  it("prunes later alternatives before reducing the retained proposal", () => {
    const plan = planRecommendationRefreshes({ proposals: [proposal("p-1", ["o-1"]), proposal("p-2", ["o-2"])],
      shippingCallKey: "shipping:p-1", availableCalls: 3 });
    expect(plan.proposals.map((item) => item.proposal.productId)).toEqual(["p-1"]);
    expect(plan.proposals[0]?.offerIds).toEqual(["o-1"]);
    expect(plan.shippingCallKey).toBe("shipping:p-1");
    expect(plan.calls).toHaveLength(3);
  });

  it("removes selected offers from the end, then shipping only when needed", () => {
    const plan = planRecommendationRefreshes({ proposals: [proposal("p-1", ["o-1", "o-2", "o-3"])],
      shippingCallKey: "shipping:p-1", availableCalls: 2 });
    expect(plan.proposals[0]?.offerIds).toEqual([]);
    expect(plan.shippingCallKey).toBe("shipping:p-1");
    expect(plan.calls).toEqual(["product:p-1", "shipping:p-1"]);
  });

  it("never schedules a partial product plan when no call remains", () => {
    const plan = planRecommendationRefreshes({ proposals: [proposal("p-1")], availableCalls: 0 });
    expect(plan.proposals).toEqual([]);
    expect(plan.calls).toEqual([]);
  });
});
