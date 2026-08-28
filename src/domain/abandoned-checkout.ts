// Repository-local truncated representation of the current Shopify abandoned
// checkout returned by the bounded abandoned-checkout lookup. This crosses no
// cross-repository service boundary and is kept narrow on purpose.
//
// Only the fields required by the existing CheckoutRecovery workflow are
// surfaced here. The Shopify-side abandoned-checkout identifier is carried for
// diagnostics only and must not be durably persisted as part of ARCH-001 scope.

import type { PendingRecoveryCandidate } from "./pending-recovery-candidate.js";

export const ABANDONED_CHECKOUT_API_VERSION = "2026-07";

// Highest number of Shopify abandoned-checkout records that may be inspected
// for a single candidate lookup. The count pre-check fails the lookup before
// any unbounded pagination is possible.
export const ABANDONED_CHECKOUT_MAX_CANDIDATES = 20;

// Narrow server-side time window (milliseconds) applied around
// candidate.checkoutCreatedAt when building the Shopify `created_at` filter.
// This keeps the query cheap and bounded while tolerating small clock skew
// between the webhook timestamp and Shopify's stored createdAt.
export const ABANDONED_CHECKOUT_LOOKUP_WINDOW_MS = 10 * 60 * 1000;

export interface AbandonedCheckoutLookupInput {
  shopId: string;
  shopDomain: string;
  checkoutToken: string;
  cartToken: string | null;
  abandonedCheckoutUrl: string | null;
  checkoutCreatedAt: string | null;
}

export function toLookupInput(
  candidate: PendingRecoveryCandidate,
  shopDomain: string,
): AbandonedCheckoutLookupInput {
  return {
    shopId: candidate.shopId,
    shopDomain,
    checkoutToken: candidate.checkoutToken,
    cartToken: candidate.cartToken,
    abandonedCheckoutUrl: candidate.abandonedCheckoutUrl,
    checkoutCreatedAt: candidate.checkoutCreatedAt,
  };
}

export type AbandonedCheckoutLookupOutcome =
  | { kind: "found"; checkout: NormalizedAbandonedCheckout }
  | { kind: "not-found" }
  | { kind: "ambiguous"; matched: number }
  | { kind: "bounded-limit-exceeded"; candidateCount: number }
  | { kind: "provider-error"; message: string };

export interface NormalizedAbandonedCheckoutCustomer {
  shopifyCustomerId: string | null;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
}

export interface NormalizedAbandonedCheckoutLineItem {
  productId: string | null;
  variantId: string | null;
  title: string | null;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  price: string | null;
}

export interface NormalizedAbandonedCheckout {
  // Diagnostic only. Not durably persisted by ARCH-001.
  shopifyAbandonedCheckoutId: string | null;

  abandonedCheckoutUrl: string;
  createdAt: string;

  // null when the checkout is still recoverable; non-null once completed so the
  // recovery flow can treat it as not recoverable.
  completedAt: string | null;

  currencyCode: string | null;
  totalPrice: string | null;

  customer: NormalizedAbandonedCheckoutCustomer | null;
  lineItems: NormalizedAbandonedCheckoutLineItem[];
}
