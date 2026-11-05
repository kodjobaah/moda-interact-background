import { describe, expect, it, vi } from "vitest";
import { loadRecommendationContext } from "../../../../src/commerce/recommendations/context.js";

describe("loadRecommendationContext", () => {
  it("loads one owned prompt set, policy and explicit provider context", async () => {
    const platform = { scope: "PLATFORM", shopId: null, activePromptRevisionId: "platform-rev",
      activePromptRevision: { id: "platform-rev", status: "PUBLISHED", promptText: "Platform instructions",
        prompt: { scope: "PLATFORM", shopId: null } } };
    const findMany = vi.fn(async () => [platform]);
    const db = {
      commerceAgentConfiguration: { findMany },
      shopSettings: { findUnique: vi.fn(async () => null) },
      shopRecoveryPolicyOverride: { findUnique: vi.fn(async () => null) },
    } as never;
    const result = await loadRecommendationContext({
      recovery: { id: "recovery-1", shopId: "shop-1", generation: 1, currency: "GBP", lineItems: [],
        shop: { platform: "WOOCOMMERCE", domain: "store.example/shop" } },
      turn: { contractVersion: "commerce.v1", shopId: "shop-1", checkoutRecoveryId: "recovery-1", conversationId: "c1", inboundVersion: 2 },
      grant: { id: "g1", releaseId: "rel1" }, db, environment: "TEST", signal: new AbortController().signal,
      assertCurrent: vi.fn(async () => undefined), now: () => new Date("2026-11-05T00:00:00.000Z"),
    });
    expect(result.provider).toBe("WOOCOMMERCE");
    expect(result.policy).toMatchObject({ mode: "NONE", authorisedDiscountIds: [] });
    expect(result.storeUrl).toBe("https://store.example/shop");
    expect(findMany).toHaveBeenCalledOnce();
  });
});
