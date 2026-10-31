import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import {
  addressesMatch, createPinnedLookup, MerchantKnowledgeAcquisitionError,
  resolveAllDnsAnswers, resolveAndValidateDestination,
  type MerchantKnowledgeResolvedAddress, type MerchantKnowledgeResolver,
} from "../merchant-knowledge-network-policy.js";
import {
  SHOP_BRAND_MAX_SOURCE_BYTES, ShopBrandMediaError,
  type FetchedBrandSource, type SafeFetcher,
} from "./contracts.js";

const MAX_URL_LENGTH = 2048;
const MAX_REDIRECTS = 3;
const DEADLINE_MS = 10_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_NETWORK = new Set(["ECONNRESET", "EAI_AGAIN", "ETIMEDOUT", "ETIMEOUT", "ECONNREFUSED", "ENETUNREACH"]);
const REQUEST_HEADERS = Object.freeze({
  Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml,*/*;q=0.2",
  "Accept-Encoding": "identity",
  "User-Agent": "ModaInteract-ShopBrandMedia/1.0",
});

export type PinnedImageRequest = Readonly<{
  hostname: string;
  path: string;
  address: MerchantKnowledgeResolvedAddress;
  servername?: string;
  headers: typeof REQUEST_HEADERS;
}>;
export interface ImageHttpResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Readable;
  peerAddress: string;
}
export type PinnedImageHttpRequest = (input: PinnedImageRequest, signal: AbortSignal) => Promise<ImageHttpResponse>;
export interface SafeImageFetcherOptions {
  resolveAll?: MerchantKnowledgeResolver;
  request?: PinnedImageHttpRequest;
  /** Narrow deployments can prohibit redirects and lower the byte ceiling. */
  maxRedirects?: number;
  maxBytes?: number;
}

function safeUrl(input: string): URL {
  if (typeof input !== "string" || input.length > MAX_URL_LENGTH || /[\s\p{Cc}]/u.test(input)) {
    throw new ShopBrandMediaError("UNSAFE_SOURCE");
  }
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password || url.hash ||
        (url.port && url.port !== "443") || !url.hostname) {
      throw new Error("unapproved-url");
    }
    return url;
  } catch {
    throw new ShopBrandMediaError("UNSAFE_SOURCE");
  }
}
function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}
function networkCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
}
function sanitiseNetworkError(error: unknown): ShopBrandMediaError {
  if (error instanceof ShopBrandMediaError) return error;
  if (error instanceof MerchantKnowledgeAcquisitionError) {
    if (error.code === "DENIED_DESTINATION") return new ShopBrandMediaError("UNSAFE_SOURCE");
    if (error.code === "DNS_TEMPORARY_FAILURE") return new ShopBrandMediaError("DNS_TEMPORARY_FAILURE", true);
    return new ShopBrandMediaError("DNS_FAILURE", error.retryable);
  }
  const code = networkCode(error);
  return new ShopBrandMediaError("SOURCE_UNAVAILABLE", TRANSIENT_NETWORK.has(code ?? ""));
}
function cancelled(signal: AbortSignal): ShopBrandMediaError {
  return signal.reason instanceof ShopBrandMediaError
    ? signal.reason : new ShopBrandMediaError("SOURCE_TIMEOUT", true);
}
/** Ensure non-cooperative injected requests/resolvers cannot extend the single total deadline. */
function deadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelled(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(cancelled(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); });
  });
}

function pinnedHttpsRequest(input: PinnedImageRequest, signal: AbortSignal): Promise<ImageHttpResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = https.request({
      hostname: input.hostname,
      port: 443,
      path: input.path,
      method: "GET",
      headers: input.headers,
      lookup: createPinnedLookup(input.address),
      agent: false,
      minVersion: "TLSv1.2",
      signal,
      ...(input.servername ? { servername: input.servername } : {}),
    }, (response) => {
      const peerAddress = response.socket.remoteAddress;
      if (!peerAddress || !addressesMatch(peerAddress, input.address.address)) {
        response.destroy();
        fail(new ShopBrandMediaError("UNSAFE_SOURCE"));
        request.destroy();
        return;
      }
      if (settled) { response.destroy(); return; }
      settled = true;
      resolve({ statusCode: response.statusCode ?? 0, headers: response.headers,
        body: response, peerAddress });
    });
    request.once("socket", (socket) => {
      socket.once("secureConnect", () => {
        if (!socket.remoteAddress || !addressesMatch(socket.remoteAddress, input.address.address)) {
          fail(new ShopBrandMediaError("UNSAFE_SOURCE"));
          request.destroy();
        }
      });
    });
    request.once("error", fail);
    request.end();
  });
}

async function boundedBody(response: ImageHttpResponse, signal: AbortSignal, maxBytes: number): Promise<Buffer> {
  const rawSize = header(response.headers, "content-length");
  if (rawSize !== undefined && (!/^\d+$/.test(rawSize) || Number(rawSize) > maxBytes)) {
    response.body.destroy();
    throw new ShopBrandMediaError("SOURCE_TOO_LARGE");
  }
  const encoding = header(response.headers, "content-encoding");
  // No transparent decompression: avoid another inflation stage before image pixel checks.
  if (encoding !== undefined && encoding.toLowerCase().trim() !== "identity") {
    response.body.destroy();
    throw new ShopBrandMediaError("UNSUPPORTED_ENCODING");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  const onAbort = () => response.body.destroy(cancelled(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const chunk of response.body) {
      if (signal.aborted) throw cancelled(signal);
      const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      length += bytes.length;
      if (length > maxBytes) {
        response.body.destroy();
        throw new ShopBrandMediaError("SOURCE_TOO_LARGE");
      }
      chunks.push(bytes);
    }
    if (signal.aborted) throw cancelled(signal);
    return Buffer.concat(chunks, length);
  } catch (error) {
    if (signal.aborted) throw cancelled(signal);
    if (error instanceof ShopBrandMediaError) throw error;
    throw sanitiseNetworkError(error);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function createSafeImageFetcher(options: SafeImageFetcherOptions = {}): SafeFetcher {
  const resolveAll = options.resolveAll ?? resolveAllDnsAnswers;
  const request = options.request ?? pinnedHttpsRequest;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? SHOP_BRAND_MAX_SOURCE_BYTES;
  return {
    async fetch(sourceUrl: string): Promise<FetchedBrandSource> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new ShopBrandMediaError("SOURCE_TIMEOUT", true)), DEADLINE_MS);
      try {
        let next = safeUrl(sourceUrl);
        for (let redirects = 0; ; redirects += 1) {
          const host = next.hostname.startsWith("[") ? next.hostname.slice(1, -1) : next.hostname;
          let address: MerchantKnowledgeResolvedAddress;
          try {
            address = await deadline(resolveAndValidateDestination(next.hostname, resolveAll), controller.signal);
          } catch (error) { throw sanitiseNetworkError(error); }
          const input: PinnedImageRequest = {
            hostname: host, path: `${next.pathname}${next.search}`, address, headers: REQUEST_HEADERS,
            ...(isIP(host) === 0 ? { servername: host } : {}),
          };
          let response: ImageHttpResponse;
          try { response = await deadline(request(input, controller.signal), controller.signal); }
          catch (error) { throw sanitiseNetworkError(error); }
          if (!addressesMatch(response.peerAddress, address.address)) {
            response.body.destroy();
            throw new ShopBrandMediaError("UNSAFE_SOURCE");
          }
          if (REDIRECTS.has(response.statusCode)) {
            response.body.destroy();
            if (redirects >= maxRedirects) throw new ShopBrandMediaError("UNSAFE_SOURCE");
            const location = header(response.headers, "location");
            if (!location) throw new ShopBrandMediaError("UNSAFE_SOURCE");
            try { next = safeUrl(new URL(location, next).toString()); }
            catch { throw new ShopBrandMediaError("UNSAFE_SOURCE"); }
            continue;
          }
          if (response.statusCode !== 200) {
            response.body.destroy();
            throw new ShopBrandMediaError(TRANSIENT_HTTP.has(response.statusCode)
              ? "SOURCE_UNAVAILABLE" : "SOURCE_HTTP_FAILURE", TRANSIENT_HTTP.has(response.statusCode));
          }
          const bytes = await boundedBody(response, controller.signal, maxBytes);
          if (!bytes.length) throw new ShopBrandMediaError("INVALID_IMAGE");
          const declaredContentType = header(response.headers, "content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
          return { bytes, declaredContentType };
        }
      } catch (error) {
        if (controller.signal.aborted) throw cancelled(controller.signal);
        if (error instanceof ShopBrandMediaError) throw error;
        throw sanitiseNetworkError(error);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
