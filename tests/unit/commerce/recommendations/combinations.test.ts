import { describe, expect, it } from "vitest";
import { selectCompatibleOffers } from "../../../../src/commerce/recommendations/combinations.js";

describe("selectCompatibleOffers", () => {
  it("does not manufacture an offer group without individually supported candidates", () => {
    expect(selectCompatibleOffers({ candidates: [], proposedOfferIds: ["unknown"] }))
      .toMatchObject({ verdict: "UNVERIFIABLE", offerIds: [], reasonCodes: ["NO_INDIVIDUALLY_SUPPORTED_CANDIDATE"] });
  });
});
