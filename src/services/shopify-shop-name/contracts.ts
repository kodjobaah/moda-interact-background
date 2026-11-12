export const NAME_REFRESH_MS = 24 * 60 * 60_000;
export const NAME_LEASE_MS = 2 * 60_000;
export const NAME_SCAN_MS = 5 * 60_000;
export const NAME_RETRY_MS = [60_000, 300_000, 1_800_000, 7_200_000, NAME_REFRESH_MS] as const;
export type NameClaim = Readonly<{ shopId: string; domain: string; installedAt: string; leaseOwner: string; leaseUntil: string }>;
export type NameSync = { lastSuccessfulAt: string | null; nextDueAt: string | null; attempts: number;
  failureCode: string | null; leaseOwner: string | null; leaseUntil: string | null };
export class ShopNameReadError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, readonly retryAfterMs = 0, options?: ErrorOptions) {
    super(code, options); this.name = "ShopNameReadError";
  }
}
