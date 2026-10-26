import { platformConsumerConfiguration } from "../platform-configuration/consumers.js";
import { DEFAULT_WHATSAPP_API_BASE_URL } from "../whatsapp.service.js";
import {
  MetaManagementError, validatedComponents, type MetaCategory, type MetaComponent,
  type ProviderTemplate, type TemplateIdentity,
} from "./contracts.js";

export type ProviderReadResult = { kind: "absent" } | { kind: "found"; template: ProviderTemplate };
export interface MetaTemplateProvider {
  verifyWaba(wabaId: string): Promise<void>;
  find(identity: TemplateIdentity): Promise<ProviderReadResult>;
  create(input: TemplateIdentity & { category: MetaCategory; components: MetaComponent[] }): Promise<{ id: string }>;
}

/** All network operations are server-side and bound to the active configured WABA.
 * The only POST is /{WABA}/message_templates. No Meta update, adoption or URL fetch.
 */
export class MetaGraphTemplateAdapter implements MetaTemplateProvider {
  constructor(private readonly request: typeof fetch = fetch) {}

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

  private async call(wabaId: string, method: "GET" | "POST", query: URLSearchParams | null, body?: object) {
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
      throw new MetaManagementError("META_TRANSPORT_UNKNOWN", "uncertain", { cause: error });
    }
    if (!response.ok) {
      // A definitive API rejection is not a proof of create success; 429/5xx
      // require bounded retry/reconciliation. Never expose Meta's raw error body.
      const code = response.status === 429 ? "META_RATE_LIMIT" : `META_HTTP_${response.status}`;
      const disposition = response.status === 429 || response.status >= 500 ? "uncertain" : "definitive";
      throw new MetaManagementError(code, disposition);
    }
    try { return await response.json() as unknown; }
    catch (error) { throw new MetaManagementError("META_RESPONSE_UNKNOWN", "uncertain", { cause: error }); }
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

  async create(input: TemplateIdentity & { category: MetaCategory; components: MetaComponent[] }): Promise<{ id: string }> {
    validatedComponents(input.components);
    const result = await this.call(input.wabaId, "POST", null, {
      name: input.name, language: input.language, category: input.category,
      // The exact Admin-prepared components, unchanged (no authoring here).
      components: input.components,
    });
    if (!result || typeof result !== "object" || !("id" in result) ||
        typeof result.id !== "string" || !result.id) {
      throw new MetaManagementError("META_CREATE_ACK_UNKNOWN", "uncertain");
    }
    return { id: result.id };
  }
}
