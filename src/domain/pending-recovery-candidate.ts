export const PENDING_RECOVERY_CANDIDATE_QUEUE = "pending-recovery-candidates";
export const EVALUATE_PENDING_RECOVERY_JOB = "evaluate-pending-recovery";

export const DEFAULT_RECOVERY_DELAY_MINUTES = 30;
const RECOVERY_CANDIDATE_TTL_BUFFER_MS = 60 * 60 * 1000;

export type PendingRecoveryCandidate = {
  shopId: string;
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

export function pendingCandidateIndexTtlMs(delayMinutes: number): number {
  return Math.max(
    delayMinutes * 60_000 + RECOVERY_CANDIDATE_TTL_BUFFER_MS,
    RECOVERY_CANDIDATE_TTL_BUFFER_MS,
  );
}
