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

export class WooCouponReadError extends Error {
  constructor(readonly code:
    "grant_configuration" | "shop_unavailable" | "grant_missing" | "grant_unavailable" | "grant_changed" |
    "unsafe_target" | "provider_unavailable" | "unauthorized" | "invalid_page" | "unstable_pages" |
    "incomplete_pages" | "too_many_pages" | "invalid_coupon") {
    super(code);
    this.name = "WooCouponReadError";
  }
}

export interface WooCouponSite {
  canonicalSiteUrl: string;
  mode: WooConnectionMode;
}

const REQUEST_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 1024 * 1024;
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
    (host) => dnsLookup(host, { all: true, verbatim: true })) {}

  async readPage(site: WooCouponSite, credentials: WooCouponCredential, page: number, perPage: number): Promise<WooCouponPage> {
    if (!Number.isInteger(page) || page < 1 || page > 50 || perPage !== 100) {
      throw new WooCouponReadError("invalid_page");
    }
    const { url, hostname, basePath } = canonicalSite(site);
    let answers: readonly LookupAddress[];
    let dnsTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      answers = await Promise.race([
        this.resolve(hostname),
        new Promise<never>((_, reject) => {
          dnsTimer = setTimeout(() => reject(new WooCouponReadError("provider_unavailable")), 1500);
        }),
      ]);
    } catch { throw new WooCouponReadError("provider_unavailable"); }
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
    return await requestPage(url, hostname, selected, approved, path, credentials);
  }
}

function numericHeader(headers: IncomingHttpHeaders, name: string): number {
  const raw = headers[name];
  if (typeof raw !== "string" || !/^\d{1,8}$/.test(raw)) throw new WooCouponReadError("invalid_page");
  return Number(raw);
}

function requestPage(
  url: URL, hostname: string, address: ApprovedAddress, approved: ReadonlySet<string>, path: string,
  credentials: WooCouponCredential,
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
      if (status === 401 || status === 403) {
        response.destroy(); reject(new WooCouponReadError("unauthorized")); return;
      }
      if (status !== 200) {
        response.destroy(); reject(new WooCouponReadError("provider_unavailable")); return;
      }
      const contentType = response.headers["content-type"];
      const encoding = response.headers["content-encoding"];
      const lengthRaw = response.headers["content-length"];
      const length = lengthRaw === undefined ? 0 : Number(lengthRaw);
      if (typeof contentType !== "string" || contentType.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
          encoding !== undefined && encoding !== "identity" || !Number.isInteger(length) ||
          length < 0 || length > MAX_BODY_BYTES) {
        response.destroy(); reject(new WooCouponReadError("invalid_page")); return;
      }
      let total: number, totalPages: number;
      try {
        total = numericHeader(response.headers, "x-wp-total");
        totalPages = numericHeader(response.headers, "x-wp-totalpages");
      } catch {
        response.destroy(); reject(new WooCouponReadError("invalid_page")); return;
      }
      const buffers: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_BODY_BYTES) response.destroy(new WooCouponReadError("invalid_page"));
        else buffers.push(bytes);
      });
      response.once("error", () => reject(new WooCouponReadError("invalid_page")));
      response.once("end", () => {
        try {
          const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(buffers))) as unknown;
          resolve({ coupons: payload, total, totalPages });
        } catch { reject(new WooCouponReadError("invalid_page")); }
      });
    });
    const timeout = setTimeout(() => req.destroy(new WooCouponReadError("provider_unavailable")), REQUEST_TIMEOUT_MS);
    req.once("close", () => clearTimeout(timeout));
    req.once("error", (error: unknown) => reject(error instanceof WooCouponReadError
      ? error : new WooCouponReadError("provider_unavailable")));
    req.once("socket", (socket) => {
      socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () => {
        const peer = socket.remoteAddress ? normalizeIpAddress(socket.remoteAddress) : null;
        if (!peer || !approved.has(peer)) req.destroy(new WooCouponReadError("unsafe_target"));
      });
    });
    req.end();
  });
}
