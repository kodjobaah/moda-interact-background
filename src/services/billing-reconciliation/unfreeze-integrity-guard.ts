import { SubscriptionProjectionStatus } from "@prisma/client";

// Persist provenance in the existing error-code field: a later UPDATED event
// must not erase the identity of an unresolved unfreeze failure. Ordinary
// cycle reconciliation uses the unprefixed codes and is NOT an unfreeze retry.
export const UNRESOLVED_UNFREEZE_ACCOUNTING_ERRORS = [
  "UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT",
  "UNFREEZE_LIFETIME_FREE_COUNTER_HISTORY_CONFLICT",
  "UNFREEZE_PRE_CLOSE_USAGE_FLUSH_FAILED",
] as const;

const SOURCE_ACCOUNTING_ERRORS = [
  "BILLING_PERIOD_PLAN_CONFLICT",
  "LIFETIME_FREE_COUNTER_HISTORY_CONFLICT",
  "PRE_CLOSE_USAGE_FLUSH_FAILED",
] as const;

export function isUnresolvedUnfreezeAccountingError(
  code: string | null,
): boolean {
  return (
    code !== null &&
    (SOURCE_ACCOUNTING_ERRORS.some((error) => error === code) ||
      UNRESOLVED_UNFREEZE_ACCOUNTING_ERRORS.some((error) => error === code))
  );
}

export function unfreezeAccountingErrorCode(code: string): string {
  return (
    UNRESOLVED_UNFREEZE_ACCOUNTING_ERRORS.find((error) => error === code) ??
    (SOURCE_ACCOUNTING_ERRORS.some((error) => error === code)
      ? `UNFREEZE_${code}`
      : code)
  );
}

export function isBlockedUnfreezeAccountingState(subscription: {
  status: SubscriptionProjectionStatus;
  lastSyncErrorCode: string | null;
}): boolean {
  return (
    (subscription.status === SubscriptionProjectionStatus.SYNC_ERROR ||
      subscription.status === SubscriptionProjectionStatus.FROZEN) &&
    subscription.lastSyncErrorCode !== null &&
    UNRESOLVED_UNFREEZE_ACCOUNTING_ERRORS.some(
      (code) => code === subscription.lastSyncErrorCode,
    )
  );
}

/** A prior UNFROZEN accounting failure is durable evidence of the attempted
 * restoration. After an administrator repairs the SAME billing period, later
 * routine provider events can trigger read-only revalidation without waiting
 * for Shopify to emit an otherwise redundant UNFROZEN event. A new FROZEN
 * state never qualifies and no other accounting error is auto-cleared.
 */
export function canRevalidateRepairedUnfreezePeriod(
  subscription: {
    status: SubscriptionProjectionStatus;
    lastSyncErrorCode: string | null;
  },
  lifecycleState: string,
): boolean {
  return (
    subscription.status === SubscriptionProjectionStatus.SYNC_ERROR &&
    subscription.lastSyncErrorCode ===
      "UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT" &&
    ["UPDATED", "CREATED", "CANCELLATION_SCHEDULED"].includes(lifecycleState)
  );
}
