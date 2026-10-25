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
    const query = new URLSearchParams({ name: identity.name, fields: "id,name,language,category,status,components", limit: "100" });
    const result = await this.call(identity.wabaId, "GET", query);
    if (!result || typeof result !== "object" || !("data" in result)) {
      throw new MetaManagementError("META_LIST_UNVERIFIABLE", "uncertain");
    }
    const page = result as { data?: unknown; paging?: { next?: unknown } };
    if (!Array.isArray(page.data) || page.data.length > 100 || page.paging?.next) {
      throw new MetaManagementError("META_LIST_INCOMPLETE", "uncertain");
    }
    const matches = page.data.filter((entry): entry is ProviderTemplate => {
      if (!entry || typeof entry !== "object") return false;
      const t = entry as Record<string, unknown>;
      return t.name === identity.name && t.language === identity.language &&
        (!identity.id || t.id === identity.id);
    });
    if (matches.length === 0) return { kind: "absent" };
    const match = matches[0];
    if (matches.length !== 1 || !match || typeof match.id !== "string" || !Array.isArray(match.components)) {
      throw new MetaManagementError("META_MATCH_AMBIGUOUS", "uncertain");
    }
    return { kind: "found", template: { ...match, wabaId: identity.wabaId } };
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
