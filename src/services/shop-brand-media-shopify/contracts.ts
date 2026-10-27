/** ARCH-049 BG003: authenticated Shopify Admin brand source metadata only. */
export const SHOPIFY_BRAND_SYNC_INTERVAL_MS = 24 * 60 * 60_000;
export const SHOPIFY_BRAND_SYNC_SCAN_INTERVAL_MS = 5 * 60_000;
export const SHOPIFY_BRAND_SYNC_LEASE_MS = 2 * 60_000;
export const SHOPIFY_BRAND_SYNC_RETRY_MS = [60_000, 300_000, 1_800_000, 7_200_000, 86_400_000] as const;

export interface ShopifyBrandImage {
  url: string;
  /** Stable provider image identity, not an untrusted shop or URL identity. */
  reference: string;
  width: number;
  height: number;
}

export interface ShopifyBrandSnapshot {
  brandName: string;
  logo: ShopifyBrandImage | null;
  squareLogo: ShopifyBrandImage | null;
  coverImage: ShopifyBrandImage | null;
  observedAt: string;
}

export interface ShopifyBrandSyncClaim {
  shopId: string;
  shopDomain: string;
  leaseOwner: string;
  leaseUntil: string;
}

export type ShopifyBrandFailureCode =
  | "MISSING_READ_BRAND_SCOPE" | "NO_OFFLINE_SESSION" | "ACCESS_DENIED"
  | "SHOPIFY_THROTTLED" | "SHOPIFY_TIMEOUT" | "SHOPIFY_UNAVAILABLE"
  | "SHOPIFY_GRAPHQL_FAILURE" | "SHOPIFY_INVALID_RESPONSE" | "TOKEN_UNAVAILABLE";

/** Explicit bounded categories; no raw provider messages or response bodies in logs. */
export class ShopifyBrandSyncError extends Error {
  constructor(
    readonly code: ShopifyBrandFailureCode,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
  ) {
    super(code);
    this.name = "ShopifyBrandSyncError";
  }
}
