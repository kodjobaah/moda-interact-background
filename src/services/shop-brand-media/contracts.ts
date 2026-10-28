/** ARCH-049-BACKGROUND-001: one untrusted source in, one verified immutable image out. */
import { isIP } from "node:net";

export const SHOP_BRAND_CANVAS = Object.freeze({ width: 1125, height: 600 });
export const SHOP_BRAND_MAX_SOURCE_BYTES = 10 * 1024 * 1024;
export const SHOP_BRAND_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
export const SHOP_BRAND_TARGET_OUTPUT_BYTES = 1024 * 1024;
export const SHOP_BRAND_MAX_INPUT_PIXELS = 40_000_000;

export type ShopBrandImageRole = "LOGO" | "SQUARE_LOGO" | "COVER_IMAGE";
export type ShopBrandImageMime = "image/jpeg" | "image/png";

export type ShopBrandMediaErrorCode =
  | "INVALID_INPUT" | "UNSAFE_SOURCE" | "DNS_FAILURE" | "DNS_TEMPORARY_FAILURE"
  | "SOURCE_TIMEOUT" | "SOURCE_HTTP_FAILURE" | "SOURCE_UNAVAILABLE"
  | "SOURCE_TOO_LARGE" | "UNSUPPORTED_ENCODING" | "INVALID_IMAGE"
  | "INPUT_PIXELS_EXCEEDED" | "OUTPUT_TOO_LARGE" | "OUTPUT_VERIFICATION_FAILED"
  | "R2_CONFIGURATION_INVALID" | "R2_UNAVAILABLE" | "R2_OBJECT_MISMATCH"
  | "PUBLIC_MEDIA_UNAVAILABLE" | "PUBLIC_MEDIA_MISMATCH"
  | "UNEXPECTED_FAILURE";

/** The message is a bounded code, not a provider exception or a URL containing credentials. */
export class ShopBrandMediaError extends Error {
  constructor(readonly code: ShopBrandMediaErrorCode, readonly retryable = false,
    readonly providerMessage?: string) {
    super(code);
    this.name = "ShopBrandMediaError";
  }
}

export interface ShopBrandMediaInput {
  shopId: string;
  domain: string;
  role: ShopBrandImageRole;
  sourceUrl: string;
  sourceFingerprint: string;
  sourceGeneration: number;
}

export interface VerifiedBrandImage {
  bytes: Buffer;
  contentType: ShopBrandImageMime;
  width: number;
  height: number;
  sizeBytes: number;
  contentSha256: string;
}

export type ShopBrandMediaResult = Omit<VerifiedBrandImage, "bytes"> & {
  objectKey: string;
  sourceFingerprint: string;
  sourceGeneration: number;
};

export interface ShopBrandMediaProcessor {
  process(input: ShopBrandMediaInput): Promise<ShopBrandMediaResult>;
}

export interface FetchedBrandSource {
  bytes: Buffer;
  /** The response's declared type; never trusted for decoding. */
  declaredContentType: string | null;
}

export interface SafeFetcher {
  fetch(url: string): Promise<FetchedBrandSource>;
}

export interface ImageTransformer {
  transform(bytes: Buffer, role: ShopBrandImageRole): Promise<VerifiedBrandImage>;
}

export interface R2ObjectWriter {
  putVerified(input: {
    bucket: string;
    objectKey: string;
    image: VerifiedBrandImage;
  }): Promise<void>;
}

export interface PublicMediaProbe {
  verify(input: { url: string; image: VerifiedBrandImage }): Promise<void>;
}

export type ShopBrandPublicMediaSettings = Readonly<{
  publicOrigin: string;
  bucketName: string;
}>;

/** Shop.domain is a single lowercase DNS hostname, never a URL or arbitrary path segment. */
export function isCanonicalShopBrandDomain(domain: unknown): domain is string {
  if (typeof domain !== "string" || domain.length > 253 || domain !== domain.toLowerCase() ||
      !domain.includes(".") || domain.endsWith(".") || isIP(domain) !== 0) return false;
  return domain.split(".").every((label) => label.length >= 1 && label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}

export function assertMediaInput(input: ShopBrandMediaInput): void {
  // Shop IDs originate from the trusted database. Still refuse path segments, separators and controls.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.shopId) ||
      !isCanonicalShopBrandDomain(input.domain) ||
      !(["LOGO", "SQUARE_LOGO", "COVER_IMAGE"] as const).includes(input.role) ||
      !/^sha256:[a-f0-9]{64}$/.test(input.sourceFingerprint) ||
      !Number.isSafeInteger(input.sourceGeneration) || input.sourceGeneration < 1 ||
      typeof input.sourceUrl !== "string" || !input.sourceUrl) {
    throw new ShopBrandMediaError("INVALID_INPUT");
  }
}
