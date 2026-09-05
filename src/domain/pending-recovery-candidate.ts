export const PENDING_RECOVERY_CANDIDATE_QUEUE = "pending-recovery-candidates";
export const EVALUATE_PENDING_RECOVERY_JOB = "evaluate-pending-recovery";

export const DEFAULT_RECOVERY_DELAY_MINUTES = 30;
const RECOVERY_CANDIDATE_TTL_BUFFER_MS = 60 * 60 * 1000;

export type PendingRecoveryCandidate = {
  shopId: string;
  shopDomain: string;
  checkoutToken: string;
  cartToken: string | null;
  abandonedCheckoutUrl: string | null;
  checkoutCreatedAt: string | null;
};

export function pendingCandidateCheckoutIndexKey(input: {
  shopId: string;
  checkoutToken: string;
}) {
  return `pending-recovery:index:checkout:${input.shopId}:${input.checkoutToken}`;
}

export function pendingCandidateCartIndexKey(input: {
  shopId: string;
  cartToken: string;
}) {
  return `pending-recovery:index:cart:${input.shopId}:${input.cartToken}`;
}

export function pendingCandidateShopIndexKey(shopId: string) {
  return `pending-recovery:index:shop:${shopId}`;
}

// Checkout-scoped order/materialization coordination keys (ARCH-001-BACKGROUND-005).
// These are transient Redis keys used only to prevent an order that completes a
// checkout from racing a recovery message for the same checkout.

// Distributed mutex that serialises the order path and the candidate
// materialization path for one checkout (shopId + checkoutToken).
export function checkoutOrderLockKey(input: {
  shopId: string;
  checkoutToken: string;
}) {
  return `pending-recovery:lock:${input.shopId}:${input.checkoutToken}`;
}

// Short-lived tombstone written when an order for a checkout has been
// processed. The materialization path reads it to suppress creating a recovery
// (and sending a recovery message) for a checkout that already completed.
export function checkoutOrderCompletedKey(input: {
  shopId: string;
  checkoutToken: string;
}) {
  return `pending-recovery:order-completed:${input.shopId}:${input.checkoutToken}`;
}

export function pendingCandidateIndexTtlMs(delayMinutes: number): number {
  return Math.max(
    delayMinutes * 60_000 + RECOVERY_CANDIDATE_TTL_BUFFER_MS,
    RECOVERY_CANDIDATE_TTL_BUFFER_MS,
  );
}

