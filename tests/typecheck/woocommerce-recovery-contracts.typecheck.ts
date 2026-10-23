/**
 * ARCH-048-BG006 compile-time conformity checks.
 * Run: npx tsc --noEmit -p tests/typecheck/tsconfig.arch048-bg006.json
 * This module imports types only; no services or worker runtime are invoked.
 */
import type { WooCheckoutCapture } from "../../src/events/woo-checkout-capture.js";
import type { WooOrderCapture } from "../../src/events/woo-order-capture.js";
import type { PendingRecoveryCandidate } from "../../src/domain/pending-recovery-candidate.js";
import type {
  WooAdmissionOutcome,
  WooBasketEvidence,
  WooCandidateManager,
  WooCheckoutActivityHandler,
  WooCheckoutCoordinator,
  WooCheckoutRef,
  WooOrderReconciler,
  WooObservedOrderStateReader,
  WooOutreachDispatchOutcome,
  WooPendingCandidate,
  WooRecoveryAdmissionEvaluator,
  WooRecoveryOutreachDispatcher,
  WooTerminalObservation,
} from "../../src/services/woocommerce-recovery/contracts.js";

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? true
    : false;
type IsRequired<T, K extends keyof T> = Pick<T, K> extends Required<Pick<T, K>> ? true : false;

// Guard the helper itself: optional fields must not count as required.
export type OptionalFixtureRejected = Assert<
  Equal<IsRequired<{ optional?: string }, "optional">, false>
>;

// Source, identity, watermark and basket evidence cannot be omitted.
export type RequiredWooSource = Assert<IsRequired<WooPendingCandidate, "source">>;
export type RequiredWooShop = Assert<IsRequired<WooPendingCandidate, "shopId">>;
export type RequiredWooCheckout = Assert<IsRequired<WooPendingCandidate, "checkoutToken">>;
export type RequiredWooEvent = Assert<IsRequired<WooPendingCandidate, "lastEventId">>;
export type RequiredWooActivity = Assert<IsRequired<WooPendingCandidate, "lastActivityAt">>;
export type RequiredWooBasket = Assert<IsRequired<WooPendingCandidate, "basket">>;
export type WooOnlySource = Assert<Equal<WooPendingCandidate["source"], "woocommerce">>;

// Legacy Shopify candidates remain source-unmarked. No Shopify candidate type
// or worker routing is changed by this type-only implementation.
export type UnchangedShopifySourceShape = Assert<
  Equal<"source" extends keyof PendingRecoveryCandidate ? true : false, false>
>;
export const legacyShopifyCandidate: PendingRecoveryCandidate = {
  shopId: "shopify-shop",
  shopDomain: "example.myshopify.com",
  checkoutToken: "checkout-1",
  cartToken: null,
  abandonedCheckoutUrl: null,
  checkoutCreatedAt: null,
};

export const parsedCheckout: WooCheckoutCapture = {
  schemaVersion: "woo.activity.v1",
  eventId: "checkout-event-1",
  eventType: "CHECKOUT_UPDATED",
  shopId: "woo-shop-1",
  checkoutKey: "checkout-key-1",
  occurredAt: "2026-10-23T12:00:00.000Z",
  checkout: {
    currency: "GBP",
    total: "12.00",
    items: [{ quantity: 1, productId: "sku-1", unitPrice: "12.00" }],
  },
};
export const parsedOrder: WooOrderCapture = {
  schemaVersion: "woo.activity.v1",
  eventId: "order-event-1",
  eventType: "ORDER_PLACED",
  shopId: "woo-shop-1",
  checkoutKey: "checkout-key-1",
  occurredAt: "2026-10-23T12:00:01.000Z",
  order: {
    orderId: "order-1",
    checkoutKey: "checkout-key-1",
    status: "pending",
  },
};

export const nonempty: WooBasketEvidence = {
  kind: "nonempty",
  checkout: {
    currency: "GBP",
    total: "12.00",
    items: [{ quantity: 1 }],
  },
};
export const empty: WooBasketEvidence = { kind: "empty" };
export const missingItems: WooBasketEvidence = {
  kind: "unknown",
  reason: "items-omitted",
};
export const conflictingVersions: WooBasketEvidence = {
  kind: "unknown",
  reason: "conflicting-events",
};
export const incompleteSnapshot: WooBasketEvidence = {
  kind: "unknown",
  reason: "incomplete-snapshot",
};

export const pending: WooPendingCandidate = {
  source: "woocommerce",
  shopId: parsedCheckout.shopId,
  checkoutToken: parsedCheckout.checkoutKey,
  lastEventId: parsedCheckout.eventId,
  lastActivityAt: parsedCheckout.occurredAt,
  basket: nonempty,
};

// @ts-expect-error Explicit Woo source is required.
export const sourceMissing: WooPendingCandidate = {
  shopId: "woo-shop-1", checkoutToken: "checkout-key-1",
  lastEventId: "checkout-event-1", lastActivityAt: "2026-10-23T12:00:00.000Z",
  basket: empty,
};
// @ts-expect-error Shop identity is required for every Woo candidate.
export const shopMissing: WooPendingCandidate = {
  source: "woocommerce", checkoutToken: "checkout-key-1",
  lastEventId: "checkout-event-1", lastActivityAt: "2026-10-23T12:00:00.000Z",
  basket: empty,
};
// @ts-expect-error Checkout identity is required for every Woo candidate.
export const checkoutMissing: WooPendingCandidate = {
  source: "woocommerce", shopId: "woo-shop-1",
  lastEventId: "checkout-event-1", lastActivityAt: "2026-10-23T12:00:00.000Z",
  basket: empty,
};
// @ts-expect-error Basket evidence cannot be omitted or defaulted to empty.
export const basketMissing: WooPendingCandidate = {
  source: "woocommerce", shopId: "woo-shop-1", checkoutToken: "checkout-key-1",
  lastEventId: "checkout-event-1", lastActivityAt: "2026-10-23T12:00:00.000Z",
};
export const wrongSource: WooPendingCandidate = {
  ...pending,
  // @ts-expect-error Unknown/Shopify sources cannot be labelled Woo.
  source: "shopify",
};
// @ts-expect-error Shop-scoped identity is immutable once accepted.
pending.shopId = "different-shop";
// @ts-expect-error Checkout identity is immutable once accepted.
pending.checkoutToken = "different-checkout";
export const fakeNonempty: WooBasketEvidence = {
  kind: "nonempty",
  checkout: {
    currency: "GBP", total: "0.00",
    // @ts-expect-error A known-nonempty basket needs at least one parsed item.
    items: [],
  },
};
export const fakeUnknown: WooBasketEvidence = {
  kind: "unknown",
  // @ts-expect-error Unknown cannot be treated as verified empty.
  reason: "empty",
};

// Absence of received order events cannot be equated with proven 'unpaid'.
export const noObservedOrder: WooTerminalObservation = { kind: "none-observed" };
export const placedOrder: WooTerminalObservation = {
  kind: "order-placed", orderId: parsedOrder.order.orderId,
};
// @ts-expect-error No successful observation does not mean 'order-unpaid'.
export const inventedUnpaid: WooTerminalObservation = { kind: "order-unpaid" };

// Each of the four business service fakes can be constructed without any
// BG001–BG005 implementation import; the dependency interfaces are independent.
export const candidateManager: WooCandidateManager = {
  async getPending(ref) {
    return ref.shopId === pending.shopId && ref.checkoutToken === pending.checkoutToken
      ? pending : null;
  },
  async cancelPending(_ref) { return "cancelled"; },
};
export const orderReader: WooObservedOrderStateReader = {
  async read(_ref) { return noObservedOrder; },
};
// Type conformance only: this no-lock fixture MUST NOT be used by live workers.
export const checkoutCoordinator: WooCheckoutCoordinator = {
  async withCheckoutLock<T>(_ref: WooCheckoutRef, run: () => Promise<T>): Promise<T> {
    return run();
  },
};
export const checkoutActivity: WooCheckoutActivityHandler = {
  async handleCheckout(event) {
    return { kind: "scheduled", dueAt: event.occurredAt };
  },
};
export const orderReconciler: WooOrderReconciler = {
  async reconcileOrder(_event) {
    return { kind: "placed-suppressed" };
  },
};
export const recoveryAdmission: WooRecoveryAdmissionEvaluator = {
  async evaluateMatured(candidate, context) {
    const result: WooAdmissionOutcome = {
      kind: "already-exists", recoveryId: "existing-recovery-1", status: "PENDING",
    };
    void candidate;
    void context;
    return result;
  },
};
export const outreach: WooRecoveryOutreachDispatcher = {
  async enqueueInitial(_recoveryId) {
    return { kind: "queued", attemptId: "attempt-1" };
  },
  async processInitial(_recoveryId) {
    return { kind: "sent", attemptId: "attempt-1" };
  },
};

// A successful dispatch requires an attempt ID, unlike suppression or deferral.
// @ts-expect-error 'sent' needs a durable attemptId.
export const sentWithoutAttempt: WooOutreachDispatchOutcome = { kind: "sent" };
export const suppressed: WooOutreachDispatchOutcome = { kind: "suppressed", reason: "STOP" };
