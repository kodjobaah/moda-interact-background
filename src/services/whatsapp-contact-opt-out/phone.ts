import { normalizeRecipientPhone } from "@modainteract/moda-interact-shared/identity";

/** Meta wa_id is digits-only international form; never infer a country from locale. */
export function canonicalWhatsAppSender(value: string): string | null {
  const raw = value.trim();
  const international = /^[1-9][0-9]{1,14}$/.test(raw) ? `+${raw}` : raw;
  const parsed = normalizeRecipientPhone(international);
  return parsed.ok ? parsed.e164.slice(1) : null;
}

/** Legacy CustomerPhone.phone may be national; the store country is verified context. */
export function matchesRegisteredPhone(
  stored: { phone: string; whatsappCanonicalPhone: string | null },
  canonical: string,
  verifiedCountry?: string | null,
): boolean {
  if (stored.whatsappCanonicalPhone !== null) {
    return stored.whatsappCanonicalPhone === canonical;
  }
  const raw = stored.phone.trim();
  const asInternational = /^[1-9][0-9]{1,14}$/.test(raw) && raw === canonical
    ? `+${raw}` : raw;
  const parsed = normalizeRecipientPhone(asInternational, asInternational.startsWith("+")
    ? {} : verifiedCountry ? { verifiedCountryCode: verifiedCountry.toUpperCase() } : {});
  return parsed.ok && parsed.e164.slice(1) === canonical;
}

/** Commands only, not an LLM interpretation or a substring in normal speech. */
export function isExplicitWhatsAppStop(content: { type: string; text?: string }): boolean {
  return content.type === "text" && typeof content.text === "string" &&
    /^(STOP|UNSUBSCRIBE)[.!]?$/i.test(content.text.trim());
}
