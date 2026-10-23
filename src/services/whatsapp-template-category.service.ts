import { platformConsumerConfiguration } from "./platform-configuration/consumers.js";
import { DEFAULT_WHATSAPP_API_BASE_URL } from "./whatsapp.service.js";

export type MetaTemplateCategory = "MARKETING" | "UTILITY" | "AUTHENTICATION";
export type TemplateCategoryQuery = {
  providerTemplateName: string;
  providerLanguageCode: string;
  providerAccountId?: string;
  providerTemplateId?: string | null;
};
export type TemplateCategoryVerifier = Pick<MetaWhatsAppTemplateCategoryService, "verify">;

/** Trust only an exact Meta WABA/name/language/ID match. `purpose` or local
 * APPROVED status is never category evidence. Meta reads happen outside SQL.
 */
export class MetaWhatsAppTemplateCategoryService {
  constructor(private readonly request: typeof fetch = fetch) {}

  async verify(input: TemplateCategoryQuery): Promise<MetaTemplateCategory | null> {
    try {
      if (!/^[A-Za-z0-9_]{1,255}$/.test(input.providerTemplateName) ||
          !/^[A-Za-z_]{2,20}$/.test(input.providerLanguageCode)) return null;
      const { value: sender } = await platformConsumerConfiguration.read("messaging.sender");
      if (!sender.businessAccountId || !sender.accessToken ||
          (input.providerAccountId && sender.businessAccountId !== input.providerAccountId) ||
          !/^[0-9]{1,32}$/.test(sender.businessAccountId)) return null;
      const base = (process.env.WHATSAPP_API_BASE_URL?.trim() || DEFAULT_WHATSAPP_API_BASE_URL).replace(/\/+$/, "");
      const url = new URL(`${base}/${sender.businessAccountId}/message_templates`);
      url.searchParams.set("name", input.providerTemplateName);
      url.searchParams.set("fields", "id,name,language,category,status");
      url.searchParams.set("limit", "100");
      const response = await this.request(url, {
        headers: { Authorization: `Bearer ${sender.accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !("data" in body) ||
          !Array.isArray(body.data) || body.data.length > 100 ||
          ("paging" in body && body.paging && typeof body.paging === "object" && "next" in body.paging && body.paging.next)) {
        // A truncated provider list cannot prove uniqueness.
        return null;
      }
      const matches = body.data.filter((entry: unknown) => {
        if (!entry || typeof entry !== "object") return false;
        const t = entry as Record<string, unknown>;
        return t.name === input.providerTemplateName && t.language === input.providerLanguageCode &&
          (!input.providerTemplateId || t.id === input.providerTemplateId);
      });
      if (matches.length !== 1) return null;
      const item = matches[0] as Record<string, unknown>;
      if (item.status !== "APPROVED") return null;
      return item.category === "MARKETING" || item.category === "UTILITY" || item.category === "AUTHENTICATION"
        ? item.category : null;
    } catch {
      // Bad credentials, timeouts, network/provider errors, malformed metadata:
      // all fail closed without leaking credentials or permitting fallback.
      return null;
    }
  }
}
export const metaWhatsAppTemplateCategoryService = new MetaWhatsAppTemplateCategoryService();
