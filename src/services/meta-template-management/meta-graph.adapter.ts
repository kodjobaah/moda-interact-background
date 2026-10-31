import { platformConsumerConfiguration } from "../platform-configuration/consumers.js";
import { DEFAULT_WHATSAPP_API_BASE_URL } from "../whatsapp.service.js";
import {
  MetaManagementError, validatedProviderComponents, type MetaCategory, type MetaComponent,
  type ProviderTemplate, type TemplateIdentity,
} from "./contracts.js";
import { isTrustedMetaImageSampleHandle, MetaImageHeaderSampleUploader, type TrustedMetaImageSampleHandle } from "./image-header-sample.js";

function redactSource(value: string, accessToken: string, limit: number,
  sensitiveValues: readonly string[] = []): { value: string; redacted: boolean; truncated: boolean } {
  let safe = value;
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue) safe = safe.replaceAll(sensitiveValue, "[REDACTED_SAMPLE_HANDLE]");
  }
  safe = safe.replaceAll(accessToken, "[REDACTED]")
    .replace(/(Bearer|OAuth)\s+[^\s,"']+/gi, "$1 [REDACTED]")
    .replace(/(access_token|token|secret|authorization)\s*[:=]\s*[^\s,"'&}]+/gi, "$1=[REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\+?\d[\d(). -]{7,}\d/g, "[REDACTED_PHONE]")
    .replace(/https?:\/\/[^\s"']+/gi, "[REDACTED_URL]");
  const redacted = safe !== value;
  const truncated = safe.length > limit;
  if (truncated) safe = safe.slice(0, limit);
  return { value: safe, redacted, truncated };
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value.subarray(0, maxBytes - size);
      chunks.push(chunk);
      size += chunk.length;
    }
    if (size >= maxBytes) await reader.cancel().catch(() => {});
    return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  } finally {
    reader.releaseLock();
  }
}

export type ProviderReadResult = { kind: "absent" } | { kind: "found"; template: ProviderTemplate };
export interface MetaTemplateProvider {
  verifyWaba(wabaId: string): Promise<void>;
  find(identity: TemplateIdentity): Promise<ProviderReadResult>;
  uploadImageHeaderSample?(wabaId: string): Promise<TrustedMetaImageSampleHandle>;
  create(input: TemplateIdentity & { category: MetaCategory; components: MetaComponent[] },
    trustedSampleHandle?: TrustedMetaImageSampleHandle): Promise<{ id: string }>;
}

/** All network operations are server-side and bound to the active configured WABA.
 * The only POST is /{WABA}/message_templates. No Meta update, adoption or URL fetch.
 */
export class MetaGraphTemplateAdapter implements MetaTemplateProvider {
  constructor(private readonly request: typeof fetch = fetch,
    private readonly sampleUploader = new MetaImageHeaderSampleUploader(request)) {}

  private async configuration(wabaId: string) {
    if (!/^\d{1,32}$/.test(wabaId)) throw new MetaManagementError("INVALID_WABA", "blocked");
    const sender = (await platformConsumerConfiguration.read("messaging.sender")).value;
    if (!sender.accessToken || !sender.businessAccountId || sender.businessAccountId !== wabaId) {
      throw new MetaManagementError("WABA_MISMATCH", "blocked");
    }
    const base = (process.env.WHATSAPP_API_BASE_URL?.trim() || DEFAULT_WHATSAPP_API_BASE_URL).replace(/\/+$/, "");
    return { base, accessToken: sender.accessToken };
  }

  async verifyWaba(wabaId: string) { await this.configuration(wabaId); }

  async uploadImageHeaderSample(wabaId: string): Promise<TrustedMetaImageSampleHandle> {
    const config = await this.configuration(wabaId);
    const appId = process.env.META_APP_ID?.trim() ?? "";
    if (!/^\d{1,32}$/.test(appId)) throw new MetaManagementError("META_APP_ID_MISSING_OR_INVALID", "blocked");
    try {
      return await this.sampleUploader.upload({ appId, accessToken: config.accessToken, graphBase: config.base });
    } catch (error) {
      if (error instanceof MetaManagementError) throw error;
      throw new MetaManagementError("META_SAMPLE_UPLOAD_UNEXPECTED", "uncertain", { cause: error });
    }
  }

  private async call(wabaId: string, method: "GET" | "POST", query: URLSearchParams | null,
    body?: object, sensitiveValues: readonly string[] = []) {
    const config = await this.configuration(wabaId);
    const url = new URL(`${config.base}/${wabaId}/message_templates`);
    if (query) url.search = query.toString();
    let response: Response;
    try {
      response = await this.request(url, {
        method,
        headers: { Authorization: `Bearer ${config.accessToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      const cause = error instanceof Error ? error : new Error("unknown-sdk-exception");
      const message = redactSource(cause.message, config.accessToken, 512, sensitiveValues);
      throw new MetaManagementError("META_TRANSPORT_UNKNOWN", "uncertain", { cause: error }, {
        origin: "sdk_exception", provider: "meta_graph", operation: method === "POST" ? "template_create" : "template_find",
        reasonCode: "META_TRANSPORT_UNKNOWN", errorName: cause.name.slice(0, 64), errorMessage: message.value,
        redactionApplied: message.redacted, truncated: message.truncated,
        ...(cause.cause instanceof Error ? { causeName: cause.cause.name.slice(0, 64),
          causeMessage: redactSource(cause.cause.message, config.accessToken, 512, sensitiveValues).value } : {}),
      });
    }
    if (!response.ok) {
      // A definitive API rejection is not a proof of create success; 429/5xx
      // require bounded retry/reconciliation. Never expose Meta's raw error body.
      const code = response.status === 429 ? "META_RATE_LIMIT" : `META_HTTP_${response.status}`;
      const disposition = response.status === 429 || response.status >= 500 ? "uncertain" : "definitive";
      const rawBody = await boundedResponseText(response.clone(), 4096).catch(() => "");
      const source = (() => { try { return JSON.parse(rawBody) as { error?: Record<string, unknown> }; } catch { return null; } })();
      const details = source?.error;
      const sourceMessage = typeof details?.message === "string" ? details.message : !details && rawBody ? rawBody : undefined;
      const message = sourceMessage ? redactSource(sourceMessage, config.accessToken, 512, sensitiveValues) : undefined;
      const rawRequestId = response.headers.get("x-fb-request-id") ?? response.headers.get("x-fb-trace-id") ??
        (typeof details?.fbtrace_id === "string" ? details.fbtrace_id : null);
      const requestId = rawRequestId ? redactSource(rawRequestId, config.accessToken, 128, sensitiveValues) : null;
      const rawDetails = details?.error_data;
      const detailsText = rawDetails === undefined ? undefined : redactSource(JSON.stringify(rawDetails), config.accessToken, 1024, sensitiveValues);
      const errorCode = typeof details?.code === "string"
        ? redactSource(details.code, config.accessToken, 128, sensitiveValues)
        : null;
      const errorSubcode = typeof details?.error_subcode === "string"
        ? redactSource(details.error_subcode, config.accessToken, 128, sensitiveValues)
        : null;
      throw new MetaManagementError(code, disposition, undefined, {
        origin: "provider_response", provider: "meta_graph", operation: method === "POST" ? "template_create" : "template_find",
        httpStatus: response.status,
        ...(details?.code !== undefined ? { providerErrorCode: errorCode?.value ?? details.code } : {}),
        ...(details?.error_subcode !== undefined ? { providerErrorSubcode: errorSubcode?.value ?? details.error_subcode } : {}),
        ...(message ? { providerErrorMessage: message.value } : {}),
        ...(detailsText ? { providerErrorDetails: detailsText.value } : {}),
        ...(!details && message ? { providerErrorBody: message.value } : {}),
        ...(requestId ? { providerRequestId: requestId.value } : {}),
        reasonCode: code, redactionApplied: !!message?.redacted || !!detailsText?.redacted ||
          !!requestId?.redacted || !!errorCode?.redacted || !!errorSubcode?.redacted,
        truncated: !!message?.truncated || !!detailsText?.truncated || !!requestId?.truncated ||
          !!errorCode?.truncated || !!errorSubcode?.truncated || rawBody.length > 4096,
      });
    }
    try { return await response.json() as unknown; }
    catch (error) {
      const cause = error instanceof Error ? error : new Error("unknown-sdk-exception");
      const message = redactSource(cause.message, config.accessToken, 512, sensitiveValues);
      throw new MetaManagementError("META_RESPONSE_UNKNOWN", "uncertain", { cause: error }, {
        origin: "sdk_exception", provider: "meta_graph", operation: method === "POST" ? "template_create" : "template_find",
        reasonCode: "META_RESPONSE_UNKNOWN", errorName: cause.name.slice(0, 64), errorMessage: message.value,
        redactionApplied: message.redacted, truncated: message.truncated,
      });
    }
  }

  async find(identity: TemplateIdentity): Promise<ProviderReadResult> {
    if (!/^[a-z0-9_]{1,255}$/i.test(identity.name) || !/^[a-zA-Z_]{2,16}$/.test(identity.language)) {
      throw new MetaManagementError("INVALID_PROVIDER_IDENTITY", "blocked");
    }
    const baseQuery = { name: identity.name, fields: "id,name,language,category,status,components", limit: "100" };
    const allMatches: ProviderTemplate[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const query = new URLSearchParams({ ...baseQuery, ...(cursor ? { after: cursor } : {}) });
      const result = await this.call(identity.wabaId, "GET", query);
      if (!result || typeof result !== "object" || !("data" in result)) {
        throw new MetaManagementError("META_LIST_UNVERIFIABLE", "uncertain");
      }
      const page = result as { data?: unknown; paging?: { next?: unknown } };
      if (!Array.isArray(page.data) || page.data.length > 100) {
        throw new MetaManagementError("META_LIST_INCOMPLETE", "uncertain");
      }
      for (const entry of page.data) {
        if (!entry || typeof entry !== "object") {
          throw new MetaManagementError("META_LIST_UNVERIFIABLE", "uncertain");
        }
        const t = entry as Record<string, unknown>;
        if (t.name !== identity.name || t.language !== identity.language) continue;
        if (typeof t.id !== "string" || !/^\d{1,32}$/.test(t.id) || !Array.isArray(t.components) ||
            typeof t.status !== "string" || typeof t.category !== "string") {
          throw new MetaManagementError("META_MATCH_AMBIGUOUS", "uncertain");
        }
        allMatches.push({ ...t, wabaId: identity.wabaId } as ProviderTemplate);
      }
      if (!page.paging?.next) {
        if (page.data.length === 100) throw new MetaManagementError("META_LIST_INCOMPLETE", "uncertain");
        if (page.paging?.next !== undefined &&
            (typeof page.paging.next !== "string" || page.paging.next.length === 0)) {
          throw new MetaManagementError("META_LIST_INCOMPLETE", "uncertain");
        }
        if (allMatches.length > 1) throw new MetaManagementError("META_MATCH_AMBIGUOUS", "uncertain");
        const match = allMatches[0];
        if (!match) return { kind: "absent" };
        if (identity.id && match.id !== identity.id) {
          throw new MetaManagementError("META_PROVIDER_ID_CONFLICT", "uncertain");
        }
        return { kind: "found", template: match };
      }
      // Never follow an untrusted absolute paging URL or expose the Meta token.
      // Only take the `after` cursor from a verified same-origin/same-path URL.
      const next = page.paging.next;
      if (typeof next !== "string") throw new MetaManagementError("META_LIST_INCOMPLETE", "uncertain");
      let parsed: URL;
      try { parsed = new URL(next); }
      catch (error) { throw new MetaManagementError("META_LIST_INCOMPLETE", "uncertain", { cause: error }); }
      const configured = await this.configuration(identity.wabaId);
      const expected = new URL(`${configured.base}/${identity.wabaId}/message_templates`);
      const after = parsed.searchParams.get("after");
      if (parsed.origin !== expected.origin || parsed.pathname !== expected.pathname ||
          !after || after.length > 512 || seenCursors.has(after)) {
        throw new MetaManagementError("META_LIST_INCOMPLETE", "uncertain");
      }
      seenCursors.add(after);
      cursor = after;
    }
    throw new MetaManagementError("META_LIST_INCOMPLETE", "uncertain");
  }

  async create(input: TemplateIdentity & { category: MetaCategory; components: MetaComponent[] },
    trustedSampleHandle?: TrustedMetaImageSampleHandle): Promise<{ id: string }> {
    const hasImage = input.components.some((component) => component.type === "HEADER" && component.format === "IMAGE");
    if (hasImage && (!isTrustedMetaImageSampleHandle(trustedSampleHandle) ||
        !input.components.some((component) => {
          if (component.type !== "HEADER" || component.format !== "IMAGE" || !component.example || typeof component.example !== "object") return false;
          const handles = (component.example as Record<string, unknown>).header_handle;
          return Array.isArray(handles) && handles.length === 1 && handles[0] === trustedSampleHandle.value;
        }))) {
      throw new MetaManagementError("IMAGE_SAMPLE_HANDLE_REQUIRED", "blocked");
    }
    if (!hasImage && trustedSampleHandle !== undefined) throw new MetaManagementError("INVALID_COMPILED_COMPONENTS", "blocked");
    validatedProviderComponents(input.components);
    const sensitiveValues = isTrustedMetaImageSampleHandle(trustedSampleHandle)
      ? [trustedSampleHandle.value]
      : [];
    const result = await this.call(input.wabaId, "POST", null, {
      name: input.name, language: input.language, category: input.category,
      // The exact Admin-prepared components, unchanged (no authoring here).
      components: input.components,
    }, sensitiveValues);
    if (!result || typeof result !== "object" || !("id" in result) ||
        typeof result.id !== "string" || !result.id) {
      throw new MetaManagementError("META_CREATE_ACK_UNKNOWN", "uncertain");
    }
    return { id: result.id };
  }
}
