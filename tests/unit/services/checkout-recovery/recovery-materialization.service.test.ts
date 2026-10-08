import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingRecoveryCandidate } from "../../../../src/domain/pending-recovery-candidate.js";
import type { NormalizedAbandonedCheckout } from "../../../../src/domain/abandoned-checkout.js";
import { RecoveryMaterializationService } from "../../../../src/services/checkout-recovery/recovery-materialization.service.js";
import { ShopExecutionEligibilityService } from "../../../../src/services/shop-execution-eligibility.service.js";

const candidate: PendingRecoveryCandidate = {
  shopId: "shop-1",
  shopDomain: "merchant.myshopify.com",
  checkoutToken: "checkout-1",
  cartToken: "cart-1",
  abandonedCheckoutUrl: "https://shopify.example/recovery",
  checkoutCreatedAt: "2026-09-01T10:00:00.000Z",
};

const checkout: NormalizedAbandonedCheckout = {
  shopifyAbandonedCheckoutId: "diagnostic-id",
  abandonedCheckoutUrl: "https://shopify.example/recovery",
  createdAt: "2026-09-01T10:00:00.000Z",
  completedAt: null,
  currencyCode: "GBP",
  totalPrice: "42.00",
  internationalContext: {
    languageTag: null,
    languageSource: null,
    countryCode: null,
    currencyCode: "GBP",
    timeZone: null,
  },
  customer: null,
  lineItems: [],
};

function createHarness(options: {
  firstEligibility?: { allowed: boolean; shopId: string; reason?: string };
  secondEligibility?: { allowed: boolean; shopId: string; reason?: string };
  orderProcessed?: boolean;
  latestRecovery?: { status: string; generation: number } | null;
  lookupOutcome?: unknown;
} = {}) {
  const order: string[] = [];
  let eligibilityCall = 0;
  const executionEligibility = {
    evaluate: vi.fn(async () => {
      order.push("eligibility");
      eligibilityCall += 1;
      return eligibilityCall === 1
        ? options.firstEligibility ?? { allowed: true, shopId: candidate.shopId }
        : options.secondEligibility ?? { allowed: true, shopId: candidate.shopId };
    }),
  };
  const abandonedCheckoutLookup = {
    resolveShopDomain: vi.fn(async () => {
      order.push("resolve-domain");
      return candidate.shopDomain;
    }),
    lookup: vi.fn(async () => {
      order.push("provider-lookup");
      return options.lookupOutcome ?? { kind: "found", checkout };
    }),
  };
  const pendingRecoveryCandidate = {
    withCheckoutLock: vi.fn(async (_shopId: string, _checkoutToken: string, callback: () => Promise<unknown>) => {
      order.push("checkout-lock");
      return callback();
    }),
    hasOrderProcessed: vi.fn(async () => {
      order.push("order-tombstone");
      return options.orderProcessed ?? false;
    }),
  };
  const findLatestRecovery = vi.fn(async () => {
    order.push("latest-generation");
    return options.latestRecovery ?? null;
  });
  const snapshotBuilder = {
    build: vi.fn(async () => {
      order.push("snapshot");
      return { shop: candidate.shopDomain, checkoutToken: candidate.checkoutToken } as never;
    }),
  };
  const initiate = vi.fn(async () => {
    order.push("initiate");
  });
  const service = new RecoveryMaterializationService({
    executionEligibility,
    abandonedCheckoutLookup,
    pendingRecoveryCandidate,
    findLatestRecovery,
    snapshotBuilder,
    initiate,
  });
  return {
    service,
    order,
    executionEligibility,
    abandonedCheckoutLookup,
    pendingRecoveryCandidate,
    findLatestRecovery,
    snapshotBuilder,
    initiate,
  };
}

describe("RecoveryMaterializationService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves eligibility, lock, order tombstone, latest-generation, lookup, snapshot and initiation order", async () => {
    const harness = createHarness();

    const result = await harness.service.materialize(candidate);

    expect(result).toEqual({ outcome: "recovery-created", checkoutToken: candidate.checkoutToken });
    expect(harness.order).toEqual([
      "eligibility",
      "resolve-domain",
      "checkout-lock",
      "eligibility",
      "order-tombstone",
      "latest-generation",
      "provider-lookup",
      "snapshot",
      "initiate",
    ]);
    expect(harness.abandonedCheckoutLookup.lookup).toHaveBeenCalledExactlyOnceWith({
      shopId: candidate.shopId,
      shopDomain: candidate.shopDomain,
      checkoutToken: candidate.checkoutToken,
      cartToken: candidate.cartToken,
      abandonedCheckoutUrl: candidate.abandonedCheckoutUrl,
      checkoutCreatedAt: candidate.checkoutCreatedAt,
    });
    expect(harness.initiate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ checkoutToken: candidate.checkoutToken }));
    expect(harness.initiate.mock.calls[0]).toHaveLength(1);
  });

  it("discards before domain resolution when initial eligibility fails", async () => {
    const harness = createHarness({
      firstEligibility: { allowed: false, shopId: candidate.shopId, reason: "SUBSCRIPTION_FROZEN" },
    });

    await expect(harness.service.materialize(candidate)).resolves.toEqual({
      outcome: "discarded-shop-unavailable",
      checkoutToken: candidate.checkoutToken,
      reason: "SUBSCRIPTION_FROZEN",
    });
    expect(harness.order).toEqual(["eligibility"]);
    expect(harness.abandonedCheckoutLookup.resolveShopDomain).not.toHaveBeenCalled();
  });

  it("materializes a Woo FROZEN candidate through recovery-scoped eligibility", async () => {
    const eligibility = new ShopExecutionEligibilityService({
      subscription: {
        findUnique: vi.fn(async () => ({
          status: "FROZEN",
          lastProviderLifecycleState: null,
          shop: {
            status: "ACTIVE",
            onboardingCompleted: true,
            platform: "WOOCOMMERCE",
          },
        })),
      },
    } as never);
    const harness = createHarness();
    const service = new RecoveryMaterializationService({
      executionEligibility: eligibility,
      abandonedCheckoutLookup: harness.abandonedCheckoutLookup,
      pendingRecoveryCandidate: harness.pendingRecoveryCandidate,
      findLatestRecovery: harness.findLatestRecovery,
      snapshotBuilder: harness.snapshotBuilder,
      initiate: harness.initiate,
    });

    await expect(service.materialize(candidate)).resolves.toEqual({
      outcome: "recovery-created",
      checkoutToken: candidate.checkoutToken,
    });
    expect(harness.initiate).toHaveBeenCalledOnce();
  });

  it("rechecks eligibility under the checkout lock before reading the order tombstone", async () => {
    const harness = createHarness({
      secondEligibility: { allowed: false, shopId: candidate.shopId, reason: "CONTRACT_REQUIRED" },
    });

    await expect(harness.service.materialize(candidate)).resolves.toEqual({
      outcome: "discarded-shop-unavailable",
      checkoutToken: candidate.checkoutToken,
      reason: "CONTRACT_REQUIRED",
    });
    expect(harness.order).toEqual(["eligibility", "resolve-domain", "checkout-lock", "eligibility"]);
    expect(harness.pendingRecoveryCandidate.hasOrderProcessed).not.toHaveBeenCalled();
    expect(harness.abandonedCheckoutLookup.lookup).not.toHaveBeenCalled();
  });

  it("discards an order tombstone before reading generation or Shopify", async () => {
    const harness = createHarness({ orderProcessed: true });

    await expect(harness.service.materialize(candidate)).resolves.toEqual({
      outcome: "discarded-order-completed",
      checkoutToken: candidate.checkoutToken,
    });
    expect(harness.order).toEqual(["eligibility", "resolve-domain", "checkout-lock", "eligibility", "order-tombstone"]);
    expect(harness.findLatestRecovery).not.toHaveBeenCalled();
    expect(harness.abandonedCheckoutLookup.lookup).not.toHaveBeenCalled();
  });

  it.each(["DETECTED", "MESSAGE_SENT", "ENGAGED"])("does not rematerialize active generation %s", async (status) => {
    const harness = createHarness({ latestRecovery: { status, generation: 4 } });

    await expect(harness.service.materialize(candidate)).resolves.toEqual({
      outcome: "no-op-existing",
      checkoutToken: candidate.checkoutToken,
      status,
    });
    expect(harness.abandonedCheckoutLookup.lookup).not.toHaveBeenCalled();
    expect(harness.initiate).not.toHaveBeenCalled();
  });

  it.each(["COMPLETED", "CANCELLED"])("does not reopen terminal generation %s", async (status) => {
    const harness = createHarness({ latestRecovery: { status, generation: 4 } });

    await expect(harness.service.materialize(candidate)).resolves.toEqual({
      outcome: "discarded-terminal",
      checkoutToken: candidate.checkoutToken,
      status,
    });
    expect(harness.abandonedCheckoutLookup.lookup).not.toHaveBeenCalled();
    expect(harness.initiate).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "not-found" }, "discarded-not-found"],
    [{ kind: "ambiguous", matched: 2 }, "discarded-ambiguous"],
    [{ kind: "bounded-limit-exceeded", candidateCount: 21 }, "discarded-bound-exceeded"],
  ] as const)("maps lookup result %s to %s without initiation", async (lookupOutcome, expectedOutcome) => {
    const harness = createHarness({ lookupOutcome });

    await expect(harness.service.materialize(candidate)).resolves.toEqual({
      outcome: expectedOutcome,
      checkoutToken: candidate.checkoutToken,
    });
    expect(harness.snapshotBuilder.build).not.toHaveBeenCalled();
    expect(harness.initiate).not.toHaveBeenCalled();
  });

  it("keeps provider errors retryable by throwing without snapshot or initiation", async () => {
    const harness = createHarness({ lookupOutcome: { kind: "provider-error", message: "Shopify unavailable" } });

    await expect(harness.service.materialize(candidate)).rejects.toThrow(
      "Abandoned checkout provider error while materializing candidate: Shopify unavailable",
    );
    expect(harness.snapshotBuilder.build).not.toHaveBeenCalled();
    expect(harness.initiate).not.toHaveBeenCalled();
  });

  it("discards a completed current Shopify checkout", async () => {
    const harness = createHarness({ lookupOutcome: { kind: "found", checkout: { ...checkout, completedAt: "2026-09-02T10:00:00Z" } } });

    await expect(harness.service.materialize(candidate)).resolves.toEqual({
      outcome: "discarded-not-recoverable",
      checkoutToken: candidate.checkoutToken,
    });
    expect(harness.snapshotBuilder.build).not.toHaveBeenCalled();
    expect(harness.initiate).not.toHaveBeenCalled();
  });

  it("advances an expired generation and passes that generation to canonical initiation", async () => {
    const harness = createHarness({ latestRecovery: { status: "EXPIRED", generation: 4 } });

    const result = await harness.service.materialize(candidate);

    expect(result.outcome).toBe("recovery-created");
    expect(harness.initiate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ checkoutToken: candidate.checkoutToken }), 5);
  });
});