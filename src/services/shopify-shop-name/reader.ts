import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { getShopifySession } from "../shopify-session.service.js";
import { ShopNameReadError, type NameClaim } from "./contracts.js";
/** Match the installed Admin API version; basic shop identity only. */
export const SHOPIFY_NAME_API_VERSION = "2026-07";
const SHOP_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/;
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const logger = createLogger({ serviceName: "moda-recovery-worker", environment: resolveDeploymentEnvironmentName() });

/** Basic shop metadata: no read_brand or protected customer fields. */
export const SHOPIFY_NAME_QUERY = `query ModaBasicShopName { shop { name } }`;

type FetchPort = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface ShopNameReader {
  read(claim: NameClaim): Promise<string>;
}

export class ShopifyAdminNameReader implements ShopNameReader {
  constructor(private readonly deps: {
    session?: (shopId: string, options: { signal: AbortSignal }) => Promise<{ shopId: string; shop: string; accessToken: string }>;
    fetchImpl?: FetchPort;
    timeoutMs?: number;
    logger?: Pick<StructuredLogger, "warn">;
  } = {}) {
    const ms = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > 30_000) {
      throw new RangeError("INVALID_SHOPIFY_NAME_TIMEOUT");
    }
  }

  async read(claim: NameClaim): Promise<string> {
    const shopDomain = claim.domain;
    if (!SHOP_DOMAIN.test(shopDomain)) {
      throw new ShopNameReadError("SHOPIFY_INVALID_RESPONSE", false);
    }
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Bound token acquisition as well as the outbound request and response body.
      const session = await raceAbort(
        (this.deps.session ?? getShopifySession)(claim.shopId, { signal: controller.signal }), controller.signal,
      ).catch((error: unknown) => {
        if (controller.signal.aborted) throw new ShopNameReadError("SHOPIFY_TIMEOUT", true);
        // Offline-session errors may contain domains or token-provider details. Never propagate them.
        this.logFailure({ origin: "sdk_exception", reasonCode: "TOKEN_UNAVAILABLE", ...safeException(error) });
        throw new ShopNameReadError("TOKEN_UNAVAILABLE", true, 0, { cause: error });
      });
      if (!session.accessToken || session.shopId !== claim.shopId || session.shop !== shopDomain) {
        throw new ShopNameReadError("SESSION_IDENTITY_CONFLICT", false);
      }
      const response = await raceAbort((this.deps.fetchImpl ?? fetch)(
        `https://${shopDomain}/admin/api/${SHOPIFY_NAME_API_VERSION}/graphql.json`, {
          method: "POST", redirect: "error",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
          body: JSON.stringify({ query: SHOPIFY_NAME_QUERY }), signal: controller.signal,
        }), controller.signal);
      if (!response.ok) {
        let errors: unknown = null;
        try { errors = asRecord(await raceAbort(readBoundedJson(response), controller.signal))?.errors; } catch { /* Unsafe/unparseable error body is intentionally redacted. */ }
        this.logFailure({ origin: "provider_response", httpStatus: response.status,
          ...(Array.isArray(errors) ? safeProviderErrors(errors) : { providerErrorBody: "[REDACTED]", redactionApplied: true, truncated: false }) });
      }
      if (response.status === 401) throw new ShopNameReadError("ACCESS_DENIED", false);
      if (response.status === 402) throw new ShopNameReadError("SHOP_FROZEN", false);
      // For Admin GraphQL, a 403 indicates a shop-level restriction. Missing scopes
      // are returned as HTTP 200 with errors[n].extensions.code=ACCESS_DENIED.
      if (response.status === 403) throw new ShopNameReadError("SHOP_FORBIDDEN", false);
      if (response.status === 404) throw new ShopNameReadError("SHOP_NOT_FOUND", false);
      if (response.status === 429) {
        throw new ShopNameReadError("SHOPIFY_THROTTLED", true, parseRetryAfter(response.headers.get("retry-after")) ?? 0);
      }
      if (response.status === 423) throw new ShopNameReadError("SHOP_LOCKED", false);
      if (!response.ok) throw new ShopNameReadError("SHOPIFY_UNAVAILABLE", response.status >= 500);
      const body = await raceAbort(readBoundedJson(response), controller.signal);
      const record = asRecord(body);
      if (!record) throw new ShopNameReadError("SHOPIFY_INVALID_RESPONSE", false);
      if (record.errors !== undefined && !Array.isArray(record.errors)) {
        throw new ShopNameReadError("SHOPIFY_INVALID_RESPONSE", false);
      }
      const errors = Array.isArray(record.errors) ? record.errors : [];
      if (errors.length) {
        this.logFailure({ origin: "provider_response", httpStatus: response.status, ...safeProviderErrors(errors) });
        const codes = errors.map((entry) => {
          const value = asRecord(entry);
          return asRecord(value?.extensions)?.code;
        });
        if (codes.includes("THROTTLED") || codes.includes("MAX_COST_EXCEEDED")) {
          throw new ShopNameReadError("SHOPIFY_THROTTLED", true);
        }
        if (codes.includes("ACCESS_DENIED")) {
          throw new ShopNameReadError("ACCESS_DENIED", false);
        }
        if (codes.includes("SHOP_INACTIVE")) throw new ShopNameReadError("SHOP_INACTIVE", false);
        if (codes.includes("FORBIDDEN")) throw new ShopNameReadError("SHOP_FORBIDDEN", false);
        if (codes.includes("INTERNAL_SERVER_ERROR")) {
          throw new ShopNameReadError("SHOPIFY_UNAVAILABLE", true);
        }
        throw new ShopNameReadError("SHOPIFY_GRAPHQL_FAILURE", true);
      }
      const shop = asRecord(asRecord(record.data)?.shop);
      if (!shop || typeof shop.name !== "string" || !shop.name.trim() ||
          shop.name.length > 2048 || hasNameControl(shop.name)) {
        throw new ShopNameReadError("SHOPIFY_INVALID_RESPONSE", false);
      }
      return shop.name.trim();
    } catch (error) {
      if (error instanceof ShopNameReadError) throw error;
      this.logFailure({ origin: "sdk_exception", reasonCode: "SHOPIFY_UNAVAILABLE", ...safeException(error) });
      // Abort/network/JSON errors are not proof of absent branding.
      throw new ShopNameReadError(controller.signal.aborted ? "SHOPIFY_TIMEOUT" : "SHOPIFY_UNAVAILABLE", true, 0, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
  private logFailure(fields: Record<string, unknown>): void {
    try { (this.deps.logger ?? logger).warn("shop_brand.name.provider_failed", {
      provider: "shopify", operation: "ModaBasicShopName", ...fields,
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
    throw new ShopNameReadError("SHOPIFY_INVALID_RESPONSE", false);
  }
  if (!response.body) throw new ShopNameReadError("SHOPIFY_INVALID_RESPONSE", false);
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new ShopNameReadError("SHOPIFY_INVALID_RESPONSE", false);
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
    throw new ShopNameReadError("SHOPIFY_INVALID_RESPONSE", false);
  }
  return parsed;
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new ShopNameReadError("SHOPIFY_TIMEOUT", true);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ShopNameReadError("SHOPIFY_TIMEOUT", true));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

function hasNameControl(value: string): boolean {
  return [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}
