import { createSafeImageFetcher } from "../shop-brand-media/safe-fetch.js";
import { ShopBrandMediaError } from "../shop-brand-media/contracts.js";
import { MetaManagementError } from "./contracts.js";

export const META_TEMPLATE_SAMPLE_URL = "https://www.modainteract.com/assets/whatsup-sample.jpeg";
const SAMPLE_FILE_NAME = "moda-whatsapp-template-sample.jpeg";
const MAX_BYTES = 5_000_000;
const SAMPLE_FETCHER = createSafeImageFetcher({ maxBytes: MAX_BYTES, maxRedirects: 0 });

export type TrustedMetaImageSampleHandle = Readonly<{ value: string }>;
export type SampleFetcher = Pick<ReturnType<typeof createSafeImageFetcher>, "fetch">;
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

function bounded(value: unknown, limit = 512, token?: string): { value: string | null; truncated: boolean; redactionApplied: boolean } {
  if (typeof value !== "string") return { value: null, truncated: false, redactionApplied: false };
  let result = (token ? value.replaceAll(token, "[REDACTED]") : value)
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

function safeDetails(value: unknown, token: string): { details: unknown; redactionApplied: boolean; truncated: boolean } {
  if (value === undefined) return { details: undefined, redactionApplied: false, truncated: false };
  const raw = (() => { try { return JSON.stringify(value); } catch { return "[UNSERIALIZABLE]"; } })();
  let sanitized = raw.replaceAll(token, "[REDACTED]");
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

async function failure(response: Response, operation: "sample_session" | "sample_upload", token: string): Promise<MetaManagementError> {
  let raw = "";
  try {
    const reader = response.body?.getReader();
    if (reader) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (size < 4096) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value.subarray(0, 4096 - size);
        chunks.push(chunk);
        size += chunk.length;
      }
      await reader.cancel().catch(() => {});
      raw = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
    }
  } catch { /* body absent/read failure is explicit below */ }
  let parsed: { error?: MetaErrorDetails } | null = null;
  try { parsed = JSON.parse(raw) as { error?: MetaErrorDetails }; } catch { /* non-JSON retained only as bounded provider body */ }
  const source = parsed?.error;
  const sourceMessage = source?.message ?? (!source && raw ? raw : undefined);
  const messageWithTokenRedacted = typeof sourceMessage === "string" ? sourceMessage.replaceAll(token, "[REDACTED]") : sourceMessage;
  const tokenRedacted = messageWithTokenRedacted !== sourceMessage;
  const originalMessage = bounded(messageWithTokenRedacted);
  const details = safeDetails(source?.error_data ?? source?.error_user_msg ?? source?.error_user_title, token);
  const transient = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
  return new MetaManagementError(`META_${operation.toUpperCase()}_${transient ? "TRANSIENT" : "REJECTED"}`,
    transient ? "uncertain" : "blocked", undefined, {
      origin: "provider_response", provider: "meta_graph", operation,
      httpStatus: response.status,
      ...(source?.code !== undefined ? { providerErrorCode: source.code } : {}),
      ...(source?.error_subcode !== undefined ? { providerErrorSubcode: source.error_subcode } : {}),
      ...(originalMessage.value !== null ? { providerErrorMessage: originalMessage.value } : {}),
      ...(details.details !== undefined ? { providerErrorDetails: details.details } : {}),
      ...(requestId(response) ?? (typeof source?.fbtrace_id === "string" ? source.fbtrace_id.slice(0, 128) : null)
        ? { providerRequestId: requestId(response) ?? source?.fbtrace_id?.slice(0, 128) } : {}),
      reasonCode: `META_${operation.toUpperCase()}_${transient ? "TRANSIENT" : "REJECTED"}`,
      redactionApplied: tokenRedacted || originalMessage.redactionApplied || details.redactionApplied,
      truncated: originalMessage.truncated || details.truncated || raw.length > 4096,
      ...(raw && !source ? { providerErrorBody: originalMessage.value } : {}),
    });
}

function sourceFailure(error: unknown, operation: "sample_fetch" | "sample_session" | "sample_upload", token: string): MetaManagementError {
  if (error instanceof MetaManagementError) return error;
  if (error instanceof ShopBrandMediaError) {
    const code = `META_SAMPLE_FETCH_${error.code}`;
    return new MetaManagementError(code, error.retryable ? "uncertain" : "blocked", { cause: error }, {
      origin: "internal", operation: "sample_fetch", reasonCode: code, retryable: error.retryable,
    });
  }
  const cause = error instanceof Error ? error : new Error("unknown-sdk-exception");
  const message = bounded(cause.message, 512, token);
  return new MetaManagementError(`META_${operation.toUpperCase()}_TRANSPORT`, "uncertain", { cause }, {
    origin: "sdk_exception", operation, reasonCode: `META_${operation.toUpperCase()}_TRANSPORT`,
    errorName: cause.name.slice(0, 64), errorMessage: message.value,
    redactionApplied: message.redactionApplied, truncated: message.truncated,
    causeName: cause.cause instanceof Error ? cause.cause.name.slice(0, 64) : undefined,
    causeMessage: cause.cause instanceof Error ? bounded(cause.cause.message, 512, token).value : undefined,
  });
}

function isJpeg(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
    bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
}

export class MetaImageHeaderSampleUploader {
  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly fetcher: SampleFetcher = SAMPLE_FETCHER,
  ) {}

  async upload(input: { appId: string; accessToken: string; graphBase: string }): Promise<TrustedMetaImageSampleHandle> {
    if (!/^\d{1,32}$/.test(input.appId) || !input.accessToken || input.accessToken.length > 4096) {
      throw new MetaManagementError("META_APP_CONFIGURATION_INVALID", "blocked");
    }
    let image;
    try { image = await this.fetcher.fetch(META_TEMPLATE_SAMPLE_URL); }
    catch (error) { throw sourceFailure(error, "sample_fetch", input.accessToken); }
    if (image.declaredContentType !== "image/jpeg" || image.bytes.length === 0 || image.bytes.length > MAX_BYTES || !isJpeg(image.bytes)) {
      throw new MetaManagementError("META_SAMPLE_INVALID", "blocked", undefined, {
        origin: "internal", operation: "sample_fetch", reasonCode: "META_SAMPLE_INVALID",
      });
    }

    const base = input.graphBase.replace(/\/+$/, "");
    const sessionUrl = new URL(`${base}/${input.appId}/uploads`);
    sessionUrl.search = new URLSearchParams({ file_length: String(image.bytes.length), file_type: "image/jpeg", file_name: SAMPLE_FILE_NAME }).toString();
    let session: Response;
    try {
      session = await this.request(sessionUrl, { method: "POST", headers: { Authorization: `OAuth ${input.accessToken}` }, signal: AbortSignal.timeout(10_000) });
    } catch (error) { throw sourceFailure(error, "sample_session", input.accessToken); }
    if (!session.ok) throw await failure(session, "sample_session", input.accessToken);
    let sessionJson: unknown;
    try { sessionJson = await session.json(); }
    catch (error) { throw sourceFailure(error, "sample_session", input.accessToken); }
    const sessionId = sessionJson && typeof sessionJson === "object" && "id" in sessionJson
      ? (sessionJson as { id?: unknown }).id : undefined;
    if (typeof sessionId !== "string" || !/^upload:[A-Za-z0-9_-]{8,256}$/.test(sessionId)) {
      throw new MetaManagementError("META_UPLOAD_SESSION_INVALID", "uncertain", undefined, {
        origin: "provider_response", provider: "meta_graph", operation: "sample_session",
        reasonCode: "META_UPLOAD_SESSION_INVALID", httpStatus: session.status,
      });
    }

    let uploaded: Response;
    try {
      uploaded = await this.request(new URL(`${base}/${sessionId}`), {
        method: "POST", headers: { Authorization: `OAuth ${input.accessToken}`, file_offset: "0", "Content-Type": "application/octet-stream" },
        body: new Uint8Array(image.bytes), signal: AbortSignal.timeout(30_000),
      });
    } catch (error) { throw sourceFailure(error, "sample_upload", input.accessToken); }
    if (!uploaded.ok) throw await failure(uploaded, "sample_upload", input.accessToken);
    let uploadedJson: unknown;
    try { uploadedJson = await uploaded.json(); }
    catch (error) { throw sourceFailure(error, "sample_upload", input.accessToken); }
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
