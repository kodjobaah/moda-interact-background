import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import type { LookupAddress } from "node:dns";
import type { IncomingHttpHeaders } from "node:http";

import { isPublicIpAddress, normalizeIpAddress } from "../services/merchant-knowledge-network-policy.js";
import type { WooConnectionMode, WooCouponCredential } from "../services/woo-coupon-grant.service.js";
import { signLocalWooCouponPath } from "./woo-coupon-local-oauth.js";
import type { WooCouponPage } from "./woo-coupon-pages.js";
import { defaultWooCouponSyncConfig, type WooCouponSyncConfig } from "../services/woo-coupon-sync-config.js";

// Human-readable descriptions for failures where no upstream provider response exists.
// `code` remains the stable business/retry classification.
const wooCouponReadDescriptions = {
  grant_configuration: "WooCommerce coupon credentials or connection configuration is invalid",
  shop_unavailable: "The WooCommerce shop is inactive or unavailable for coupon synchronization",
  grant_missing: "The WooCommerce shop has no current authorized coupon read grant",
  grant_unavailable: "The WooCommerce coupon read credentials cannot be loaded",
  grant_changed: "The WooCommerce coupon read grant changed while the scan was running",
  unsafe_target: "The WooCommerce shop URL or resolved IP address failed network safety validation",
  provider_unavailable: "The WooCommerce coupon API could not be reached or returned an unexpected response",
  unauthorized: "WooCommerce rejected the coupon read credentials",
  invalid_page: "WooCommerce returned an invalid coupon page or pagination metadata",
  unstable_pages: "WooCommerce coupon pagination changed during the scan",
  incomplete_pages: "WooCommerce coupon pagination did not return the expected number of records",
  too_many_pages: "The WooCommerce coupon scan exceeded its configured page limit",
  invalid_coupon: "WooCommerce returned an invalid coupon record",
  provider_identity_invalid: "WooCommerce returned an invalid coupon identifier",
} as const;

export class WooCouponReadError extends Error {
  readonly stage: "dns" | "http" | "response" | undefined;
  readonly httpStatus: number | undefined;
  readonly providerResponseBody: string | undefined;
  readonly redirectLocation: string | undefined;

  constructor(readonly code:
    "grant_configuration" | "shop_unavailable" | "grant_missing" | "grant_unavailable" | "grant_changed" |
    "unsafe_target" | "provider_unavailable" | "unauthorized" | "invalid_page" | "unstable_pages" |
    "incomplete_pages" | "too_many_pages" | "invalid_coupon" | "provider_identity_invalid",
    options: { cause?: unknown; stage?: "dns" | "http" | "response"; httpStatus?: number;
      message?: string; providerResponseBody?: string; redirectLocation?: string } = {}) {
    super(`${code}: ${options.message ?? (options.cause instanceof Error ? options.cause.message : wooCouponReadDescriptions[code])}`, { cause: options.cause });
    this.name = "WooCouponReadError";
    this.stage = options.stage;
    this.httpStatus = options.httpStatus;
    this.providerResponseBody = options.providerResponseBody;
    this.redirectLocation = options.redirectLocation;
  }
}

export interface WooCouponSite {
  canonicalSiteUrl: string;
  mode: WooConnectionMode;
}

const MAX_DNS_ANSWERS = 32;
const LOCAL_V4 = ["127.", "10.", "192.168.", "169.254."];

type ApprovedAddress = { address: string; family: 4 | 6 };

/** Narrow Node's numeric DNS family only after validating every resolved answer. */
function assertApprovedAddresses(
  answers: readonly LookupAddress[],
): asserts answers is readonly ApprovedAddress[] {
  if (answers.length === 0 || answers.length > MAX_DNS_ANSWERS || answers.some((entry) =>
    (entry.family !== 4 && entry.family !== 6) || isIP(entry.address) !== entry.family)) {
    throw new WooCouponReadError("unsafe_target");
  }
}

function isLocalAddress(address: string): boolean {
  const value = (normalizeIpAddress(address) ?? address).toLowerCase();
  if (isIP(value) === 6) return value === "::1" || value.startsWith("fc") ||
    value.startsWith("fd") || value.startsWith("fe8") || value.startsWith("fe9") ||
    value.startsWith("fea") || value.startsWith("feb");
  if (isIP(value) !== 4) return false;
  const octets = value.split(".").map(Number);
  return LOCAL_V4.some((prefix) => value.startsWith(prefix)) ||
    octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31;
}

function canonicalSite(site: WooCouponSite): { url: URL; basePath: string; hostname: string } {
  let url: URL;
  try { url = new URL(site.canonicalSiteUrl); } catch { throw new WooCouponReadError("unsafe_target"); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const basePath = url.pathname.replace(/\/+$/, "");
  const canonical = `${url.origin}${basePath}`;
  if (Buffer.byteLength(site.canonicalSiteUrl, "utf8") > 512 ||
      url.username || url.password || url.search || url.hash || url.hostname.endsWith(".") ||
      url.protocol !== "https:" && (site.mode !== "local-development" || url.protocol !== "http:") ||
      site.mode === "public" && (url.protocol !== "https:" || Boolean(url.port) || isIP(hostname) !== 0) ||
      site.canonicalSiteUrl !== canonical ||
      !hostname || site.mode === "public" && (hostname === "localhost" ||
        hostname.endsWith(".localhost") || hostname.endsWith(".local"))) {
    throw new WooCouponReadError("unsafe_target");
  }
  return { url, hostname, basePath };
}

export type WooCouponDnsResolver = (hostname: string) => Promise<readonly LookupAddress[]>;

/** SSRF protected, DNS-pinned GET-only transport; never accepts arbitrary caller URLs. */
export class WooCouponPageTransport {
  constructor(private readonly resolve: WooCouponDnsResolver =
    (host) => dnsLookup(host, { all: true, verbatim: true }),
    private readonly limits: WooCouponSyncConfig = defaultWooCouponSyncConfig(),
  ) {}

  async readPage(site: WooCouponSite, credentials: WooCouponCredential, page: number, perPage: number): Promise<WooCouponPage> {
    if (!Number.isInteger(page) || page < 1 || page > this.limits.maxPages || perPage !== 100) {
      throw new WooCouponReadError("invalid_page");
    }
    const { url, hostname, basePath } = canonicalSite(site);
    let answers: readonly LookupAddress[];
    let dnsTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      answers = await Promise.race([
        this.resolve(hostname),
        new Promise<never>((_, reject) => {
          dnsTimer = setTimeout(() => reject(new Error(`DNS lookup for ${hostname} timed out after 1500ms`)), 1500);
        }),
      ]);
    } catch (error) {
      throw new WooCouponReadError("provider_unavailable", {
        cause: error, stage: "dns",
        message: `DNS lookup for ${hostname} failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    finally { if (dnsTimer) clearTimeout(dnsTimer); }
    assertApprovedAddresses(answers);
    const allPublic = answers.every((entry) => isPublicIpAddress(entry.address));
    const allLocal = answers.every((entry) => isLocalAddress(entry.address));
    if (!(allPublic && url.protocol === "https:" && url.port === "") &&
        !(site.mode === "local-development" && allLocal)) {
      throw new WooCouponReadError("unsafe_target");
    }
    const selected = answers[0]!;
    const approved = new Set(answers.map((entry) => normalizeIpAddress(entry.address) ?? entry.address));
    const search = new URLSearchParams({ page: String(page), per_page: String(perPage), orderby: "id", order: "asc" });
    const rawPath = `${basePath}/wp-json/wc/v3/coupons?${search}`;
    const path = url.protocol === "http:"
      ? signLocalWooCouponPath(url.origin, rawPath, credentials)
      : rawPath;
    return await requestPage(url, hostname, selected, approved, path, credentials, this.limits);
  }
}

function numericHeader(headers: IncomingHttpHeaders, name: string): number {
  const raw = headers[name];
  if (typeof raw !== "string" || !/^\d{1,8}$/.test(raw)) {
    throw new WooCouponReadError("invalid_page", {
      message: `WooCommerce returned missing or invalid pagination header ${name}: ${String(raw)}`, stage: "response",
    });
  }
  return Number(raw);
}

function requestPage(
  url: URL, hostname: string, address: ApprovedAddress, approved: ReadonlySet<string>, path: string,
  credentials: WooCouponCredential, limits: WooCouponSyncConfig,
): Promise<WooCouponPage> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)({
      protocol: url.protocol, hostname, port: url.port || (url.protocol === "https:" ? 443 : 80),
      method: "GET", path, agent: false,
      headers: {
        accept: "application/json", "accept-encoding": "identity", connection: "close",
        ...(url.protocol === "https:" ? {
          authorization: `Basic ${Buffer.from(`${credentials.consumerKey}:${credentials.consumerSecret}`).toString("base64")}`,
        } : {}),
      },
      lookup: (_host, options, callback) => {
        if (options && typeof options === "object" && options.all) {
          callback(null, [{ address: address.address, family: address.family }]);
        } else callback(null, address.address, address.family);
      },
      ...(url.protocol === "https:" ? {
        servername: hostname,
        checkServerIdentity: (_name: string, cert: Parameters<typeof checkServerIdentity>[1]) =>
          checkServerIdentity(hostname, cert),
      } : {}),
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status !== 200) {
        // WooCommerce REST failures normally include a JSON `message` and `code`.
        // Read the body before rejecting so an operator can see the provider's
        // explanation rather than the unhelpful `provider_unavailable` code alone.
        // Bound memory even when a misconfigured server returns a large HTML page.
        const maximumErrorBytes = Math.min(limits.maxResponseBytes, 16 * 1024);
        const buffers: Buffer[] = [];
        let size = 0;
        let truncated = false;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const remaining = Math.max(0, maximumErrorBytes - size);
          if (bytes.length > remaining) truncated = true;
          if (remaining) {
            buffers.push(bytes.subarray(0, remaining));
            size += Math.min(remaining, bytes.length);
          }
        });
        response.once("error", (error) => reject(new WooCouponReadError(
          status === 401 || status === 403 ? "unauthorized" : "provider_unavailable", {
            cause: error, stage: "response", httpStatus: status,
            message: `HTTP ${status} from WooCommerce; error response stream failed: ${error.message}`,
          },
        )));
        response.once("end", () => {
          const responseBody = Buffer.concat(buffers).toString("utf8") + (truncated ? " [response truncated]" : "");
          let providerMessage: string | undefined;
          let providerCode: string | undefined;
          try {
            const parsed: unknown = JSON.parse(responseBody);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              const fields = parsed as Record<string, unknown>;
              if (typeof fields.message === "string") providerMessage = fields.message;
              if (typeof fields.code === "string") providerCode = fields.code;
            }
          } catch { /* HTML/plaintext errors are preserved as the response body. */ }
          const redirectLocation = typeof response.headers.location === "string" ? response.headers.location : undefined;
          const details = [
            `WooCommerce coupon API returned HTTP ${status}`,
            ...(providerCode ? [`code: ${providerCode}`] : []),
            ...(providerMessage ? [`message: ${providerMessage}`] : []),
            ...(responseBody ? [`response: ${responseBody}`] : []),
            ...(redirectLocation ? [`redirect: ${redirectLocation}`] : []),
          ];
          reject(new WooCouponReadError(status === 401 || status === 403 ? "unauthorized" : "provider_unavailable", {
            stage: "http", httpStatus: status, message: details.join("; "),
            providerResponseBody: responseBody,
            ...(redirectLocation !== undefined ? { redirectLocation } : {}),
          }));
        });
        return;
      }
      const contentType = response.headers["content-type"];
      const encoding = response.headers["content-encoding"];
      const lengthRaw = response.headers["content-length"];
      const length = lengthRaw === undefined ? 0 : Number(lengthRaw);
      if (typeof contentType !== "string" || contentType.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
          encoding !== undefined && encoding !== "identity" || !Number.isInteger(length) ||
          length < 0 || length > limits.maxResponseBytes) {
        response.destroy(); reject(new WooCouponReadError("invalid_page", {
          stage: "response",
          message: `Unexpected WooCommerce response headers: content-type=${String(contentType)}, content-encoding=${String(encoding)}, content-length=${String(lengthRaw)}`,
        })); return;
      }
      let total: number, totalPages: number;
      try {
        total = numericHeader(response.headers, "x-wp-total");
        totalPages = numericHeader(response.headers, "x-wp-totalpages");
      } catch (error) {
        response.destroy(); reject(error); return;
      }
      const buffers: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > limits.maxResponseBytes) response.destroy(new WooCouponReadError("invalid_page", {
          stage: "response", message: `WooCommerce coupon response exceeded ${limits.maxResponseBytes} bytes`,
        }));
        else buffers.push(bytes);
      });
      response.once("error", (error) => reject(new WooCouponReadError("invalid_page", { cause: error, stage: "response" })));
      response.once("end", () => {
        try {
          const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(buffers))) as unknown;
          resolve({ coupons: payload, total, totalPages });
        } catch (error) {
          reject(new WooCouponReadError("invalid_page", {
            stage: "response", cause: error,
            message: `WooCommerce coupon response contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          }));
        }
      });
    });
    const timeout = setTimeout(() => req.destroy(new WooCouponReadError("provider_unavailable", {
      stage: "http", message: `WooCommerce coupon GET ${hostname} timed out after ${limits.requestTimeoutMs}ms`,
    })), limits.requestTimeoutMs);
    req.once("close", () => clearTimeout(timeout));
    req.once("error", (error: unknown) => reject(error instanceof WooCouponReadError
      ? error : new WooCouponReadError("provider_unavailable", {
        cause: error, stage: "http",
        message: `WooCommerce coupon GET ${hostname} failed: ${error instanceof Error ? error.message : String(error)}`,
      })));
    req.once("socket", (socket) => {
      socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () => {
        const peer = socket.remoteAddress ? normalizeIpAddress(socket.remoteAddress) : null;
        if (!peer || !approved.has(peer)) req.destroy(new WooCouponReadError("unsafe_target"));
      });
    });
    req.end();
  });
}
