/** Provider-confirmation retries start AFTER the merchant's inactivity delay.
 * This is not the merchant's recoveryDelayMinutes and does not alter BullMQ's
 * normal exception retry policy (3 attempts / 1s exponential backoff).
 */
export const SHOPIFY_VERIFICATION_DELAYS_MS = [
  2 * 60_000, 4 * 60_000, 8 * 60_000, 16 * 60_000, 20 * 60_000,
] as const;
export const SHOPIFY_VERIFICATION_HORIZON_MS = 60 * 60_000;
export const SHOPIFY_VERIFICATION_INDEX_CUSHION_MS = 10 * 60_000;

export type ShopifyVerificationState = {
  firstAttemptAtMs: number;
  deferrals: number;
};

/** Invalid or exhausted state always stops; never restart an old retry clock. */
export function nextShopifyVerificationRetry(
  state: ShopifyVerificationState | undefined,
  now: number,
): { dueAtMs: number; state: ShopifyVerificationState } | null {
  if (!Number.isSafeInteger(now) || now < 0) return null;
  const first = state?.firstAttemptAtMs ?? now;
  const priorDeferrals = state?.deferrals ?? 0;
  if (!Number.isSafeInteger(first) || first < 0 || first > now ||
      !Number.isInteger(priorDeferrals) || priorDeferrals < 0 ||
      priorDeferrals >= SHOPIFY_VERIFICATION_DELAYS_MS.length) return null;
  const delay = SHOPIFY_VERIFICATION_DELAYS_MS[priorDeferrals]!;
  const dueAtMs = now + delay;
  if (dueAtMs > first + SHOPIFY_VERIFICATION_HORIZON_MS) return null;
  return { dueAtMs, state: { firstAttemptAtMs: first, deferrals: priorDeferrals + 1 } };
}

/** Shopify index retention includes inactivity, provider visibility, and safety cushion.
 * WooCommerce passes its own retentionMs and keeps its existing policy.
 */
export function shopifyCandidateIndexTtlMs(
  inactivityMinutes: number, normalTtlMs: number, now: number, dueAtMs: number,
) {
  return Math.max(normalTtlMs,
    inactivityMinutes * 60_000 + SHOPIFY_VERIFICATION_HORIZON_MS + SHOPIFY_VERIFICATION_INDEX_CUSHION_MS,
    Math.max(0, dueAtMs - now) + SHOPIFY_VERIFICATION_INDEX_CUSHION_MS);
}
