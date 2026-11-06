import { describe, expect, it } from "vitest";
import { TurnRecommendationObservations, evaluateRecommendationDiscountInspection } from "../../../../src/commerce/recommendations/observations.js";

const observations = () => new TurnRecommendationObservations({ shopId: "s1", provider: "SHOPIFY",
  turn: { contractVersion: "commerce.v1", shopId: "s1", checkoutRecoveryId: "r1", conversationId: "c1", inboundVersion: 1 },
  grantId: "g1", releaseId: "rel1" });
const policy = { mode: "AI_BEST_APPLICABLE" as const, authorisedDiscountIds: [], source: "MERCHANT" };

describe("required recommendation discount inspection", () => {
  it("exempts NONE and empty FIXED without any catalogue reads", () => {
    const registry = observations();
    expect(evaluateRecommendationDiscountInspection(registry, { ...policy, mode: "NONE" })).toBe("NOT_REQUIRED");
    expect(evaluateRecommendationDiscountInspection(registry, { ...policy, mode: "FIXED" })).toBe("NOT_REQUIRED");
  });
  it("requires options then details when a permitted offer was returned", () => {
    const registry = observations();
    expect(evaluateRecommendationDiscountInspection(registry, policy)).toBe("MISSING_OPTIONS");
    registry.record({ toolName: "commerce_get_discount_options", descriptorIdentity: "options",
      arguments: { limit: 20, cursor: null }, output: { mode: "AI_BEST_APPLICABLE", truncated: false, offers: [
        { offerId: "offer-1", title: "Offer", method: "AUTOMATIC", code: null, startsAt: null, endsAt: null, support: "SUPPORTED", reasonCodes: [] },
      ] } });
    expect(evaluateRecommendationDiscountInspection(registry, policy)).toBe("MISSING_DETAILS");
    registry.record({ toolName: "commerce_get_discount_details", descriptorIdentity: "details",
      arguments: { offerId: "offer-1" }, output: { outcome: "UNAVAILABLE", reasonCode: "TEMPORARY_UNAVAILABLE" } });
    expect(evaluateRecommendationDiscountInspection(registry, policy)).toBe("SATISFIED");
  });
  it("counts a bounded canonical optional unavailability as completed inspection", () => {
    const registry = observations();
    registry.record({ toolName: "commerce_get_discount_options", descriptorIdentity: "options",
      arguments: { limit: 20, cursor: null }, output: { outcome: "UNAVAILABLE", reasonCode: "TEMPORARY_UNAVAILABLE" } });
    expect(evaluateRecommendationDiscountInspection(registry, policy)).toBe("SATISFIED");
  });
  it("accepts a normal empty options page as completed discovery", () => {
    const registry = observations();
    registry.record({ toolName: "commerce_get_discount_options", descriptorIdentity: "options",
      arguments: { limit: 20, cursor: null }, output: { mode: "AI_BEST_APPLICABLE", truncated: false, offers: [] } });
    expect(evaluateRecommendationDiscountInspection(registry, policy)).toBe("SATISFIED");
  });
  it("uses latest same-argument outcome without letting another page erase earlier IDs", () => {
    const registry = observations();
    const offer = { offerId: "offer-1", title: "Offer", method: "AUTOMATIC" as const, code: null,
      startsAt: null, endsAt: null, support: "SUPPORTED" as const, reasonCodes: [] };
    registry.record({ toolName: "commerce_get_discount_options", descriptorIdentity: "options",
      arguments: { limit: 20, cursor: null }, output: { mode: "AI_BEST_APPLICABLE", truncated: false, offers: [offer] } });
    registry.record({ toolName: "commerce_get_discount_options", descriptorIdentity: "options",
      arguments: { limit: 20, cursor: "next" }, output: { outcome: "UNAVAILABLE", reasonCode: "TEMPORARY_UNAVAILABLE" } });
    expect(evaluateRecommendationDiscountInspection(registry, policy)).toBe("MISSING_DETAILS");
    registry.record({ toolName: "commerce_get_discount_options", descriptorIdentity: "options",
      arguments: { limit: 20, cursor: null }, output: { outcome: "UNAVAILABLE", reasonCode: "TEMPORARY_UNAVAILABLE" } });
    expect(evaluateRecommendationDiscountInspection(registry, policy)).toBe("SATISFIED");
  });
});
