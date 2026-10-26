import { describe, expect, it, vi } from "vitest";
import { RecoveryOfferEvaluationFailure } from "../../../../src/services/recovery-offers/recovery-offer-resolver.service.js";
import { checkout } from "./fixtures.js";
import { checkoutOfferFingerprint } from "../../../../src/services/recovery-offers/recovery-offer-evidence.js";
import { createFixture, discount, now, request, wooDiscount } from "./fixtures.js";

describe("ARCH-047-BACKGROUND-004 FIXED/NONE recovery offers", () => {
  it("does no catalogue, provider, or model work for NONE", async () => {
    const fixture = createFixture({ ai: { recommend: vi.fn() } });
    expect(await fixture.resolver.resolve(request({ policy: {
      recoveryOfferMode: "NONE", fixedShopifyDiscountId: null, offerSnapshot: null,
    } }))).toEqual({ kind: "NO_OFFER", reason: "POLICY_NONE" });
    expect(fixture.repository.readShop).not.toHaveBeenCalled();
    expect(fixture.evaluator.evaluate).not.toHaveBeenCalled();
  });

  it("returns a frozen, verifiable Shopify code offer with bounded provenance", async () => {
    const { resolver, evaluator } = createFixture();
    const result = await resolver.resolve(request());
    expect(result).toMatchObject({ kind: "CODE_OFFER", shopId: "shop-1",
      checkoutRecoveryId: "recovery-1", parameters: { code: "SAVE10" },
      evidence: { source: "SHOPIFY_CHECKOUT_RULE_READER", currency: "USD", savingsMinor: 1500 } });
    expect(Object.isFrozen(result)).toBe(true);
    expect(evaluator.evaluate).toHaveBeenCalledTimes(1);
  });

  it("allows Shopify automatic discounts but never fabricates a redeem code", async () => {
    const fixture = createFixture({ candidates: [discount({
      method: "AUTOMATIC", providerType: "DiscountAutomaticBasic",
      singleRedeemCode: null, codeCount: null,
    })] });
    expect(await fixture.resolver.resolve(request())).toMatchObject({
      kind: "AUTOMATIC_OFFER", parameters: {},
    });
  });

  it("rejects expiry, stale provider evidence, ineligible and wrong currency/shop", async () => {
    for (const options of [
      { candidates: [discount({ endsAt: new Date(now.getTime() - 10) })] },
      { verification: "stale" as const },
      { verification: "ineligible" as const },
      { verification: "badCurrency" as const },
      { verification: "wrongShop" as const },
      { checkout: null },
      { checkout: { ...checkout, updatedAt: new Date(now.getTime() + 30_000) } },
      { checkout: { ...checkout, status: "COMPLETED" } },
    ]) {
      const fixture = createFixture(options);
      expect((await fixture.resolver.resolve(request())).kind).toBe("NO_OFFER");
    }
  });

  it("refuses a stale catalogue code even when the discount identity still qualifies", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.evaluator.evaluate).mockImplementationOnce(async ({ checkout: current, discount: selected }) => ({
      outcome: "eligible", evidence: {
        shopId: current.shopId, checkoutRecoveryId: current.id,
        providerDiscountId: selected.shopifyDiscountNodeId,
        checkoutFingerprint: checkoutOfferFingerprint(current),
        evaluatedAt: now, expiresAt: new Date(now.getTime() + 30_000),
        currency: "USD", savingsMinor: 1000, qualifies: true,
        verifiedCode: "CHANGED_AT_PROVIDER", verifiedDescription: "Current offer",
        verifiedConstraints: ["CURRENT_CHECKOUT"],
      },
    }));
    expect(await fixture.resolver.resolve(request())).toMatchObject({
      kind: "NO_OFFER", reason: "NO_ELIGIBLE_DISCOUNTS",
    });
  });

  it("requires a current catalogue and exact merchant authorization", async () => {
    const fixture = createFixture();
    expect(await fixture.resolver.resolve(request({ policy: {
      recoveryOfferMode: "FIXED", fixedShopifyDiscountId: "other-id", offerSnapshot: null,
    } }))).toEqual({ kind: "NO_OFFER", reason: "CANDIDATE_UNAVAILABLE" });
    expect(fixture.evaluator.evaluate).not.toHaveBeenCalled();
    vi.mocked(fixture.repository.readCatalogue).mockResolvedValueOnce({
      shopId: "shop-1", status: "ERROR", unavailableAt: now, lastSuccessfulSyncAt: now,
    });
    expect(await fixture.resolver.resolve(request())).toEqual({ kind: "NO_OFFER", reason: "CATALOGUE_UNAVAILABLE" });
  });

  it("selects the highest proven saving, with stable tie breaks and no AI", async () => {
    const a = discount({ id: "a", shopifyDiscountNodeId: "gid://shopify/DiscountCodeNode/a" });
    const b = discount({ id: "b", shopifyDiscountNodeId: "gid://shopify/DiscountCodeNode/b" });
    const fixture = createFixture({ candidates: [b, a], savings: { a: 2000, b: 2000 },
      ai: { recommend: vi.fn() } });
    const policy = { recoveryOfferMode: "FIXED" as const, fixedShopifyDiscountId: "a",
      offerSnapshot: null, authorisedDiscountIds: ["b", "a"] };
    expect(await fixture.resolver.resolve(request({ policy }))).toMatchObject({ catalogueDiscountId: "a" });
    expect(fixture.evaluator.evaluate).toHaveBeenCalledTimes(2);
    const ranked = createFixture({ candidates: [b, a], savings: { a: 2000, b: 3000 } });
    expect(await ranked.resolver.resolve(request({ policy }))).toMatchObject({ catalogueDiscountId: "b" });
  });

  it("does not select partially verified FIXED options and caps large catalogues", async () => {
    const a = discount({ id: "a" });
    const b = discount({ id: "b", shopifyDiscountNodeId: "gid://shopify/DiscountCodeNode/2" });
    const fixture = createFixture({ candidates: [a, b], verification: "unavailable" });
    expect(await fixture.resolver.resolve(request({ policy: {
      recoveryOfferMode: "FIXED", fixedShopifyDiscountId: "a", offerSnapshot: null,
      authorisedDiscountIds: ["a", "b"],
    } }))).toEqual({ kind: "NO_OFFER", reason: "PROVIDER_VERIFICATION_UNAVAILABLE" });
    expect(fixture.reporting.warn).toHaveBeenCalledWith("recovery_offer.capability_gap", expect.anything());
    expect(await fixture.resolver.resolve(request({ policy: {
      recoveryOfferMode: "FIXED", fixedShopifyDiscountId: "a", offerSnapshot: null,
      authorisedDiscountIds: Array.from({ length: 9 }, (_, i) => `item-${i}`),
    } }))).toEqual({ kind: "NO_OFFER", reason: "CANDIDATE_LIMIT" });
  });

  it("does not mistake a Woo anchor or incompatible coupon restriction for a real eligible code", async () => {
    const fixture = createFixture({ platform: "WOOCOMMERCE", candidates: [wooDiscount({
      providerSnapshot: { provider: "WOOCOMMERCE", couponId: 9, expiryUnverified: true },
    })] });
    expect((await fixture.resolver.resolve(request())).kind).toBe("NO_OFFER");
    expect(fixture.evaluator.evaluate).not.toHaveBeenCalled();
    const valid = createFixture({ platform: "WOOCOMMERCE", candidates: [wooDiscount()] });
    expect(await valid.resolver.resolve(request())).toMatchObject({ kind: "CODE_OFFER",
      parameters: { code: "WOO5" }, evidence: { source: "WOO_CHECKOUT_RULE_READER" } });
    const notRedeemable = createFixture({ platform: "WOOCOMMERCE", candidates: [wooDiscount({
      singleRedeemCode: "  \n", codeCount: 1,
    })] });
    expect((await notRedeemable.resolver.resolve(request())).kind).toBe("NO_OFFER");
  });

  it("requires prior actual sent offer evidence before changing follow-up wording", async () => {
    const fixture = createFixture();
    expect(await fixture.resolver.resolve(request({ stage: "FOLLOW_UP" }))).toEqual({
      kind: "NO_OFFER", reason: "PREVIOUS_OFFER_UNKNOWN",
    });
    expect(await fixture.resolver.resolve(request({ stage: "FOLLOW_UP",
      previouslyPromisedOffer: { kind: "NO_OFFER" },
    }))).toEqual({ kind: "NO_OFFER", reason: "PREVIOUS_OFFER_UNAVAILABLE" });
    expect(await fixture.resolver.resolve(request({ stage: "FOLLOW_UP",
      previouslyPromisedOffer: { kind: "CODE_OFFER", providerDiscountId: "gid://shopify/DiscountCodeNode/1", code: "SAVE10" },
    }))).toMatchObject({ kind: "CODE_OFFER", parameters: { code: "SAVE10" } });
    expect(await fixture.resolver.resolve(request({ stage: "FOLLOW_UP",
      previouslyPromisedOffer: { kind: "CODE_OFFER", providerDiscountId: "gid://shopify/DiscountCodeNode/1", code: "SOMETHING_ELSE" },
    }))).toMatchObject({ kind: "NO_OFFER", reason: "PREVIOUS_OFFER_UNAVAILABLE" });
  });

  it("logs unexpected database/provider exceptions without sensitive error messages and rethrows", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.repository.readShop).mockRejectedValueOnce(new Error("token=SECRET"));
    await expect(fixture.resolver.resolve(request())).rejects.toThrow("token=SECRET");
    expect(fixture.reporting.error).toHaveBeenCalledWith("recovery_offer.resolve.failed", {
      shopId: "shop-1", errorType: "Error",
    });
    const broken = createFixture();
    vi.mocked(broken.evaluator.evaluate).mockRejectedValueOnce(new Error("raw customer data"));
    await expect(broken.resolver.resolve(request())).rejects.toBeInstanceOf(RecoveryOfferEvaluationFailure);
    expect(broken.reporting.error).toHaveBeenCalledWith("recovery_offer.provider.failed", {
      shopId: "shop-1", platform: "SHOPIFY", errorType: "Error",
    });
    expect(JSON.stringify(broken.reporting.error.mock.calls)).not.toContain("raw customer data");
  });
});
