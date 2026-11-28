import { describe, expect, it } from "vitest";
import {
  nextShopifyVerificationRetry,
  SHOPIFY_VERIFICATION_DELAYS_MS,
  shopifyCandidateIndexTtlMs,
  type ShopifyVerificationState,
} from "../../../src/domain/shopify-abandoned-verification-retry.js";

describe("Shopify abandoned-checkout verification timing", () => {
  it("uses a bounded visibility window independent of every merchant inactivity delay", () => {
    const first = Date.parse("2026-11-16T17:00:00.000Z");
    let at = first;
    let state: ShopifyVerificationState | undefined;
    for (const delay of SHOPIFY_VERIFICATION_DELAYS_MS) {
      const next = nextShopifyVerificationRetry(state, at);
      expect(next).not.toBeNull();
      expect(next!.dueAtMs).toBe(at + delay);
      state = next!.state;
      at = next!.dueAtMs;
    }
    expect(nextShopifyVerificationRetry(state, at)).toBeNull();
    for (const merchantDelay of [0, 1, 5, 30, 120, 1440]) {
      const ttl = shopifyCandidateIndexTtlMs(
        merchantDelay,
        1000,
        first,
        first + merchantDelay * 60_000,
      );
      expect(ttl).toBeGreaterThanOrEqual(merchantDelay * 60_000 + 70 * 60_000);
    }
  });

  it("does not restart an elapsed window or accept corrupt persisted state", () => {
    const first = 10_000_000;
    expect(
      nextShopifyVerificationRetry(
        { firstAttemptAtMs: first, deferrals: 0 },
        first + 60 * 60_000,
      ),
    ).toBeNull();
    expect(
      nextShopifyVerificationRetry(
        { firstAttemptAtMs: first, deferrals: 99 },
        first + 10,
      ),
    ).toBeNull();
    expect(
      nextShopifyVerificationRetry(
        { firstAttemptAtMs: first, deferrals: -1 },
        first + 10,
      ),
    ).toBeNull();
    expect(
      nextShopifyVerificationRetry(
        { firstAttemptAtMs: first + 100, deferrals: 1 },
        first,
      ),
    ).toBeNull();
  });
});
