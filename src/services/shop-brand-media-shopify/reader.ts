import { createHash } from "node:crypto";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { ShopifyBrandSyncError, type ShopifyBrandSyncClaim, type ShopifyBrandSnapshot, type ShopifyBrandImage } from "./contracts.js";
/** Pinned stable public Storefront schema; never an authenticated Admin source. */
export const SHOPIFY_BRAND_API_VERSION = "2026-07";
const SHOP_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/;
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const logger = createLogger({ serviceName: "moda-recovery-worker", environment: resolveDeploymentEnvironmentName() });

/** Public brand media only; no cookies, credentials or protected customer fields. */
export const SHOPIFY_BRAND_QUERY = `query ModaPublicBrandSources { shop { brand {
  logo { id image { url width height } }
  squareLogo { id image { url width height } }
  coverImage { id image { url width height } }
} } }`;

type FetchPort = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface ShopifyBrandReader {
  read(claim: ShopifyBrandSyncClaim): Promise<ShopifyBrandSnapshot>;
}

export class ShopifyPublicBrandReader implements ShopifyBrandReader {
  constructor(private readonly deps: {
    fetchImpl?: FetchPort;
    timeoutMs?: number;
    logger?: Pick<StructuredLogger, "warn">;
  } = {}) {
    const ms = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > 30_000) {
      throw new RangeError("INVALID_SHOPIFY_BRAND_TIMEOUT");
    }
  }

  async read(claim: ShopifyBrandSyncClaim): Promise<ShopifyBrandSnapshot> {
    const shopDomain = claim.shopDomain;
    if (!SHOP_DOMAIN.test(shopDomain)) {
      throw new ShopifyBrandSyncError("SHOPIFY_INVALID_RESPONSE", false);
    }
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const observedAt = new Date().toISOString();
      const response = await raceAbort((this.deps.fetchImpl ?? fetch)(
        `https://${shopDomain}/api/${SHOPIFY_BRAND_API_VERSION}/graphql.json`, {
          method: "POST", redirect: "error", credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: SHOPIFY_BRAND_QUERY }), signal: controller.signal,
        }), controller.signal);
      if (!response.ok) {
        let errors: unknown = null;
        try { errors = asRecord(await raceAbort(readBoundedJson(response), controller.signal))?.errors; } catch { /* Unsafe or unparseable provider error text is redacted. */ }
        this.logFailure({ origin: "provider_response", httpStatus: response.status,
          ...(Array.isArray(errors) ? safeProviderErrors(errors) : { providerErrorBody: "[REDACTED]", redactionApplied: true, truncated: false }) });
        if (Array.isArray(errors) && errors.some(error => asRecord(error)?.message === "Online Store channel is locked.")) {
          throw new ShopifyBrandSyncError("CHANNEL_LOCKED", false);
        }
      }
      if (response.status === 401) throw new ShopifyBrandSyncError("ACCESS_DENIED", false);
      if (response.status === 402) throw new ShopifyBrandSyncError("SHOP_FROZEN", false);
      // Public API restrictions are unavailability, never evidence of missing assets.
      if (response.status === 403) throw new ShopifyBrandSyncError("SHOP_FORBIDDEN", false);
      if (response.status === 404) throw new ShopifyBrandSyncError("SHOP_NOT_FOUND", false);
      if (response.status === 429) {
        throw new ShopifyBrandSyncError("SHOPIFY_THROTTLED", true, parseRetryAfter(response.headers.get("retry-after")) ?? 0);
      }
      if (response.status === 423) throw new ShopifyBrandSyncError("SHOP_LOCKED", false);
      if (!response.ok) throw new ShopifyBrandSyncError("SHOPIFY_UNAVAILABLE", response.status >= 500);
      if (response.headers.get("x-shopify-api-version") !== SHOPIFY_BRAND_API_VERSION) {
        throw new ShopifyBrandSyncError("SHOPIFY_INVALID_RESPONSE", false);
      }
      const body = await raceAbort(readBoundedJson(response), controller.signal);
      const record = asRecord(body);
      if (!record) throw new ShopifyBrandSyncError("SHOPIFY_INVALID_RESPONSE", false);
      if (record.errors !== undefined && !Array.isArray(record.errors)) {
        throw new ShopifyBrandSyncError("SHOPIFY_INVALID_RESPONSE", false);
      }
      const errors = Array.isArray(record.errors) ? record.errors : [];
      if (errors.length) {
        this.logFailure({ origin: "provider_response", httpStatus: response.status, ...safeProviderErrors(errors) });
        if (errors.some(error => asRecord(error)?.message === "Online Store channel is locked.")) throw new ShopifyBrandSyncError("CHANNEL_LOCKED", false);
        const codes = errors.map((entry) => {
          const value = asRecord(entry);
          return asRecord(value?.extensions)?.code;
        });
        if (codes.includes("THROTTLED") || codes.includes("MAX_COST_EXCEEDED")) {
          throw new ShopifyBrandSyncError("SHOPIFY_THROTTLED", true);
        }
        if (codes.includes("ACCESS_DENIED")) {
          throw new ShopifyBrandSyncError("ACCESS_DENIED", false);
        }
        if (codes.includes("SHOP_INACTIVE")) throw new ShopifyBrandSyncError("SHOP_INACTIVE", false);
        if (codes.includes("FORBIDDEN")) throw new ShopifyBrandSyncError("SHOP_FORBIDDEN", false);
        if (codes.includes("INTERNAL_SERVER_ERROR")) {
          throw new ShopifyBrandSyncError("SHOPIFY_UNAVAILABLE", true);
        }
        throw new ShopifyBrandSyncError("SHOPIFY_GRAPHQL_FAILURE", true);
      }
      const shop = asRecord(asRecord(record.data)?.shop);
      if (!shop || !(shop.brand === null || asRecord(shop.brand))) {
        throw new ShopifyBrandSyncError("SHOPIFY_INVALID_RESPONSE", false);
      }
      const brand = asRecord(shop.brand);
      if (brand && !["logo", "squareLogo", "coverImage"].every(key => Object.hasOwn(brand, key))) {
        throw new ShopifyBrandSyncError("SHOPIFY_INVALID_RESPONSE", false);
      }
      return { logo: parseImage(brand?.logo ?? null), squareLogo: parseImage(brand?.squareLogo ?? null),
        coverImage: parseImage(brand?.coverImage ?? null), observedAt };
    } catch (error) {
      if (error instanceof ShopifyBrandSyncError) throw error;
      this.logFailure({ origin: "sdk_exception", reasonCode: "SHOPIFY_UNAVAILABLE", ...safeException(error) });
      // Abort/network/JSON errors are not proof of absent branding.
      throw new ShopifyBrandSyncError(controller.signal.aborted ? "SHOPIFY_TIMEOUT" : "SHOPIFY_UNAVAILABLE", true, null, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
  private logFailure(fields: Record<string, unknown>): void {
    try { (this.deps.logger ?? logger).warn("shop_brand.shopify.provider_failed", {
      provider: "shopify", operation: "ModaPublicBrandSources", ...fields,
    }); } catch { /* Logging cannot change retry or authorization behavior. */ }
  }
}

/** This query has no customer input; redact unsafe provider echoes before shared logging. */
function safeText(value: string): { value: string; redactionApplied: boolean; truncated: boolean } {
  const unsafe = /https?:|@|Bearer\s|shp[a-z]*_|token|secret|password|(?:\d[\s()+.-]*){9}/i.test(value);
  return { value: unsafe ? "[REDACTED]" : value.slice(0, 1024), redactionApplied: unsafe, truncated: value.length > 1024 };
}
function safeException(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: { name: "NonErrorThrownValue", message: "[REDACTED]" }, redactionApplied: true, truncated: false };
  const safe = safeText(error.message);
  return { error: { name: error.name.slice(0, 64), message: safe.value }, redactionApplied: safe.redactionApplied, truncated: safe.truncated };
}
function safeProviderErrors(errors: unknown[]): Record<string, unknown> {
  let redactionApplied = false; let truncated = errors.length > 5;
  const providerErrors = errors.slice(0, 5).flatMap(raw => {
    const error = asRecord(raw); if (!error) return [];
    const result: Record<string, string> = {};
    for (const [key, value] of [["message", error.message], ["code", asRecord(error.extensions)?.code]]) {
      if (typeof value !== "string") continue;
      const safe = safeText(value); result[key as string] = safe.value;
      redactionApplied ||= safe.redactionApplied; truncated ||= safe.truncated;
    }
    return [result];
  });
  return { providerErrors, redactionApplied, truncated };
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
    await reader.cancel().catch(() => undefined);
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


function parseImage(value: unknown): ShopifyBrandImage | null {
  if (value === null) return null;
  const media = asRecord(value); const image = asRecord(media?.image);
  if (!media || typeof media.id !== "string" || !/^gid:\/\/shopify\/MediaImage\/[A-Za-z0-9_-]+$/.test(media.id) ||
      media.id.length > 512 || !image || typeof image.url !== "string" || image.url.length > 16_384 ||
      [...image.url].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) ||
      !Number.isSafeInteger(image.width) || (image.width as number) <= 0 ||
      !Number.isSafeInteger(image.height) || (image.height as number) <= 0) {
    throw new ShopifyBrandSyncError("SHOPIFY_INVALID_RESPONSE", false);
  }
  try {
    const url = new URL(image.url);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname || url.port || url.hash) throw new Error("INVALID_SOURCE_URL");
  } catch { throw new ShopifyBrandSyncError("SHOPIFY_INVALID_RESPONSE", false); }
  return { url: image.url, reference: `shopify-storefront:sha256:${createHash("sha256").update(media.id).digest("hex")}`,
    width: image.width as number, height: image.height as number };
}
