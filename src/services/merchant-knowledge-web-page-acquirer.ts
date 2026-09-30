import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import { Transform, Writable, type WritableOptions } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
} from "node:zlib";

import type {
  AcquiredMerchantKnowledgeDocument,
  MerchantKnowledgeWebPageAcquirer as MerchantKnowledgeWebPageAcquirerContract,
} from "./merchant-knowledge-acquisition.js";
import {
  addressesMatch,
  createPinnedLookup,
  MERCHANT_KNOWLEDGE_ACQUISITION_DEADLINE_MS,
  MERCHANT_KNOWLEDGE_ACQUISITION_ERROR_CODES,
  MERCHANT_KNOWLEDGE_MAX_DECOMPRESSED_BYTES,
  MERCHANT_KNOWLEDGE_MAX_REDIRECTS,
  MERCHANT_KNOWLEDGE_MAX_URL_LENGTH,
  MerchantKnowledgeAcquisitionError,
  resolveAndValidateDestination,
  resolveAllDnsAnswers,
  type MerchantKnowledgeAcquisitionErrorCode,
  type MerchantKnowledgeResolver,
  type MerchantKnowledgeResolvedAddress,
} from "./merchant-knowledge-network-policy.js";
import {
  decodeMerchantKnowledgeUtf8,
  extractVisibleHtmlText,
} from "./merchant-knowledge-html-extraction.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ETIMEOUT",
]);

const REQUEST_HEADERS = {
  Accept: "text/html, text/plain",
  "Accept-Encoding": "gzip, deflate, br",
  "User-Agent": "ModaInteract-MerchantKnowledge/1.0",
} as const;

export interface MerchantKnowledgePinnedRequest {
  hostname: string;
  port: number;
  path: string;
  address: MerchantKnowledgeResolvedAddress;
  servername?: string;
  headers: typeof REQUEST_HEADERS;
}

export interface MerchantKnowledgeHttpResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Readable;
  peerAddress: string;
}

export type MerchantKnowledgeHttpsRequest = (
  request: MerchantKnowledgePinnedRequest,
  signal: AbortSignal,
) => Promise<MerchantKnowledgeHttpResponse>;

export interface MerchantKnowledgeWebPageAcquirerOptions {
  resolveAll?: MerchantKnowledgeResolver;
  request?: MerchantKnowledgeHttpsRequest;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function acquisitionError(
  code: MerchantKnowledgeAcquisitionErrorCode,
  retryableOverride?: boolean,
): MerchantKnowledgeAcquisitionError {
  const messages: Record<MerchantKnowledgeAcquisitionErrorCode, string> = {
    INVALID_URL: "The requested URL is invalid.",
    DENIED_DESTINATION: "The requested destination is not globally routable.",
    DNS_NO_ADDRESSES: "The destination has no DNS addresses.",
    DNS_TEMPORARY_FAILURE: "Temporary DNS resolution failure.",
    DNS_FAILURE: "DNS resolution failed.",
    TOO_MANY_REDIRECTS: "The response exceeded the redirect limit.",
    INVALID_REDIRECT: "The response contained an invalid redirect.",
    REQUEST_DEADLINE: "The acquisition exceeded its time limit.",
    CONNECTION_PEER_MISMATCH: "The connected peer differed from the validated address.",
    HTTP_STATUS_TRANSIENT: "The source returned a transient HTTP status.",
    HTTP_STATUS_PERMANENT: "The source returned an unsuccessful HTTP status.",
    UNSUPPORTED_MEDIA_TYPE: "The source media type is not supported.",
    UNSUPPORTED_CONTENT_ENCODING: "The source content encoding is not supported.",
    BODY_TOO_LARGE: "The decompressed source exceeds the size limit.",
    RESPONSE_READ_FAILED: "The source response could not be read.",
  };
  const retryableByDefault =
    code === "DNS_TEMPORARY_FAILURE" ||
    code === "REQUEST_DEADLINE" ||
    code === "HTTP_STATUS_TRANSIENT";
  const retryable = retryableOverride ?? retryableByDefault;
  return new MerchantKnowledgeAcquisitionError(code, messages[code], retryable);
}

function invalidUrl(): MerchantKnowledgeAcquisitionError {
  return acquisitionError("INVALID_URL");
}

function validateUrl(url: URL): void {
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hostname.length === 0
  ) {
    throw invalidUrl();
  }
}

function hostnameForRequest(url: URL): string {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

function requestPath(url: URL): string {
  return `${url.pathname}${url.search}` || "/";
}

function defaultHttpsRequest(
  options: MerchantKnowledgePinnedRequest,
  signal: AbortSignal,
): Promise<MerchantKnowledgeHttpResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const requestOptions: https.RequestOptions = {
      hostname: options.hostname,
      port: options.port,
      path: options.path,
      method: "GET",
      headers: options.headers,
      lookup: createPinnedLookup(options.address),
      agent: false,
      signal,
      ...(options.servername ? { servername: options.servername } : {}),
    };

    const request = https.request(requestOptions, (response) => {
      const peerAddress = response.socket.remoteAddress;
      if (!peerAddress || !addressesMatch(peerAddress, options.address.address)) {
        response.destroy();
        fail(acquisitionError("CONNECTION_PEER_MISMATCH"));
        request.destroy();
        return;
      }
      if (settled) {
        response.destroy();
        return;
      }
      settled = true;
      resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: response,
        peerAddress,
      });
    });

    request.once("socket", (socket) => {
      socket.once("secureConnect", () => {
        const peerAddress = socket.remoteAddress;
        if (!peerAddress || !addressesMatch(peerAddress, options.address.address)) {
          fail(acquisitionError("CONNECTION_PEER_MISMATCH"));
          request.destroy();
        }
      });
    });
    request.once("error", fail);
    request.end();
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : acquisitionError("REQUEST_DEADLINE");
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function responseHeader(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

function contentType(headers: IncomingHttpHeaders): "text/html" | "text/plain" {
  const raw = responseHeader(headers, "content-type");
  const mediaType = raw?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "text/html" || mediaType === "text/plain") return mediaType;
  throw acquisitionError("UNSUPPORTED_MEDIA_TYPE");
}

function decoderFor(headers: IncomingHttpHeaders): Transform | undefined {
  const raw = responseHeader(headers, "content-encoding");
  if (raw === undefined || raw.trim().toLowerCase() === "identity") return undefined;
  if (raw.includes(",")) throw acquisitionError("UNSUPPORTED_CONTENT_ENCODING");
  switch (raw.trim().toLowerCase()) {
    case "gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    default:
      throw acquisitionError("UNSUPPORTED_CONTENT_ENCODING");
  }
}

async function readBoundedBody(
  body: Readable,
  decoder: Transform | undefined,
  signal: AbortSignal,
): Promise<Buffer> {
  let length = 0;
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer | string, _encoding: BufferEncoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (length + bytes.length > MERCHANT_KNOWLEDGE_MAX_DECOMPRESSED_BYTES) {
        callback(acquisitionError("BODY_TOO_LARGE"));
        return;
      }
      length += bytes.length;
      chunks.push(bytes);
      callback();
    },
  } satisfies WritableOptions);

  try {
    if (decoder) {
      await withAbort(pipeline(body, decoder, sink), signal);
    } else {
      await withAbort(pipeline(body, sink), signal);
    }
  } catch (error) {
    body.destroy();
    if (error instanceof MerchantKnowledgeAcquisitionError) throw error;
    if (signal.aborted) throw abortError(signal);
    throw acquisitionError(
      "RESPONSE_READ_FAILED",
      TRANSIENT_NETWORK_CODES.has(errorCode(error) ?? ""),
    );
  }
  return Buffer.concat(chunks, length);
}

function transientRequestError(error: unknown): MerchantKnowledgeAcquisitionError {
  if (signalIsDeadline(error)) return acquisitionError("REQUEST_DEADLINE");
  if (TRANSIENT_NETWORK_CODES.has(errorCode(error) ?? "")) {
    return acquisitionError(
      errorCode(error) === "EAI_AGAIN" ? "DNS_TEMPORARY_FAILURE" : "RESPONSE_READ_FAILED",
      true,
    );
  }
  if (error instanceof MerchantKnowledgeAcquisitionError) return error;
  return acquisitionError("RESPONSE_READ_FAILED", false);
}

function signalIsDeadline(error: unknown): boolean {
  return error instanceof MerchantKnowledgeAcquisitionError && error.code === "REQUEST_DEADLINE";
}

export class MerchantKnowledgeWebPageAcquirer
  implements MerchantKnowledgeWebPageAcquirerContract
{
  private readonly resolver: MerchantKnowledgeResolver;
  private readonly request: MerchantKnowledgeHttpsRequest;

  constructor(options: MerchantKnowledgeWebPageAcquirerOptions = {}) {
    this.resolver = options.resolveAll ?? resolveAllDnsAnswers;
    this.request = options.request ?? defaultHttpsRequest;
  }

  async acquire(input: {
    requestedUrl: string;
  }): Promise<AcquiredMerchantKnowledgeDocument> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(acquisitionError("REQUEST_DEADLINE")),
      MERCHANT_KNOWLEDGE_ACQUISITION_DEADLINE_MS,
    );

    try {
      if (
        typeof input.requestedUrl !== "string" ||
        input.requestedUrl.length > MERCHANT_KNOWLEDGE_MAX_URL_LENGTH
      ) {
        throw invalidUrl();
      }

      let currentUrl: URL;
      try {
        currentUrl = new URL(input.requestedUrl);
      } catch {
        throw invalidUrl();
      }

      let redirects = 0;
      for (;;) {
        validateUrl(currentUrl);
        const address = await withAbort(
          resolveAndValidateDestination(currentUrl.hostname, this.resolver),
          controller.signal,
        );
        const hostname = hostnameForRequest(currentUrl);
        const requestOptions: MerchantKnowledgePinnedRequest = {
          hostname,
          port: Number(currentUrl.port || 443),
          path: requestPath(currentUrl),
          address,
          headers: REQUEST_HEADERS,
          ...(isIP(hostname) === 0
            ? { servername: hostname }
            : {}),
        };

        let response: MerchantKnowledgeHttpResponse;
        try {
          response = await withAbort(
            this.request(requestOptions, controller.signal),
            controller.signal,
          );
        } catch (error) {
          throw transientRequestError(error);
        }

        if (!addressesMatch(response.peerAddress, address.address)) {
          response.body.destroy();
          throw acquisitionError("CONNECTION_PEER_MISMATCH");
        }

        if (REDIRECT_STATUSES.has(response.statusCode)) {
          response.body.destroy();
          if (redirects >= MERCHANT_KNOWLEDGE_MAX_REDIRECTS) {
            throw acquisitionError("TOO_MANY_REDIRECTS");
          }
          const location = responseHeader(response.headers, "location");
          if (!location) throw acquisitionError("INVALID_REDIRECT");
          try {
            currentUrl = new URL(location, currentUrl);
          } catch {
            throw acquisitionError("INVALID_REDIRECT");
          }
          if (currentUrl.toString().length > MERCHANT_KNOWLEDGE_MAX_URL_LENGTH) {
            throw acquisitionError("INVALID_REDIRECT");
          }
          redirects += 1;
          continue;
        }

        if (response.statusCode !== 200) {
          response.body.destroy();
          throw acquisitionError(
            TRANSIENT_HTTP_STATUSES.has(response.statusCode)
              ? "HTTP_STATUS_TRANSIENT"
              : "HTTP_STATUS_PERMANENT",
          );
        }

        const type = contentType(response.headers);
        const decoder = decoderFor(response.headers);
        const bytes = await readBoundedBody(response.body, decoder, controller.signal);
        const bodyText = decodeMerchantKnowledgeUtf8(bytes);
        return {
          contentType: type,
          extractedText:
            type === "text/html" ? extractVisibleHtmlText(bodyText) : bodyText,
          resolvedUrl: currentUrl.toString(),
          fetchedAt: new Date(),
        };
      }
    } catch (error) {
      if (controller.signal.aborted) throw abortError(controller.signal);
      if (error instanceof MerchantKnowledgeAcquisitionError) throw error;
      throw transientRequestError(error);
    } finally {
      clearTimeout(timer);
    }
  }
}

export {
  MERCHANT_KNOWLEDGE_ACQUISITION_ERROR_CODES,
  MerchantKnowledgeAcquisitionError,
};
export type { MerchantKnowledgeAcquisitionErrorCode };