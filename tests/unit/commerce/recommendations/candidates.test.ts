import { describe, expect, it } from "vitest";
import { buildReplyCandidates } from "../../../../src/commerce/recommendations/candidates.js";

describe("buildReplyCandidates", () => {
  it("keeps full, first-product and minimal complete candidates in order", () => {
    expect(buildReplyCandidates({ fullBody: "Full", firstProductBody: "First", minimalBody: "Store" }))
      .toEqual(["Full", "First", "Store"]);
  });
  it("omits duplicates and oversized candidates but retains the required minimal body", () => {
    expect(buildReplyCandidates({ fullBody: "x".repeat(4097), firstProductBody: null, minimalBody: "Store" }))
      .toEqual(["Store"]);
  });
});
