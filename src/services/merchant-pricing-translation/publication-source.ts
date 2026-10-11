import { createHash } from "node:crypto";

export const MERCHANT_PRICING_PUBLICATION_SOURCE_SCHEMA_VERSION = 1;
export const MERCHANT_PRICING_PUBLICATION_SOURCE_LANGUAGE_TAG = "en";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MerchantPricingTranslationSourceSnapshot = {
  schemaVersion: 1;
  shopifyPlanHandle: string;
  englishDescription: string;
  highlights: Array<{
    contentKey: string;
    title: string;
    description: string;
  }>;
};

export type MerchantPricingPublicationPlanRow = {
  id: string;
  shopifyPlanHandle: string;
  publicationStatus: string;
  currentTranslationRunId: string | null;
  isActive: boolean;
};

export type MerchantPricingPublicationPlanTranslationRow = {
  locale: string;
  merchantDescription: string;
};

export type MerchantPricingPublicationHighlightTranslationRow = {
  highlightId: string;
  contentKey: string;
  locale: string | null;
  merchantTitle: string | null;
  merchantDescription: string | null;
};

function requiredString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
}

export function canonicalMerchantPricingPublicationSource(
  value: unknown,
): MerchantPricingTranslationSourceSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (
    row.schemaVersion !== MERCHANT_PRICING_PUBLICATION_SOURCE_SCHEMA_VERSION ||
    !Array.isArray(row.highlights)
  ) {
    return null;
  }

  const shopifyPlanHandle = requiredString(row.shopifyPlanHandle, 255);
  const englishDescription = requiredString(row.englishDescription, 2_000);
  if (!shopifyPlanHandle || !englishDescription) return null;

  const seen = new Set<string>();
  const highlights: MerchantPricingTranslationSourceSnapshot["highlights"] = [];
  for (const candidate of row.highlights) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      return null;
    }
    const highlight = candidate as Record<string, unknown>;
    const contentKey = requiredString(highlight.contentKey, 64);
    const title = requiredString(highlight.title, 120);
    const description = requiredString(highlight.description, 500);
    const normalizedContentKey = contentKey?.toLowerCase();
    if (
      !contentKey ||
      !normalizedContentKey ||
      !CANONICAL_UUID.test(contentKey) ||
      seen.has(normalizedContentKey) ||
      !title ||
      !description
    ) {
      return null;
    }
    seen.add(normalizedContentKey);
    highlights.push({ contentKey, title, description });
  }
  highlights.sort((left, right) => left.contentKey.localeCompare(right.contentKey));

  return {
    schemaVersion: MERCHANT_PRICING_PUBLICATION_SOURCE_SCHEMA_VERSION,
    shopifyPlanHandle,
    englishDescription,
    highlights,
  };
}

export function merchantPricingPublicationSourceHash(
  snapshot: MerchantPricingTranslationSourceSnapshot,
): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function currentMerchantPricingPublicationSource(input: {
  plan: MerchantPricingPublicationPlanRow;
  translations: MerchantPricingPublicationPlanTranslationRow[];
  highlights: MerchantPricingPublicationHighlightTranslationRow[];
}): MerchantPricingTranslationSourceSnapshot | null {
  if (
    input.translations.length !== 1 ||
    input.translations[0]?.locale !== MERCHANT_PRICING_PUBLICATION_SOURCE_LANGUAGE_TAG
  ) {
    return null;
  }

  const byHighlight = new Map<
    string,
    MerchantPricingPublicationHighlightTranslationRow[]
  >();
  for (const row of input.highlights) {
    const rows = byHighlight.get(row.highlightId) ?? [];
    rows.push(row);
    byHighlight.set(row.highlightId, rows);
  }

  const highlights: MerchantPricingTranslationSourceSnapshot["highlights"] = [];
  for (const rows of byHighlight.values()) {
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row ||
      row.locale !== MERCHANT_PRICING_PUBLICATION_SOURCE_LANGUAGE_TAG ||
      typeof row.merchantTitle !== "string" ||
      typeof row.merchantDescription !== "string"
    ) {
      return null;
    }
    highlights.push({
      contentKey: row.contentKey,
      title: row.merchantTitle,
      description: row.merchantDescription,
    });
  }

  return canonicalMerchantPricingPublicationSource({
    schemaVersion: MERCHANT_PRICING_PUBLICATION_SOURCE_SCHEMA_VERSION,
    shopifyPlanHandle: input.plan.shopifyPlanHandle,
    englishDescription: input.translations[0].merchantDescription,
    highlights,
  });
}

export function merchantPricingPublicationSourcesMatch(
  expected: MerchantPricingTranslationSourceSnapshot,
  actual: MerchantPricingTranslationSourceSnapshot,
): boolean {
  if (
    expected.shopifyPlanHandle !== actual.shopifyPlanHandle ||
    expected.englishDescription !== actual.englishDescription ||
    expected.highlights.length !== actual.highlights.length
  ) {
    return false;
  }
  const actualByKey = new Map(
    actual.highlights.map((highlight) => [
      highlight.contentKey.toLowerCase(),
      highlight,
    ]),
  );
  return expected.highlights.every((highlight) => {
    const current = actualByKey.get(highlight.contentKey.toLowerCase());
    if (!current) return false;
    return (
      current.title === highlight.title &&
      current.description === highlight.description
    );
  });
}
