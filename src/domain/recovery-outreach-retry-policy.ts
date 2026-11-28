/** Delivery recovery policy is independent of credit compensation. A returned
 * decision is never authorization to send; every retry needs a new permit.
 */
export type RecoveryOutreachRetryDecision =
  | { policy: "AFTER_COOLDOWN" | "PROVIDER_POLICY_HOLD"; notBeforeAt: Date }
  | {
      policy: "REPAIR_REQUIRED" | "REVIEW_REQUIRED" | "DO_NOT_RETRY";
      notBeforeAt: null;
    };

const MINUTE_MS = 60_000;
const POSTGRES_INT_MAX = 2_147_483_647;
// This is a conservative safety floor, not a provider guarantee. The actual
// marketing cooldown is configured and policy clearance is still mandatory.
const MARKETING_MINIMUM_MINUTES = 24 * 60;

export type RecoveryDeliveryRetryConfig = {
  recoveryDeliveryTemporaryRetryDelayMinutes: number;
  recoveryDeliveryRateLimitRetryDelayMinutes: number;
  recoveryDeliveryMarketingRetryDelayMinutes: number;
  recoveryDeliveryMaxRetries: number;
};

export function isValidRecoveryDeliveryRetryConfig(
  config: unknown,
): config is RecoveryDeliveryRetryConfig {
  if (!config || typeof config !== "object") return false;
  const row = config as Record<string, unknown>;
  const valid = (key: keyof RecoveryDeliveryRetryConfig, minimum: number) => {
    const value = row[key];
    return (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= minimum &&
      value <= POSTGRES_INT_MAX
    );
  };
  return (
    valid("recoveryDeliveryTemporaryRetryDelayMinutes", 1) &&
    valid("recoveryDeliveryRateLimitRetryDelayMinutes", 1) &&
    valid(
      "recoveryDeliveryMarketingRetryDelayMinutes",
      MARKETING_MINIMUM_MINUTES,
    ) &&
    valid("recoveryDeliveryMaxRetries", 0)
  );
}

function cooldown(
  policy: "AFTER_COOLDOWN" | "PROVIDER_POLICY_HOLD",
  failedAt: Date,
  minutes: number,
): RecoveryOutreachRetryDecision {
  const notBeforeAt = new Date(failedAt.getTime() + minutes * MINUTE_MS);
  return Number.isFinite(notBeforeAt.getTime())
    ? { policy, notBeforeAt }
    : { policy: "REVIEW_REQUIRED", notBeforeAt: null };
}
const temporaryServiceCodes = new Set([
  "2",
  "131000",
  "131016",
  "131057",
  "133004",
]);
const rateLimitCodes = new Set(["4", "80007", "130429", "131056"]);
const repairCodes = new Set([
  "100",
  "190",
  "10",
  "200",
  "368",
  "131005",
  "131008",
  "131009",
  "131030",
  "131031",
  "131042",
  "131045",
  "131047",
  "131048",
  "131051",
  "131052",
  "131053",
  "132000",
  "132001",
  "132005",
  "132007",
  "132012",
  "132015",
  "132016",
  "133010",
]);
const noAutomaticRetryCodes = new Set(["131021", "131026", "131050"]);

/** Base the cooldown on durable failure time, not webhook replay time. 131049
 * requires policy clearance in addition to the configured cooldown;
 * neither the configured delay nor the safety floor establishes provider clearance.
 * Unknown and code-less failures never silently become retryable sends.
 */
export function decideRecoveryOutreachRetry(
  providerCode: string | null,
  failedAt: Date,
  config: RecoveryDeliveryRetryConfig | null,
): RecoveryOutreachRetryDecision {
  if (!Number.isFinite(failedAt.getTime()))
    return { policy: "REVIEW_REQUIRED", notBeforeAt: null };
  if (providerCode && noAutomaticRetryCodes.has(providerCode))
    return { policy: "DO_NOT_RETRY", notBeforeAt: null };
  // Missing, invalid or disabled recycling never creates an eligible retry.
  // This decision does not gate the caller's credit compensation.
  if (
    !isValidRecoveryDeliveryRetryConfig(config) ||
    config.recoveryDeliveryMaxRetries === 0
  ) {
    return { policy: "REVIEW_REQUIRED", notBeforeAt: null };
  }
  if (providerCode === "131049")
    return cooldown(
      "PROVIDER_POLICY_HOLD",
      failedAt,
      config.recoveryDeliveryMarketingRetryDelayMinutes,
    );
  if (providerCode && temporaryServiceCodes.has(providerCode))
    return cooldown(
      "AFTER_COOLDOWN",
      failedAt,
      config.recoveryDeliveryTemporaryRetryDelayMinutes,
    );
  if (providerCode && rateLimitCodes.has(providerCode))
    return cooldown(
      "AFTER_COOLDOWN",
      failedAt,
      config.recoveryDeliveryRateLimitRetryDelayMinutes,
    );
  if (providerCode && repairCodes.has(providerCode))
    return { policy: "REPAIR_REQUIRED", notBeforeAt: null };
  return { policy: "REVIEW_REQUIRED", notBeforeAt: null };
}
