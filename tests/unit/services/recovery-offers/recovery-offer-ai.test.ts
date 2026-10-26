import { describe, expect, it, vi } from "vitest";
import { RecoveryOfferEvaluationFailure, RecoveryOfferResolver } from "../../../../src/services/recovery-offers/recovery-offer-resolver.service.js";
import { checkoutOfferFingerprint } from "../../../../src/services/recovery-offers/recovery-offer-evidence.js";
import { createFixture, discount, now, request, wooDiscount } from "./fixtures.js";

describe("ARCH-047-BACKGROUND-004 AI-only and read-only behaviour", () => {
  const aiPolicy = { recoveryOfferMode: "AI_BEST_APPLICABLE" as const,
    fixedShopifyDiscountId: null, offerSnapshot: null };

  it("passes only independently verified catalogue IDs to the bounded recommender", async () => {
    const recommender = { recommend: vi.fn(async (_input: Parameters<import("../../../../src/services/recovery-offers/recovery-offer.types.js").ReadOnlyOfferRecommender["recommend"]>[0]) => "discount-2") };
    const a = discount();
    const b = discount({ id: "discount-2", shopifyDiscountNodeId: "gid://shopify/DiscountCodeNode/2",
      singleRedeemCode: "SAVE20" });
    const fixture = createFixture({ candidates: [a, b], ai: recommender,
      savings: { "discount-1": 1000, "discount-2": 2000 } });
    expect(await fixture.resolver.resolve(request({ policy: aiPolicy }))).toMatchObject({
      kind: "CODE_OFFER", catalogueDiscountId: "discount-2", parameters: { code: "SAVE20" },
    });
    expect(recommender.recommend).toHaveBeenCalledWith(expect.objectContaining({
      choices: [
        { catalogueDiscountId: "discount-2", savingsMinor: 2000, kind: "CODE_OFFER" },
        { catalogueDiscountId: "discount-1", savingsMinor: 1000, kind: "CODE_OFFER" },
      ],
    }));
    expect(recommender.recommend.mock.calls[0]?.[0]).not.toHaveProperty("customerMessage");
  });

  it("never accepts an LLM-invented or unverified coupon", async () => {
    const fixture = createFixture({ ai: { recommend: vi.fn(async () => "NOT_IN_CATALOGUE") } });
    expect(await fixture.resolver.resolve(request({ policy: aiPolicy }))).toEqual({
      kind: "NO_OFFER", reason: "AI_INCONCLUSIVE",
    });
    const ineligible = createFixture({ ai: { recommend: vi.fn(async () => "discount-1") }, verification: "ineligible" });
    expect(await ineligible.resolver.resolve(request({ policy: aiPolicy }))).toMatchObject({
      kind: "NO_OFFER", reason: "NO_ELIGIBLE_DISCOUNTS",
    });
  });

  it("rejects model and provider timeouts without creating an offer", async () => {
    vi.useFakeTimers();
    try {
      const model = createFixture({ ai: { recommend: vi.fn(() => new Promise<string>(() => {})) } });
      const pendingModel = model.resolver.resolve(request({ policy: aiPolicy }));
      await vi.advanceTimersByTimeAsync(1501);
      expect(await pendingModel).toMatchObject({ kind: "NO_OFFER", reason: "AI_UNAVAILABLE" });
      expect(model.reporting.warn).toHaveBeenCalledWith("recovery_offer.ai.timeout", expect.anything());

      const provider = createFixture();
      vi.mocked(provider.evaluator.evaluate).mockImplementationOnce(() => new Promise(() => {}));
      const pendingProvider = provider.resolver.resolve(request());
      await vi.advanceTimersByTimeAsync(2001);
      expect(await pendingProvider).toMatchObject({
        kind: "NO_OFFER", reason: "PROVIDER_VERIFICATION_UNAVAILABLE",
      });
      expect(provider.reporting.warn).toHaveBeenCalledWith("recovery_offer.provider.timeout", expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it("never interprets Woo multi-selection as a redeemable anchor", async () => {
    const first = wooDiscount();
    const second = wooDiscount({ id: "discount-2", shopifyDiscountNodeId: "woo:coupon:10",
      singleRedeemCode: "WOO10", providerSnapshot: { provider: "WOOCOMMERCE", couponId: 10,
        code: "WOO10", codeDeliverable: true, expiryUnverified: false } });
    const fixture = createFixture({ platform: "WOOCOMMERCE", candidates: [first, second],
      ai: { recommend: vi.fn(async () => "discount-2") } });
    expect(await fixture.resolver.resolve(request({ policy: aiPolicy }))).toMatchObject({
      kind: "CODE_OFFER", catalogueDiscountId: "discount-2", parameters: { code: "WOO10" },
    });
    const unsupported = createFixture({ platform: "WOOCOMMERCE", candidates: [wooDiscount({
      method: "AUTOMATIC", providerSnapshot: { provider: "WOOCOMMERCE", couponId: 9 },
    })], ai: { recommend: vi.fn() } });
    expect((await unsupported.resolver.resolve(request({ policy: aiPolicy }))).kind).toBe("NO_OFFER");
  });

  it("uses default fail-closed evaluator if no approved reader is provided", async () => {
    const fixture = createFixture();
    const service = new RecoveryOfferResolver(fixture.repository, undefined, undefined,
      null, fixture.reporting);
    expect(await service.resolve(request())).toMatchObject({
      kind: "NO_OFFER", reason: "PROVIDER_VERIFICATION_UNAVAILABLE",
    });
    expect(fixture.reporting.warn).toHaveBeenCalledWith("recovery_offer.capability_gap",
      expect.objectContaining({ reason: "CHECKOUT_RULE_READER_UNAVAILABLE" }));
  });

  it("rejects a mismatched checkout identity even if evaluator reports success", async () => {
    const fixture = createFixture({ verification: "eligible" });
    vi.mocked(fixture.evaluator.evaluate).mockImplementationOnce(async ({ checkout }) => ({
      outcome: "eligible", evidence: {
        shopId: "shop-1", checkoutRecoveryId: checkout.id, checkoutFingerprint: "wrong-fingerprint",
        providerDiscountId: "gid://shopify/DiscountCodeNode/1", currency: "USD",
        evaluatedAt: now, expiresAt: new Date(now.getTime() + 30_000), savingsMinor: 1500,
        verifiedCode: "SAVE10", verifiedDescription: "10% discount",
        qualifies: true, verifiedConstraints: [],
      },
    }));
    expect((await fixture.resolver.resolve(request())).kind).toBe("NO_OFFER");
  });

  it("fails closed when model availability is missing and doesn't call provider mutations", async () => {
    const fixture = createFixture();
    expect(await fixture.resolver.resolve(request({ policy: aiPolicy }))).toMatchObject({
      kind: "NO_OFFER", reason: "AI_UNAVAILABLE",
    });
    expect(Object.keys(fixture.repository).sort()).toEqual([
      "readCatalogue", "readCheckout", "readDiscounts", "readShop",
    ]);
    expect(Object.keys(fixture.evaluator)).toEqual(["evaluate"]);
  });

  it("logs and propagates unexpected AI exceptions instead of silently swallowing them", async () => {
    const fixture = createFixture({ ai: { recommend: vi.fn(async () => { throw Error("PII_SECRET"); }) } });
    await expect(fixture.resolver.resolve(request({ policy: aiPolicy })))
      .rejects.toBeInstanceOf(RecoveryOfferEvaluationFailure);
    expect(fixture.reporting.error).toHaveBeenCalledWith("recovery_offer.ai.failed", {
      shopId: "shop-1", errorType: "Error",
    });
    expect(JSON.stringify(fixture.reporting.error.mock.calls)).not.toContain("PII_SECRET");
  });

  it("never treats a trusted checkout fingerprint as proof of coupon eligibility", async () => {
    const fixture = createFixture({ verification: "ineligible" });
    const observed = await fixture.repository.readCheckout("shop-1", "recovery-1");
    expect(checkoutOfferFingerprint(observed!)).toMatch(/^[a-f0-9]{64}$/);
    expect(await fixture.resolver.resolve(request())).toMatchObject({ kind: "NO_OFFER" });
  });
});
