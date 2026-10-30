const MAX_LINE_ITEMS = 100;
const MAX_DISPLAYED_ITEMS = 3;
const MAX_TITLE_LENGTH = 160;
const MAX_SUMMARY_LENGTH = 400;

type SafeItem = Readonly<{ title: string; quantity: number }>;

function safeText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!text || text.length > limit || /[\p{Cc}\p{Cf}{}]/u.test(text) ||
      text.includes("{{") || text.includes("}}")) return null;
  try { encodeURIComponent(text); } catch { return null; }
  return text;
}

function parseItem(value: unknown): SafeItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const title = safeText(item.title, MAX_TITLE_LENGTH);
  const quantity = item.quantity;
  if (!title || typeof quantity !== "number" || !Number.isSafeInteger(quantity) ||
      quantity < 1 || quantity > 99999) return null;

  const variant = safeText(item.variantTitle, MAX_TITLE_LENGTH);
  const displayTitle = variant && variant.toLowerCase() !== "default title" && variant !== title
    ? `${title} (${variant})` : title;
  return { title: displayTitle, quantity };
}

/**
 * Formats only saved Shopify/WooCommerce recovery line facts. Invalid rows are
 * omitted; an empty safe result fails closed at the binding boundary.
 */
export function formatCheckoutItemsSummary(lineItems: unknown, languageTag: string): string | null {
  if (!Array.isArray(lineItems) || lineItems.length === 0 || lineItems.length > MAX_LINE_ITEMS) return null;
  let locale: string;
  try { locale = Intl.getCanonicalLocales(languageTag)[0] ?? "en"; }
  catch { return null; }

  const items = lineItems.map(parseItem).filter((item): item is SafeItem => item !== null);
  if (!items.length) return null;
  const numbers = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const list = new Intl.ListFormat(locale, { style: "long", type: "conjunction" });
  const visible = items.slice(0, MAX_DISPLAYED_ITEMS).map(({ title, quantity }) =>
    `${numbers.format(quantity)} × ${title}`);
  if (items.length > MAX_DISPLAYED_ITEMS) {
    // A compact, language-neutral remainder marker avoids mixing translated
    // list conjunctions with a hard-coded English word such as "more".
    visible.push(`+${numbers.format(items.length - MAX_DISPLAYED_ITEMS)}`);
  }
  const summary = list.format(visible);
  if (summary.length <= MAX_SUMMARY_LENGTH) return summary;
  return `${Array.from(summary).slice(0, MAX_SUMMARY_LENGTH - 1).join("").trimEnd()}…`;
}
