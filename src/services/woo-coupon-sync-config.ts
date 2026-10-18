/** ARCH-036 bounded worker-side configuration; all durations use explicit units. */
export interface WooCouponSyncConfig {
  dispatchBatchSize: number;
  refreshIntervalMinutes: number;
  dispatchCooldownMinutes: number;
  unavailableRecheckMinutes: number;
  staleScanMinutes: number;
  maxPages: number;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  maxScanDurationMs: number;
}

const limits = {
  dispatchBatchSize: [500, 1, 500],
  refreshIntervalMinutes: [30, 1, 1440],
  dispatchCooldownMinutes: [5, 1, 120],
  unavailableRecheckMinutes: [30, 1, 1440],
  staleScanMinutes: [15, 1, 120],
  maxPages: [50, 1, 200],
  requestTimeoutMs: [8000, 1000, 30000],
  maxResponseBytes: [1048576, 16384, 4194304],
  maxScanDurationMs: [120000, 30000, 600000],
} as const;

const variables: Record<keyof WooCouponSyncConfig, string> = {
  dispatchBatchSize: "WOO_COUPON_SYNC_DISPATCH_BATCH_SIZE",
  refreshIntervalMinutes: "WOO_COUPON_SYNC_REFRESH_MINUTES",
  dispatchCooldownMinutes: "WOO_COUPON_SYNC_DISPATCH_COOLDOWN_MINUTES",
  unavailableRecheckMinutes: "WOO_COUPON_SYNC_UNAVAILABLE_RECHECK_MINUTES",
  staleScanMinutes: "WOO_COUPON_SYNC_STALE_SCAN_MINUTES",
  maxPages: "WOO_COUPON_SYNC_MAX_PAGES",
  requestTimeoutMs: "WOO_COUPON_SYNC_REQUEST_TIMEOUT_MS",
  maxResponseBytes: "WOO_COUPON_SYNC_MAX_RESPONSE_BYTES",
  maxScanDurationMs: "WOO_COUPON_SYNC_MAX_SCAN_DURATION_MS",
};

export function loadWooCouponSyncConfig(environment: NodeJS.ProcessEnv = process.env): WooCouponSyncConfig {
  const values = {} as Record<keyof WooCouponSyncConfig, number>;
  for (const key of Object.keys(variables) as Array<keyof WooCouponSyncConfig>) {
    const [fallback, min, max] = limits[key];
    const raw = environment[variables[key]];
    const parsed = raw === undefined ? fallback : /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      throw new RangeError(`${variables[key]} must be a whole number between ${min} and ${max}`);
    }
    values[key] = parsed;
  }
  return values;
}


/** ARCH-043 DB policy must be closed and preserve ARCH-036 absolute safety limits. */
export function defaultWooCouponSyncConfig(): WooCouponSyncConfig {
  return Object.fromEntries(Object.entries(limits).map(([key, [fallback]]) => [key, fallback])) as unknown as WooCouponSyncConfig;
}
export function validateWooCouponSyncConfig(value: unknown): Readonly<WooCouponSyncConfig & { workerConcurrency: number }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RangeError("Invalid Woo coupon policy");
  const record = value as Record<string, unknown>;
  const keys = [...Object.keys(limits), "workerConcurrency"];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new RangeError("Invalid Woo coupon policy");
  }
  for (const [key, [, min, max]] of Object.entries(limits)) {
    const entry = record[key];
    if (!Number.isSafeInteger(entry) || (entry as number) < min || (entry as number) > max)
      throw new RangeError("Invalid Woo coupon policy");
  }
  const concurrency = record.workerConcurrency;
  if (!Number.isSafeInteger(concurrency) || (concurrency as number) < 1 || (concurrency as number) > 32)
    throw new RangeError("Invalid Woo coupon policy");
  return Object.freeze({ ...record }) as unknown as Readonly<WooCouponSyncConfig & { workerConcurrency: number }>;
}
