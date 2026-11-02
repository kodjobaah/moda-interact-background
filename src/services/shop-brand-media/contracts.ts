/** ARCH-049-BACKGROUND-001: one untrusted source in, one verified immutable image out. */
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

/** Bounded diagnostic provenance for provider/library failures; never retain a source URL or common secrets. */
export function boundedMediaProviderMessage(error: unknown): string | undefined {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  if (!raw) return undefined;
  const message = [...raw].map((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || code === 0x7f ? " " : character;
  }).join("")
    .replace(/\bhttps?:\/\/[^\s,;]+/gi, "[URL REDACTED]")
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(/((?:access.?key(?:.?id)?|secret.?key|session.?token|security.?token|token|password|signature|credential|api.?key)\s*[:=]\s*)[^\s,;&"'<>]+/gi, "$1[REDACTED]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[EMAIL REDACTED]")
    .replace(/\b(?:\+?\d[\d ().-]{7,}\d)\b/g, "[PHONE REDACTED]")
    .replace(/\s+/g, " ").trim().slice(0, 300);
  return message || undefined;
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
  fetch(url: string, signal?: AbortSignal): Promise<FetchedBrandSource>;
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
  verify(input: { url: string; image: VerifiedBrandImage }, signal?: AbortSignal): Promise<void>;
}

export type ShopBrandPublicMediaSettings = Readonly<{
  publicOrigin: string;
  bucketName: string;
}>;

const SHOP_BRAND_DOMAIN_SEGMENT = /^[A-Za-z0-9._-]+$/;
const ABSOLUTE_URL = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** Use URL.hostname for absolute URLs; preserve safe bare host-like values verbatim. */
export function normalizeShopBrandDomain(domain: string): string | null {
  if (typeof domain !== "string" || !domain || [...domain].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || code === 0x7f;
  })) return null;
  let segment = domain;
  if (ABSOLUTE_URL.test(domain)) {
    try {
      segment = new URL(domain).hostname;
    } catch {
      return null;
    }
  }
  if (!segment || segment.length > 253 || segment === "." || segment === ".." ||
      !SHOP_BRAND_DOMAIN_SEGMENT.test(segment)) return null;
  return segment;
}

export function isShopBrandDomainSegment(segment: string | undefined): segment is string {
  return typeof segment === "string" && normalizeShopBrandDomain(segment) === segment;
}

export function assertMediaInput(input: ShopBrandMediaInput): void {
  // Shop IDs originate from the trusted database. Still refuse path segments, separators and controls.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.shopId) ||
      normalizeShopBrandDomain(input.domain) === null ||
      !(["LOGO", "SQUARE_LOGO", "COVER_IMAGE"] as const).includes(input.role) ||
      !/^sha256:[a-f0-9]{64}$/.test(input.sourceFingerprint) ||
      !Number.isSafeInteger(input.sourceGeneration) || input.sourceGeneration < 1 ||
      typeof input.sourceUrl !== "string" || !input.sourceUrl) {
    throw new ShopBrandMediaError("INVALID_INPUT");
  }
}
