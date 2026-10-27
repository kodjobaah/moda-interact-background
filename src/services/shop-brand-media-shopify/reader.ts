import { createHash } from "node:crypto";
import { getShopifyAccessToken } from "../shopify-session.service.js";
import {
  ShopifyBrandSyncError, type ShopifyBrandImage, type ShopifyBrandSnapshot,
} from "./contracts.js";

/** Match the installed provider conventions. No Storefront API or unsupported brand.squareLogo. */
export const SHOPIFY_BRAND_API_VERSION = "2026-07";
const SHOP_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/;
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

/** BrandingBrand.logo(assetType) supports square assets; this is an alias, not a field. */
export const SHOPIFY_BRAND_QUERY = `#graphql
query ModaShopBrandSources {
  shop {
    name
    brand {
      logo(assetType: DEFAULT_LOGO) { id mediaImageId originalSrc width height }
      squareLogo: logo(assetType: SQUARE_LOGO) { id mediaImageId originalSrc width height }
      coverImage { id mediaImageId originalSrc width height }
    }
  }
}`;

type FetchPort = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface ShopifyBrandReader {
  read(shopDomain: string, observedAt: Date): Promise<ShopifyBrandSnapshot>;
}

export class ShopifyAdminBrandReader implements ShopifyBrandReader {
  constructor(private readonly deps: {
    accessToken?: (domain: string) => Promise<string>;
    fetchImpl?: FetchPort;
    timeoutMs?: number;
  } = {}) {
    const ms = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > 30_000) {
      throw new RangeError("INVALID_SHOPIFY_BRAND_TIMEOUT");
    }
  }

  async read(shopDomain: string, observedAt: Date): Promise<ShopifyBrandSnapshot> {
    if (!SHOP_DOMAIN.test(shopDomain) || !Number.isFinite(observedAt.getTime())) {
      throw new ShopifyBrandSyncError("SHOPIFY_INVALID_RESPONSE", false);
    }
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Bound token acquisition as well as the outbound request and response body.
      const token = await raceAbort(
        (this.deps.accessToken ?? getShopifyAccessToken)(shopDomain), controller.signal,
      ).catch((error: unknown) => {
        if (controller.signal.aborted) throw new ShopifyBrandSyncError("SHOPIFY_TIMEOUT", true);
        // Offline-session errors may contain domains or token-provider details. Never propagate them.
        void error;
        throw new ShopifyBrandSyncError("TOKEN_UNAVAILABLE", true);
      });
      if (!token) throw new ShopifyBrandSyncError("TOKEN_UNAVAILABLE", true);
      const response = await raceAbort((this.deps.fetchImpl ?? fetch)(
        `https://${shopDomain}/admin/api/${SHOPIFY_BRAND_API_VERSION}/graphql.json`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
          body: JSON.stringify({ query: SHOPIFY_BRAND_QUERY }), signal: controller.signal,
        }), controller.signal);
      if (response.status === 401) {
        throw new ShopifyBrandSyncError("ACCESS_DENIED", false);
      }
      if (response.status === 403) {
        throw new ShopifyBrandSyncError("MISSING_READ_BRAND_SCOPE", false);
      }
      if (response.status === 429) {
        throw new ShopifyBrandSyncError("SHOPIFY_THROTTLED", true, parseRetryAfter(response.headers.get("retry-after")));
      }
      if (!response.ok) throw new ShopifyBrandSyncError("SHOPIFY_UNAVAILABLE", response.status >= 500);
      const body = await raceAbort(readBoundedJson(response), controller.signal);
      const record = asRecord(body);
      if (!record) throw new ShopifyBrandSyncError("SHOPIFY_INVALID_RESPONSE", false);
      if (record.errors !== undefined && !Array.isArray(record.errors)) {
        throw new ShopifyBrandSyncError("SHOPIFY_INVALID_RESPONSE", false);
      }
      const errors = Array.isArray(record.errors) ? record.errors : [];
      if (errors.length) {
        const codes = errors.map((entry) => {
          const value = asRecord(entry);
          return asRecord(value?.extensions)?.code;
        });
        if (codes.includes("THROTTLED") || codes.includes("MAX_COST_EXCEEDED")) {
          throw new ShopifyBrandSyncError("SHOPIFY_THROTTLED", true);
        }
        if (codes.includes("ACCESS_DENIED") || codes.includes("FORBIDDEN")) {
          throw new ShopifyBrandSyncError("MISSING_READ_BRAND_SCOPE", false);
        }
        throw new ShopifyBrandSyncError("SHOPIFY_GRAPHQL_FAILURE", true);
      }
      const shop = asRecord(asRecord(record.data)?.shop);
      if (!shop || typeof shop.name !== "string" || !shop.name.trim() ||
          shop.name.length > 2048 || !(shop.brand === null || asRecord(shop.brand))) {
        throw new ShopifyBrandSyncError("SHOPIFY_INVALID_RESPONSE", false);
      }
      const brand = asRecord(shop.brand);
      // Missing fields are not the same as explicitly null media. A truncated or
      // partially changed GraphQL response must never mark known sources MISSING.
      if (brand && !["logo", "squareLogo", "coverImage"].every((key) =>
          Object.prototype.hasOwnProperty.call(brand, key))) {
        throw new ShopifyBrandSyncError("SHOPIFY_INVALID_RESPONSE", false);
      }
      return {
        brandName: shop.name.trim(),
        logo: parseImage(brand?.logo ?? null),
        squareLogo: parseImage(brand?.squareLogo ?? null),
        coverImage: parseImage(brand?.coverImage ?? null),
        observedAt: observedAt.toISOString(),
      };
    } catch (error) {
      if (error instanceof ShopifyBrandSyncError) throw error;
      // Abort/network/JSON errors are not proof of absent branding.
      throw new ShopifyBrandSyncError(controller.signal.aborted ? "SHOPIFY_TIMEOUT" : "SHOPIFY_UNAVAILABLE", true);
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseImage(value: unknown): ShopifyBrandImage | null {
  if (value === null) return null;
  const image = asRecord(value);
  if (!image || typeof image.id !== "string" || image.id.length > 512 || !image.id ||
      typeof image.mediaImageId !== "string" || !image.mediaImageId || image.mediaImageId.length > 512 ||
      typeof image.originalSrc !== "string" || image.originalSrc.length > 16_384 ||
      !Number.isSafeInteger(image.width) || (image.width as number) <= 0 ||
      !Number.isSafeInteger(image.height) || (image.height as number) <= 0) {
    throw new ShopifyBrandSyncError("SHOPIFY_INVALID_RESPONSE", false);
  }
  try {
    const url = new URL(image.originalSrc);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname ||
        url.port || url.hash) throw new Error("INVALID_SOURCE_URL");
  } catch {
    throw new ShopifyBrandSyncError("SHOPIFY_INVALID_RESPONSE", false);
  }
  return {
    url: image.originalSrc,
    reference: `shopify:sha256:${createHash("sha256").update(JSON.stringify([image.id, image.mediaImageId])).digest("hex")}`,
    width: image.width as number,
    height: image.height as number,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(86_400_000, Math.ceil(seconds * 1_000));
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.min(86_400_000, Math.max(0, time - Date.now())) : null;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const len = response.headers.get("content-length");
  if (len !== null && Number(len) > MAX_RESPONSE_BYTES) {
    throw new ShopifyBrandSyncError("SHOPIFY_INVALID_RESPONSE", false);
  }
  if (!response.body) throw new ShopifyBrandSyncError("SHOPIFY_INVALID_RESPONSE", false);
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new ShopifyBrandSyncError("SHOPIFY_INVALID_RESPONSE", false);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  } catch {
    throw new ShopifyBrandSyncError("SHOPIFY_INVALID_RESPONSE", false);
  }
  return parsed;
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new ShopifyBrandSyncError("SHOPIFY_TIMEOUT", true);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ShopifyBrandSyncError("SHOPIFY_TIMEOUT", true));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}
