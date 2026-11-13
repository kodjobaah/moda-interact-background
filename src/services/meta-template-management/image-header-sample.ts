import { ShopBrandMediaError } from "../shop-brand-media/contracts.js";
import { MetaManagementError } from "./contracts.js";

import { createProductionMetaTemplateSampleSource, type MetaTemplateSampleSource } from "./sample-source.js";
import { META_TEMPLATE_SAMPLE_ASSET, validateMetaTemplateSample } from "./sample-asset.js";
const SAMPLE_FILE_NAME = META_TEMPLATE_SAMPLE_ASSET.filename;

export type TrustedMetaImageSampleHandle = Readonly<{ value: string }>;
const trustedHandles = new WeakSet<object>();

export function isTrustedMetaImageSampleHandle(value: unknown): value is TrustedMetaImageSampleHandle {
  return !!value && typeof value === "object" && trustedHandles.has(value);
}

type MetaErrorDetails = Readonly<{
  code?: number | string;
  error_subcode?: number | string;
  message?: string;
  error_data?: unknown;
  fbtrace_id?: string;
  error_user_title?: string;
  error_user_msg?: string;
}>;

function redactKnown(value: string, token?: string, sensitive: readonly string[] = []): string {
  let safe = token ? value.replaceAll(token, "[REDACTED]") : value;
  for (const identity of sensitive) if (identity) safe = safe.replaceAll(identity, "[REDACTED_UPLOAD_ID]");
  return safe;
}

function bounded(value: unknown, limit = 512, token?: string, sensitive: readonly string[] = []): { value: string | null; truncated: boolean; redactionApplied: boolean } {
  if (typeof value !== "string") return { value: null, truncated: false, redactionApplied: false };
  let result = redactKnown(value, token, sensitive)
    .replace(/(Bearer|OAuth)\s+[^\s,"']+/gi, "$1 [REDACTED]")
    .replace(/(access_token|token|secret|authorization)\s*[:=]\s*[^\s,"'&]+/gi, "$1=[REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\+?\d[\d(). -]{7,}\d/g, "[REDACTED_PHONE]")
    .replace(/https?:\/\/[^\s"']+/gi, "[REDACTED_URL]");
  const redactionApplied = result !== value;
  const truncated = result.length > limit;
  if (truncated) result = result.slice(0, limit);
  return { value: result, truncated, redactionApplied };
}

function safeDetails(value: unknown, token: string, sensitive: readonly string[] = []): { details: unknown; redactionApplied: boolean; truncated: boolean } {
  if (value === undefined) return { details: undefined, redactionApplied: false, truncated: false };
  const raw = (() => { try { return JSON.stringify(value); } catch { return "[UNSERIALIZABLE]"; } })();
  let sanitized = redactKnown(raw, token, sensitive);
  sanitized = sanitized.replace(/https?:\/\/[^\s"']+/gi, "[REDACTED_URL]")
    .replace(/(access_token|token|secret|authorization)\s*[:=]\s*[^\s,"'&}]+/gi, "$1=[REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\+?\d[\d(). -]{7,}\d/g, "[REDACTED_PHONE]");
  const truncated = sanitized.length > 1024;
  if (truncated) sanitized = sanitized.slice(0, 1024);
  try { return { details: JSON.parse(sanitized), redactionApplied: sanitized !== raw, truncated }; }
  catch { return { details: sanitized, redactionApplied: sanitized !== raw, truncated }; }
}

function requestId(response: Response): string | null {
  const value = response.headers.get("x-fb-request-id") ?? response.headers.get("x-fb-trace-id");
  return value ? value.slice(0, 128) : null;
}

/** Meta's Upload-ID is opaque, including its evidenced signed query suffix.
 * Do not decode/rebuild it or accept arbitrary provider-returned URLs. */
function uploadSessionUrl(base: string, id: unknown): URL | null {
  if (typeof id !== "string" || !/^upload:[A-Za-z0-9_-]{8,256}(?:\?sig=[A-Za-z0-9_-]{1,256})?$/.test(id)) return null;
  try {
    const trusted = new URL(base);
    const target = new URL(`${base}/${id}`);
    const path = id.split("?", 1)[0];
    if (!/^\/v\d+\.\d+$/.test(trusted.pathname) || trusted.search || trusted.hash || trusted.username || trusted.password ||
        target.origin !== trusted.origin || target.username || target.password || target.hash ||
        target.pathname !== `${trusted.pathname}/${path}` || target.href !== `${base}/${id}`) return null;
    return target;
  } catch { return null; }
}

async function failure(response: Response, operation: "sample_session" | "sample_upload", token: string, signal: AbortSignal, sensitive: readonly string[] = []): Promise<MetaManagementError> {
  let raw = "";
  const reader = response.body?.getReader();
  try {
    if (reader) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (size < 4096) {
        const next = await withSignal(reader.read(), signal);
        if (next.done) break;
        const chunk = next.value.subarray(0, 4096 - size);
        chunks.push(chunk);
        size += chunk.length;
      }
      void reader.cancel().catch(() => {});
      raw = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
    }
  } catch { /* body absent/read failure is explicit below */ }
  finally { if (reader) void reader.cancel().catch(() => {}); }
  let parsed: { error?: MetaErrorDetails } | null = null;
  try { parsed = JSON.parse(raw) as { error?: MetaErrorDetails }; } catch { /* non-JSON retained only as bounded provider body */ }
  const source = parsed?.error;
  const sourceMessage = source?.message ?? (!source && raw ? raw : undefined);
  const messageWithTokenRedacted = typeof sourceMessage === "string" ? redactKnown(sourceMessage, token, sensitive) : sourceMessage;
  const tokenRedacted = messageWithTokenRedacted !== sourceMessage;
  const originalMessage = bounded(messageWithTokenRedacted);
  const details = safeDetails(source?.error_data ?? source?.error_user_msg ?? source?.error_user_title, token, sensitive);
  const appThrottle = response.status === 403 && source?.code === 4;
  const transient = appThrottle || response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
  return new MetaManagementError(appThrottle ? "META_SAMPLE_APP_THROTTLED" : `META_${operation.toUpperCase()}_${transient ? "TRANSIENT" : "REJECTED"}`,
    transient ? "uncertain" : "blocked", undefined, {
      origin: "provider_response", provider: "meta_graph", operation,
      httpStatus: response.status,
      ...(source?.code !== undefined ? { providerErrorCode: source.code } : {}),
      ...(source?.error_subcode !== undefined ? { providerErrorSubcode: source.error_subcode } : {}),
      ...(originalMessage.value !== null ? { providerErrorMessage: originalMessage.value } : {}),
      ...(details.details !== undefined ? { providerErrorDetails: details.details } : {}),
      ...(requestId(response) ?? (typeof source?.fbtrace_id === "string" ? source.fbtrace_id.slice(0, 128) : null)
        ? { providerRequestId: requestId(response) ?? source?.fbtrace_id?.slice(0, 128) } : {}),
      reasonCode: appThrottle ? "META_SAMPLE_APP_THROTTLED" : `META_${operation.toUpperCase()}_${transient ? "TRANSIENT" : "REJECTED"}`,
      redactionApplied: tokenRedacted || originalMessage.redactionApplied || details.redactionApplied,
      truncated: originalMessage.truncated || details.truncated || raw.length > 4096,
      ...(raw && !source ? { providerErrorBody: originalMessage.value } : {}),
    });
}

function sourceFailure(error: unknown, operation: "sample_fetch" | "sample_session" | "sample_upload", token: string, sensitive: readonly string[] = []): MetaManagementError {
  if (error instanceof MetaManagementError) return error;
  if (error instanceof ShopBrandMediaError) {
    const code = `META_SAMPLE_FETCH_${error.code}`;
    return new MetaManagementError(code, error.retryable ? "uncertain" : "blocked", { cause: error }, {
      origin: "internal", operation: "sample_fetch", reasonCode: code, retryable: error.retryable,
    });
  }
  const cause = error instanceof Error ? error : new Error("unknown-sdk-exception");
  const message = bounded(cause.message, 512, token, sensitive);
  const safeCause = sensitive.length ? Object.assign(new Error(message.value ?? "sample transport failed"), { name: cause.name }) : cause;
  return new MetaManagementError(`META_${operation.toUpperCase()}_TRANSPORT`, "uncertain", { cause: safeCause }, {
    origin: "sdk_exception", operation, reasonCode: `META_${operation.toUpperCase()}_TRANSPORT`,
    errorName: cause.name.slice(0, 64), errorMessage: message.value,
    redactionApplied: message.redactionApplied, truncated: message.truncated,
    causeName: cause.cause instanceof Error ? cause.cause.name.slice(0, 64) : undefined,
    causeMessage: cause.cause instanceof Error ? bounded(cause.cause.message, 512, token, sensitive).value : undefined,
  });
}

export class MetaImageHeaderSampleUploader {
  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly source: MetaTemplateSampleSource = createProductionMetaTemplateSampleSource(),
  ) {}

  async upload(input: { appId: string; accessToken: string; graphBase: string; signal?: AbortSignal; beforeHttp?: () => Promise<void> }): Promise<TrustedMetaImageSampleHandle> {
    if (!/^\d{1,32}$/.test(input.appId) || !input.accessToken || input.accessToken.length > 4096) {
      throw new MetaManagementError("META_APP_CONFIGURATION_INVALID", "blocked");
    }
    let image;
    try { image = await withSignal(this.source.read(input.signal), input.signal ?? AbortSignal.timeout(90_000)); }
    catch (error) { throw sourceFailure(error, "sample_fetch", input.accessToken); }
    validateMetaTemplateSample(image.bytes, image.declaredContentType);

    const base = input.graphBase.replace(/\/+$/, "");
    const sessionUrl = new URL(`${base}/${input.appId}/uploads`);
    sessionUrl.search = new URLSearchParams({ file_length: String(image.bytes.length), file_type: "image/jpeg", file_name: SAMPLE_FILE_NAME }).toString();
    const sessionSignal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
    await input.beforeHttp?.();
    sessionSignal.throwIfAborted();
    let session: Response;
    try {
      session = await withSignal(this.request(sessionUrl, { method: "POST", headers: { Authorization: `OAuth ${input.accessToken}` }, signal: sessionSignal }), sessionSignal);
    } catch (error) { throw sourceFailure(error, "sample_session", input.accessToken); }
    if (!session.ok) throw await failure(session, "sample_session", input.accessToken, sessionSignal);
    let sessionJson: unknown;
    try { sessionJson = await boundedJson(session, sessionSignal); }
    catch (error) { throw sourceFailure(error, "sample_session", input.accessToken); }
    const sessionId = sessionJson && typeof sessionJson === "object" && "id" in sessionJson
      ? (sessionJson as { id?: unknown }).id : undefined;
    const uploadUrl = uploadSessionUrl(base, sessionId);
    if (!uploadUrl) {
      throw new MetaManagementError("META_UPLOAD_SESSION_INVALID", "uncertain", undefined, {
        origin: "provider_response", provider: "meta_graph", operation: "sample_session",
        reasonCode: "META_UPLOAD_SESSION_INVALID", httpStatus: session.status,
      });
    }
    const sessionIdentity = sessionId as string;
    const sensitive = [sessionIdentity, sessionIdentity.slice(7).split("?", 1)[0]!, uploadUrl.searchParams.get("sig") ?? ""];

    const uploadSignal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    await input.beforeHttp?.();
    uploadSignal.throwIfAborted();
    let uploaded: Response;
    try {
      uploaded = await withSignal(this.request(uploadUrl, {
        method: "POST", headers: { Authorization: `OAuth ${input.accessToken}`, file_offset: "0", "Content-Type": "application/octet-stream" },
        body: new Uint8Array(image.bytes), signal: uploadSignal,
      }), uploadSignal);
    } catch (error) { throw sourceFailure(error, "sample_upload", input.accessToken, sensitive); }
    if (!uploaded.ok) throw await failure(uploaded, "sample_upload", input.accessToken, uploadSignal, sensitive);
    let uploadedJson: unknown;
    try { uploadedJson = await boundedJson(uploaded, uploadSignal); }
    catch (error) { throw sourceFailure(error, "sample_upload", input.accessToken, sensitive); }
    const handle = uploadedJson && typeof uploadedJson === "object" && "h" in uploadedJson
      ? (uploadedJson as { h?: unknown }).h : undefined;
    if (typeof handle !== "string" || handle.length < 5 || handle.length > 4096 ||
        /^(?:https?:\/\/|data:|file:)/i.test(handle) ||
        !/^[A-Za-z0-9+/_:.=-]+$/.test(handle)) {
      throw new MetaManagementError("META_UPLOAD_HANDLE_INVALID", "uncertain", undefined, {
        origin: "provider_response", provider: "meta_graph", operation: "sample_upload",
        reasonCode: "META_UPLOAD_HANDLE_INVALID", httpStatus: uploaded.status,
      });
    }
    const trusted = Object.freeze({ value: handle });
    trustedHandles.add(trusted);
    return trusted;
  }
}

function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("sample-deadline"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("sample-deadline")); signal.addEventListener("abort", abort, {once:true});
    promise.then(value => {signal.removeEventListener("abort", abort);resolve(value);}, error => {signal.removeEventListener("abort", abort);reject(error);});
  });
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("sample-json-empty");
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const next = await withSignal(reader.read(), signal); if (next.done) break;
    size += next.value.length; if (size > 8192) throw new Error("sample-json-too-large"); chunks.push(next.value);
  } return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally { void reader.cancel().catch(() => {}); }
}
