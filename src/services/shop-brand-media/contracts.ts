/** ARCH-049-BACKGROUND-001: one untrusted source in, one verified immutable image out. */
import { ShopBrandMediaError, type ShopBrandImageRole, type VerifiedBrandImage } from "@modainteract/moda-interact-shared/commerce/presentation/node";
export { SHOP_BRAND_CANVAS, SHOP_BRAND_MAX_SOURCE_BYTES, SHOP_BRAND_MAX_OUTPUT_BYTES, SHOP_BRAND_TARGET_OUTPUT_BYTES, SHOP_BRAND_MAX_INPUT_PIXELS, ShopBrandMediaError, boundedMediaProviderMessage, type ShopBrandImageRole, type ShopBrandImageMime, type ShopBrandMediaErrorCode, type VerifiedBrandImage, type FetchedBrandSource, type SafeFetcher, type ImageTransformer, type PublicMediaProbe } from "@modainteract/moda-interact-shared/commerce/presentation/node";

export interface ShopBrandMediaInput {
  shopId: string;
  domain: string;
  role: ShopBrandImageRole;
  sourceUrl: string;
  sourceFingerprint: string;
  sourceGeneration: number;
}

export type ShopBrandMediaResult = Omit<VerifiedBrandImage, "bytes"> & {
  objectKey: string;
  sourceFingerprint: string;
  sourceGeneration: number;
};

export interface ShopBrandMediaProcessor {
  process(input: ShopBrandMediaInput): Promise<ShopBrandMediaResult>;
}

export interface R2ObjectWriter {
  putVerified(input: {
    bucket: string;
    objectKey: string;
    image: VerifiedBrandImage;
  }): Promise<void>;
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
