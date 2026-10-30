/** ARCH-049 ShopBrand JSONB v1. No separate asset table or queue acceptance point. */
import type { ShopBrandImageRole, ShopBrandMediaResult } from "../shop-brand-media/contracts.js";

export type BrandRole = ShopBrandImageRole;
export const BRAND_ROLES: readonly BrandRole[] = ["LOGO", "SQUARE_LOGO", "COVER_IMAGE"];
export const MEDIA_RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 86_400_000] as const;
export const MEDIA_MAX_ATTEMPTS = 5;
export const MEDIA_LEASE_MS = 10 * 60_000;
export const MEDIA_RECHECK_MS = 7 * 24 * 60 * 60_000;
export const MEDIA_SCAN_INTERVAL_MS = 5 * 60_000;

export type BrandStatus = "MISSING" | "PENDING" | "PROCESSING" | "READY" | "FAILED";

export interface SourceObservation {
  shopId: string;
  role: BrandRole;
  sourceUrl: string | null;
  sourceReference: string | null;
  sourceFingerprint: string | null;
  observedAt: string;
}

export interface BrandSource {
  url: string | null;
  reference: string | null;
  fingerprint: string | null;
  generation: number;
  observedAt: string;
}

export interface BrandRefresh {
  attempts: number;
  retryAfter: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  failureCode: string | null;
}

export interface BrandWork {
  status: BrandStatus;
  attempts: number;
  retryAfter: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  failureCode: string | null;
  lastCheckedAt: string | null;
  /** Refresh never changes work.status away from READY while a current verified image exists. */
  refresh?: BrandRefresh;
}

export interface BrandReady {
  sourceGeneration: number;
  sourceFingerprint: string;
  objectKey: string;
  contentType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  sizeBytes: number;
  contentSha256: string;
  verifiedAt: string;
}

export interface BrandSlot {
  source: BrandSource;
  work: BrandWork;
  ready: BrandReady | null;
}

/** Durable Shopify source-sync lease and cadence; not a media role or new table. */
export interface ShopifySourceSync {
  lastSuccessfulAt: string | null;
  nextDueAt: string | null;
  lastAttemptAt: string | null;
  attempts: number;
  failureCode: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
}

export interface BrandDocument {
  shopifySourceSync?: ShopifySourceSync;
  schemaVersion: 1;
  roles: Partial<Record<BrandRole, BrandSlot>>;
}

export interface BrandClaim {
  shopId: string;
  role: BrandRole;
  generation: number;
  fingerprint: string;
  sourceUrl: string;
  domain: string;
  leaseOwner: string;
  leaseUntil: string;
  kind: "initial" | "refresh";
}

export interface BrandOutcome {
  result: ShopBrandMediaResult;
  verifiedAt: string;
}

export class BrandStateError extends Error {
  constructor(readonly code: "INVALID_OBSERVATION" | "UNSUPPORTED_SCHEMA" | "INVALID_STORED_STATE") {
    super(code);
    this.name = "BrandStateError";
  }
}
