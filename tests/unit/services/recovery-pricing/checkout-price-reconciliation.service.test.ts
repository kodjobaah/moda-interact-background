import { describe, expect, it, vi } from "vitest";
import {
  CheckoutPriceReconciliationService,
  InvalidPriceReconciliationAttemptError,
} from "../../../../src/services/recovery-pricing/checkout-price-reconciliation.service.js";
import { fingerprintRecoveryPricingBasket } from "../../../../src/services/recovery-pricing/price-comparison.js";
import type {
  PriceReconciliationInput,
  RecoveryPricingState,
} from "../../../../src/services/recovery-pricing/checkout-price-reconciliation.types.js";

const now = new Date("2026-10-31T09:00:00.000Z");

function state(
  lineItems: unknown = [{ productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/2", quantity: 2, price: "80.00" }],
  changes: Partial<RecoveryPricingState["recovery"]> = {},
  attemptChanges: Partial<NonNullable<RecoveryPricingState["attempt"]>> = {},
): RecoveryPricingState {
  return {
    recovery: {
      id: "recovery-1", shopId: "shop-1", generation: 7, currency: "GBP", lineItems,
      platform: "SHOPIFY", status: "DETECTED", ...changes,
    },
    attempt: {
      id: "attempt-1", checkoutRecoveryId: "recovery-1", sequence: 1,
      trigger: "INITIAL", status: "PENDING", initiatedBy: "AGENT", ...attemptChanges,
    },
  };
}

function input(snapshot = state(), signal = new AbortController().signal): PriceReconciliationInput {
  return {
    shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1",
    expectedGeneration: 7,
    expectedBasketFingerprint: fingerprintRecoveryPricingBasket({
      shopId: snapshot.recovery.shopId,
      checkoutRecoveryId: snapshot.recovery.id,
      generation: snapshot.recovery.generation,
      currency: snapshot.recovery.currency,
      lineItems: snapshot.recovery.lineItems,
    }),
    signal,
  };
}

function productResult(input_: { productId?: string; variantId?: string | null; unitPrice?: string | null; currency?: string | null } = {}) {
  return {
    contractVersion: "commerce.v1",
    status: "OK",
    data: {
      product: {
        productId: input_.productId ?? "gid://shopify/Product/1",
        variantId: input_.variantId === undefined ? "gid://shopify/ProductVariant/2" : input_.variantId,
        title: "Observed product", url: null, available: true,
        unitPrice: input_.unitPrice === undefined ? "90.00" : input_.unitPrice,
        currency: input_.currency === undefined ? "GBP" : input_.currency,
        productType: null, vendor: null, observedAt: "2026-10-31T08:59:00.000Z",
      },
    },
    renderedText: "",
  };
}

function service(options: {
  snapshots?: RecoveryPricingState[];
  productRead?: (request: Parameters<ConstructorParameters<typeof CheckoutPriceReconciliationService>[0]["productReader"]["read"]>[0]) => Promise<unknown>;
  logger?: { error: ReturnType<typeof vi.fn> };
  now?: () => Date;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
} = {}) {
  let reads = 0;
  const snapshots = options.snapshots ?? [state()];
  const recoveryAttemptReader = {
    read: vi.fn(async () => snapshots[Math.min(reads++, snapshots.length - 1)] ?? null),
  };
  const productReader = {
    read: vi.fn(options.productRead ?? (async () => productResult())),
  };
  const logger = options.logger ?? { error: vi.fn() };
  return {
    instance: new CheckoutPriceReconciliationService({
      recoveryAttemptReader, productReader, logger,
      now: options.now ?? (() => now),
      ...(options.setTimer ? { setTimer: options.setTimer } : {}),
      ...(options.clearTimer ? { clearTimer: options.clearTimer } : {}),
    }),
    recoveryAttemptReader,
    productReader,
    logger,
  };
}

describe("CheckoutPriceReconciliationService", () => {
  it("returns exact catalogue facts as partial and never claims a checkout price change or subtotal", async () => {
    const harness = service();
    const result = await harness.instance.reconcile(input());
    expect(result.completeness).toBe("PARTIAL");
    expect(result.currentMerchandiseSubtotal).toBeNull();
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({
      lineKey: "line-0001", catalogueComparison: "DIFFERENT",
      checkoutPriceChange: "UNVERIFIABLE", catalogueUnitPrice: "90.00",
      catalogueCurrency: "GBP", reasonCodes: expect.arrayContaining(["CATALOGUE_PRICE_DIFFERENCE", "PRICE_CONTEXT_UNVERIFIED"]),
    });
    expect(harness.productReader.read).toHaveBeenCalledWith(expect.objectContaining({
      shopId: "shop-1", productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/2",
      toolContext: { purpose: "INITIAL_RECOVERY_OUTREACH" },
    }));
    expect(harness.recoveryAttemptReader.read).toHaveBeenCalledTimes(2);
  });

  it("rejects stale attempt lineage and fingerprints before making any exact product read", async () => {
    const snapshot = state(undefined, {}, { sequence: 2 });
    const harness = service({ snapshots: [snapshot] });
    await expect(harness.instance.reconcile(input(snapshot))).rejects.toBeInstanceOf(InvalidPriceReconciliationAttemptError);
    expect(harness.productReader.read).not.toHaveBeenCalled();

    const fresh = service();
    await expect(fresh.instance.reconcile({ ...input(), expectedBasketFingerprint: "0".repeat(64) }))
      .rejects.toMatchObject({ reasonCode: "RECOVERY_BASKET_FINGERPRINT_MISMATCH" });
    expect(fresh.productReader.read).not.toHaveBeenCalled();
  });

  it("rechecks generation and basket fingerprint after the provider read", async () => {
    const initial = state();
    const changed = state([{ productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/3", quantity: 2, price: "80.00" }]);
    const harness = service({ snapshots: [initial, changed] });
    await expect(harness.instance.reconcile(input(initial)))
      .rejects.toMatchObject({ reasonCode: "RECOVERY_BASKET_FINGERPRINT_MISMATCH" });
    expect(harness.productReader.read).toHaveBeenCalledTimes(1);
  });

  it("returns invalid and oversized baskets without product reads", async () => {
    for (const [basket, reason] of [[[], "BASKET_INVALID"], [null, "BASKET_INVALID"],
      [Array.from({ length: 101 }, () => ({ productId: "p", variantId: "v", quantity: 1, price: "1.00" })), "BASKET_TOO_LARGE"]] as const) {
      const snapshot = state(basket);
      const harness = service({ snapshots: [snapshot] });
      const result = await harness.instance.reconcile(input(snapshot));
      expect(result).toMatchObject({ completeness: "PARTIAL", lines: [], currentMerchandiseSubtotal: null, reasonCodes: [reason] });
      expect(harness.productReader.read).not.toHaveBeenCalled();
      expect(harness.recoveryAttemptReader.read).toHaveBeenCalledTimes(1);
    }
  });

  it("requires Shopify variants but accepts an exact Woo simple product with a null variant", async () => {
    const shopify = state([{ productId: "gid://shopify/Product/1", variantId: null, quantity: 1, price: "80.00" }]);
    const shopifyHarness = service({ snapshots: [shopify] });
    const missingVariant = await shopifyHarness.instance.reconcile(input(shopify));
    expect(missingVariant.lines[0]).toMatchObject({ catalogueComparison: "INCOMPARABLE", reasonCodes: expect.arrayContaining(["MISSING_VARIANT_ID"]) });
    expect(shopifyHarness.productReader.read).not.toHaveBeenCalled();

    const woo = state([{ productId: "42", variantId: null, quantity: 1, price: "80.00" }], { platform: "WOOCOMMERCE" });
    const wooHarness = service({ snapshots: [woo], productRead: async () => productResult({
      productId: "42", variantId: null, unitPrice: "80.00", currency: "GBP",
    }) });
    const simpleProduct = await wooHarness.instance.reconcile(input(woo));
    expect(wooHarness.productReader.read).toHaveBeenCalledWith(expect.objectContaining({ productId: "42", variantId: null }));
    expect(simpleProduct.lines[0]).toMatchObject({ catalogueComparison: "EQUAL", checkoutPriceChange: "UNVERIFIABLE" });
  });

  it("deduplicates exact product/variant reads while preserving ordered line quantities", async () => {
    const lines = [1, 3, 5].map((quantity) => ({
      productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/2", quantity, price: "80.00",
    }));
    const snapshot = state(lines);
    const harness = service({ snapshots: [snapshot] });
    const result = await harness.instance.reconcile(input(snapshot));
    expect(harness.productReader.read).toHaveBeenCalledTimes(1);
    expect(result.lines.map((line) => line.quantity)).toEqual([1, 3, 5]);
    expect(result.lines.map((line) => line.lineKey)).toEqual(["line-0001", "line-0002", "line-0003"]);
  });

  it("keeps invalid required facts incomparable and rejects provider identity mismatches", async () => {
    const invalidQuantity = state([{ productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/2", quantity: 0, price: "80.00" }]);
    const quantityHarness = service({ snapshots: [invalidQuantity] });
    const invalid = await quantityHarness.instance.reconcile(input(invalidQuantity));
    expect(invalid.lines[0]).toMatchObject({
      catalogueComparison: "INCOMPARABLE",
      reasonCodes: expect.arrayContaining(["SOURCE_OBSERVATION_INVALID"]),
    });

    const identityHarness = service({ productRead: async () => productResult({
      productId: "gid://shopify/Product/other", variantId: "gid://shopify/ProductVariant/2",
    }) });
    const mismatch = await identityHarness.instance.reconcile(input());
    expect(mismatch.lines[0]).toMatchObject({
      catalogueComparison: "INCOMPARABLE", catalogueUnitPrice: null,
      reasonCodes: expect.arrayContaining(["PROVIDER_IDENTITY_MISMATCH"]),
    });
  });

  it("fetches fresh observations for each retry invocation", async () => {
    const observations = ["90.00", "95.00"];
    const harness = service({ productRead: async () => productResult({ unitPrice: observations.shift() }) });
    const first = await harness.instance.reconcile(input());
    const retry = await harness.instance.reconcile(input());
    expect(first.lines[0]?.catalogueUnitPrice).toBe("90.00");
    expect(retry.lines[0]?.catalogueUnitPrice).toBe("95.00");
    expect(harness.productReader.read).toHaveBeenCalledTimes(2);
  });

  it("limits exact product reads to four concurrent calls and no more than 100", async () => {
    const lines = Array.from({ length: 100 }, (_, index) => ({
      productId: `gid://shopify/Product/${index + 1}`,
      variantId: `gid://shopify/ProductVariant/${index + 1}`,
      quantity: 1, price: "80.00",
    }));
    const snapshot = state(lines);
    let active = 0;
    let maximumActive = 0;
    const harness = service({
      snapshots: [snapshot],
      productRead: async (request) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        return productResult({ productId: request.productId, variantId: request.variantId });
      },
    });
    const result = await harness.instance.reconcile(input(snapshot));
    expect(harness.productReader.read).toHaveBeenCalledTimes(100);
    expect(maximumActive).toBe(4);
    expect(result.lines).toHaveLength(100);
  });

  it("marks budget-exhausted reads incomplete and aborts in-flight product calls", async () => {
    const lines = Array.from({ length: 6 }, (_, index) => ({
      productId: `gid://shopify/Product/${index + 1}`,
      variantId: `gid://shopify/ProductVariant/${index + 1}`,
      quantity: 1, price: "80.00",
    }));
    const snapshot = state(lines);
    let expire: (() => void) | undefined;
    let started = 0;
    const clearTimer = vi.fn();
    const harness = service({
      snapshots: [snapshot],
      setTimer: ((callback: TimerHandler) => { expire = () => typeof callback === "function" ? callback() : undefined; return 1 as ReturnType<typeof setTimeout>; }) as typeof setTimeout,
      clearTimer,
      productRead: async ({ signal }) => {
        started++;
        return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
    });
    const pending = harness.instance.reconcile(input(snapshot));
    await vi.waitFor(() => expect(started).toBe(4));
    expire?.();
    const result = await pending;
    expect(result.completeness).toBe("PARTIAL");
    expect(result.lines.every((line) => line.reasonCodes.includes("BUDGET_EXHAUSTED"))).toBe(true);
    expect(started).toBe(4);
    expect(clearTimer).toHaveBeenCalled();
  });

  it("propagates caller cancellation and unexpected source errors without replacing them", async () => {
    const controller = new AbortController();
    const cancellationHarness = service({ productRead: async ({ signal }) => {
      controller.abort(new Error("caller cancelled"));
      signal.throwIfAborted();
      return productResult();
    } });
    await expect(cancellationHarness.instance.reconcile(input(state(), controller.signal)))
      .rejects.toThrow("caller cancelled");

    const original = new Error("original MCP transport diagnostic");
    const logger = { error: vi.fn() };
    const failureHarness = service({ logger, productRead: async () => { throw original; } });
    await expect(failureHarness.instance.reconcile(input())).rejects.toBe(original);
    expect(logger.error).toHaveBeenCalledWith("recovery.price_reconciliation.source_failed", expect.objectContaining({
      reasonCode: "PRODUCT_READ_FAILED", error: original, operation: "commerce_get_product",
    }));
    expect(failureHarness.recoveryAttemptReader.read).toHaveBeenCalledTimes(2);
  });
});