import { vi } from "vitest";
import { checkoutOfferFingerprint } from "../../../../src/services/recovery-offers/recovery-offer-evidence.js";
import { RecoveryOfferResolver } from "../../../../src/services/recovery-offers/recovery-offer-resolver.service.js";
import type {
  CheckoutOfferContext, DiscountOfferCandidate, ReadOnlyOfferRecommender,
  ReadOnlyProviderEligibility, RecoveryOfferRepository, ResolveRecoveryOfferInput,
} from "../../../../src/services/recovery-offers/recovery-offer.types.js";

export const now = new Date("2026-10-26T13:00:00.000Z");
export const checkout: CheckoutOfferContext = {
  id: "recovery-1", shopId: "shop-1", checkoutToken: "checkout-1", status: "DETECTED",
  currency: "USD", totalPrice: "100.00", lineItems: [{ id: "line-1", quantity: 1 }],
  lastExternalActivityAt: new Date(now.getTime() - 45 * 60_000),
  updatedAt: new Date(now.getTime() - 1000),
};
export function discount(overrides: Partial<DiscountOfferCandidate> = {}): DiscountOfferCandidate {
  return {
    id: "discount-1", shopId: "shop-1", shopifyDiscountNodeId: "gid://shopify/DiscountCodeNode/1",
    providerType: "DiscountCodeBasic", method: "CODE", providerStatus: "ACTIVE",
    title: "Ten percent", summary: "10% discount", startsAt: null, endsAt: null,
    codeCount: 1, singleRedeemCode: "SAVE10", fixedSelectable: true,
    isAvailable: true, unavailableAt: null, providerSnapshot: {}, ...overrides,
  };
}
export function request(override: Partial<ResolveRecoveryOfferInput> = {}): ResolveRecoveryOfferInput {
  return {
    shopId: "shop-1", checkoutRecoveryId: "recovery-1", stage: "INITIAL", now,
    policy: { recoveryOfferMode: "FIXED", fixedShopifyDiscountId: "discount-1", offerSnapshot: null },
    ...override,
  };
}
export function createFixture(options: {
  candidates?: DiscountOfferCandidate[];
  checkout?: CheckoutOfferContext | null;
  platform?: string;
  savings?: Record<string, number>;
  verification?: "eligible" | "ineligible" | "unavailable" | "badCurrency" | "stale" | "wrongShop";
  ai?: ReadOnlyOfferRecommender | null;
} = {}) {
  const candidates = options.candidates ?? [discount()];
  const recovery = options.checkout === undefined ? checkout : options.checkout;
  const repository: RecoveryOfferRepository = {
    readShop: vi.fn(async (shopId) => ({ id: shopId, platform: options.platform ?? "SHOPIFY", status: "ACTIVE" })),
    readCheckout: vi.fn(async () => recovery),
    readCatalogue: vi.fn(async (shopId) => ({ shopId, status: "CURRENT", lastSuccessfulSyncAt: new Date(now.getTime() - 30_000), unavailableAt: null })),
    readDiscounts: vi.fn(async (_shopId, ids, limit) => candidates
      .filter((row) => ids === null || ids.includes(row.id)).slice(0, limit)),
  };
  const evaluator: ReadOnlyProviderEligibility = {
    evaluate: vi.fn(async ({ shopId, checkout: current, discount: candidate }) => {
      if (options.verification === "unavailable" || options.verification === "ineligible") {
        return { outcome: options.verification } as const;
      }
      const observed = options.verification === "stale"
        ? new Date(now.getTime() - 120_000) : new Date(now.getTime() - 500);
      const evidence = {
        shopId: options.verification === "wrongShop" ? "other-shop" : shopId,
        checkoutRecoveryId: current.id,
        providerDiscountId: candidate.shopifyDiscountNodeId,
        checkoutFingerprint: checkoutOfferFingerprint(current),
        evaluatedAt: observed, expiresAt: new Date(now.getTime() + 25_000),
        currency: options.verification === "badCurrency" ? "GBP" : current.currency!,
        savingsMinor: options.savings?.[candidate.id] ?? 1500,
        verifiedCode: candidate.method === "CODE" ? candidate.singleRedeemCode : null,
        verifiedDescription: candidate.summary ?? candidate.title,
        qualifies: true as const,
        verifiedConstraints: ["CURRENT_CHECKOUT", "CUSTOMER_AND_USAGE_CHECKED"],
      };
      return { outcome: "eligible", evidence } as const;
    }),
  };
  const reporting = { warn: vi.fn(), error: vi.fn() };
  const resolver = new RecoveryOfferResolver(repository, evaluator, evaluator, options.ai ?? null, reporting);
  return { resolver, repository, evaluator, reporting, candidates };
}
export function wooDiscount(overrides: Partial<DiscountOfferCandidate> = {}): DiscountOfferCandidate {
  return discount({
    shopifyDiscountNodeId: "woo:coupon:9", providerType: "WooCoupon:code",
    singleRedeemCode: "WOO5", title: "WOO5", summary: "fixed_cart: 5",
    providerSnapshot: { provider: "WOOCOMMERCE", couponId: 9, code: "WOO5",
      codeDeliverable: true, expiryUnverified: false },
    ...overrides,
  });
}
