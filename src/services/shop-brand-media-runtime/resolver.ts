import { readShopBrandPublicMediaConfiguration } from "../platform-configuration/consumers.js";
import { normalizeShopBrandDomain } from "../shop-brand-media/contracts.js";
import type {
  BrandMediaResolver, ReadyBrandMedia,
} from "../recovery-template-preparation/recovery-template.types.js";
import {
  isShopBrandMediaRole, type ShopBrandMediaReader, type ShopBrandMediaRole,
} from "./contracts.js";
import { PrismaShopBrandMediaReader } from "./repository.js";

const FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const SHOP_ID = /^[A-Za-z0-9_-]{1,128}$/;
const OUTPUT_LIMIT = 5 * 1024 * 1024;
const CANVAS = { width: 1125, height: 600 } as const;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A broken platform configuration is operational failure, never merchant media. */
export function verifiedPublicMediaOrigin(value: unknown): URL {
  if (typeof value !== "string" || !URL.canParse(value)) {
    throw new Error("SHOPBRAND_PUBLIC_ORIGIN_INVALID");
  }
  const origin = new URL(value);
  if (origin.protocol !== "https:" || !origin.hostname.includes(".") ||
      origin.username || origin.password || origin.search || origin.hash ||
      origin.pathname !== "/" || origin.href !== `${origin.origin}/` ||
      origin.port || origin.hostname.startsWith("[") ||
      /^\d+(?:\.\d+){3}$/.test(origin.hostname) ||
      /\.(?:test|local|localhost|invalid|example|internal)$/.test(origin.hostname)) {
    throw new Error("SHOPBRAND_PUBLIC_ORIGIN_INVALID");
  }
  return origin;
}

/**
 * Resolve ONLY BG002's durable current-generation READY output. In particular
 * an older `ready` slot retained across a new source/refresh must never be sent.
 * This function is pure: it does no provider, HEAD, image or R2 operations.
 */
export function verifiedReadyMedia(input: {
  shopId: string; domain: string; role: ShopBrandMediaRole; whatsAppMedia: unknown; publicOrigin: URL;
}): ReadyBrandMedia | null {
  const { shopId, domain, role, whatsAppMedia, publicOrigin } = input;
  const domainSegment = normalizeShopBrandDomain(domain);
  if (!SHOP_ID.test(shopId) || !isShopBrandMediaRole(role) ||
      !domainSegment ||
      publicOrigin.protocol !== "https:" || publicOrigin.pathname !== "/" ||
      publicOrigin.username || publicOrigin.password || publicOrigin.search || publicOrigin.hash ||
      !isRecord(whatsAppMedia) || whatsAppMedia.schemaVersion !== 1 ||
      !isRecord(whatsAppMedia.roles) || !Object.hasOwn(whatsAppMedia.roles, role)) return null;
  const slot = whatsAppMedia.roles[role];
  if (!isRecord(slot) || !isRecord(slot.source) || !isRecord(slot.work) ||
      !isRecord(slot.ready)) return null;
  const { source, work, ready } = slot;
  if (work.status !== "READY" || typeof source.url !== "string" || !source.url.trim() ||
      !Number.isSafeInteger(source.generation) || (source.generation as number) < 1 ||
      typeof source.fingerprint !== "string" || !FINGERPRINT.test(source.fingerprint) ||
      ready.sourceGeneration !== source.generation || ready.sourceFingerprint !== source.fingerprint ||
      (ready.contentType !== "image/jpeg" && ready.contentType !== "image/png") ||
      ready.width !== CANVAS.width || ready.height !== CANVAS.height ||
      !Number.isSafeInteger(ready.sizeBytes) || (ready.sizeBytes as number) <= 0 ||
      (ready.sizeBytes as number) >= OUTPUT_LIMIT ||
      typeof ready.contentSha256 !== "string" || !DIGEST.test(ready.contentSha256) ||
      typeof ready.verifiedAt !== "string" || !Number.isFinite(Date.parse(ready.verifiedAt))) return null;

  const extension = ready.contentType === "image/jpeg" ? "jpg" : "png";
  const objectKey = `shop-brands/${domainSegment}/${role.toLowerCase()}/sha256-${ready.contentSha256}.${extension}`;
  if (ready.objectKey !== objectKey) return null;
  // Exact key, not URL interpolation from merchant fields; cannot escape publicOrigin.
  const url = new URL(objectKey, publicOrigin);
  if (url.origin !== publicOrigin.origin || url.search || url.hash ||
      !url.pathname.startsWith("/shop-brands/")) return null;
  return { shopId, role, status: "READY", kind: "R2_DERIVATIVE", httpsUrl: url.href };
}

export class ShopBrandReadyMediaAdapter {
  // One policy snapshot for the lifetime of this preparation. Production
  // constructs a fresh adapter per prepare() so configuration is never stale.
  private originPromise: Promise<URL> | undefined;

  constructor(
    private readonly repository: ShopBrandMediaReader = new PrismaShopBrandMediaReader(),
    private readonly readSettings: () => Promise<{ publicOrigin: string }> =
      readShopBrandPublicMediaConfiguration,
  ) {}

  private origin(): Promise<URL> {
    this.originPromise ??= this.readSettings().then((settings) =>
      verifiedPublicMediaOrigin(settings.publicOrigin));
    return this.originPromise;
  }

  /** Untrusted inputs fail closed before any database read. */
  readonly resolve: BrandMediaResolver = async (shopId, role) => {
    if (!SHOP_ID.test(shopId) || !isShopBrandMediaRole(role)) return null;
    const origin = await this.origin();
    const brand = await this.repository.readForShop(shopId);
    if (!brand || brand.shopId !== shopId || typeof brand.domain !== "string") return null;
    return verifiedReadyMedia({ shopId, domain: brand.domain, role,
      whatsAppMedia: brand.whatsAppMedia, publicOrigin: origin });
  };

  /** Hosts come exclusively from Admin's validated policy, never merchant input. */
  readonly approvedHosts = async (): Promise<readonly string[]> => {
    const origin = await this.origin();
    return [origin.hostname];
  };
}

/** Keep configuration live: a new adapter per preparation, never a global policy cache. */
export function createProductionShopBrandMediaAdapter() {
  return new ShopBrandReadyMediaAdapter();
}
