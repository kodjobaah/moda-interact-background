import { describe, expect, it } from "vitest";
import { buildReplyCandidates } from "../../../../src/commerce/recommendations/candidates.js";

export function registerRecommendationRevalidationTests() {
  describe("recommendation finalization bounds", () => {
    it("keeps complete candidates in order and omits oversized candidates", () => {
      const candidates = buildReplyCandidates({
        fullBody: "verified full answer",
        firstProductBody: "verified first product",
        minimalBody: "verified store fallback",
      });
      expect(candidates).toEqual([
        "verified full answer", "verified first product", "verified store fallback",
      ]);
      expect(buildReplyCandidates({ fullBody: "x".repeat(4097), minimalBody: "Store: https://fixture.invalid" }))
        .toEqual(["Store: https://fixture.invalid"]);
    });
  });
}
