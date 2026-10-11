import { randomUUID } from "node:crypto";

import { MODA_SUPPORTED_LANGUAGE_TAGS } from "@modainteract/moda-interact-shared/internationalization";

import { validateMerchantPricingTranslatedText } from "./result-validation.js";
import {
  MERCHANT_PRICING_PUBLICATION_SOURCE_LANGUAGE_TAG,
  type MerchantPricingTranslationSourceSnapshot,
} from "./publication-source.js";

export type MerchantPricingPublicationTranslationItemRow = {
  sourceEntityKind: string;
  sourceContentKey: string | null;
  sourceField: string;
  sourceLanguageTag: string;
  targetLanguageTag: string;
  sourceText: string;
  translatedText: string | null;
  status: string;
};

export type MerchantPricingPublicationPayload = {
  planTranslations: Array<{
    id: string;
    locale: string;
    merchantDescription: string;
  }>;
  highlightTranslations: Array<{
    id: string;
    contentKey: string;
    locale: string;
    merchantTitle: string;
    merchantDescription: string;
  }>;
};

function itemKey(input: {
  sourceEntityKind: string;
  sourceContentKey: string | null;
  sourceField: string;
  targetLanguageTag: string;
}): string {
  return [
    input.sourceEntityKind,
    input.sourceContentKey ?? "-",
    input.sourceField,
    input.targetLanguageTag,
  ].join("\u0000");
}

export function buildMerchantPricingPublicationPayload(input: {
  source: MerchantPricingTranslationSourceSnapshot;
  items: MerchantPricingPublicationTranslationItemRow[];
}): MerchantPricingPublicationPayload | null {
  const expected = new Map<
    string,
    {
      sourceText: string;
      sourceEntityKind: "PLAN" | "HIGHLIGHT";
      sourceField: "TITLE" | "DESCRIPTION";
      locale: string;
    }
  >();

  for (const locale of MODA_SUPPORTED_LANGUAGE_TAGS) {
    expected.set(
      itemKey({
        sourceEntityKind: "PLAN",
        sourceContentKey: null,
        sourceField: "DESCRIPTION",
        targetLanguageTag: locale,
      }),
      {
        sourceText: input.source.englishDescription,
        sourceEntityKind: "PLAN",
        sourceField: "DESCRIPTION",
        locale,
      },
    );
    for (const highlight of input.source.highlights) {
      expected.set(
        itemKey({
          sourceEntityKind: "HIGHLIGHT",
          sourceContentKey: highlight.contentKey,
          sourceField: "TITLE",
          targetLanguageTag: locale,
        }),
        {
          sourceText: highlight.title,
          sourceEntityKind: "HIGHLIGHT",
          sourceField: "TITLE",
          locale,
        },
      );
      expected.set(
        itemKey({
          sourceEntityKind: "HIGHLIGHT",
          sourceContentKey: highlight.contentKey,
          sourceField: "DESCRIPTION",
          targetLanguageTag: locale,
        }),
        {
          sourceText: highlight.description,
          sourceEntityKind: "HIGHLIGHT",
          sourceField: "DESCRIPTION",
          locale,
        },
      );
    }
  }

  if (input.items.length !== expected.size) return null;

  const translated = new Map<string, string>();
  for (const item of input.items) {
    const key = itemKey(item);
    const expectedItem = expected.get(key);
    if (
      !expectedItem ||
      translated.has(key) ||
      item.status !== "AVAILABLE" ||
      item.sourceLanguageTag !== MERCHANT_PRICING_PUBLICATION_SOURCE_LANGUAGE_TAG ||
      item.sourceText.trim() !== expectedItem.sourceText
    ) {
      return null;
    }
    const validated = validateMerchantPricingTranslatedText(
      {
        sourceEntityKind: expectedItem.sourceEntityKind,
        sourceField: expectedItem.sourceField,
      },
      item.translatedText,
    );
    if (!validated) return null;
    if (
      expectedItem.locale === MERCHANT_PRICING_PUBLICATION_SOURCE_LANGUAGE_TAG &&
      validated !== expectedItem.sourceText
    ) {
      return null;
    }
    translated.set(key, validated);
  }
  if (translated.size !== expected.size) return null;

  const planTranslations = MODA_SUPPORTED_LANGUAGE_TAGS.map((locale) => {
    const value = translated.get(
      itemKey({
        sourceEntityKind: "PLAN",
        sourceContentKey: null,
        sourceField: "DESCRIPTION",
        targetLanguageTag: locale,
      }),
    );
    if (!value) {
      throw new Error("Validated Merchant Pricing plan translations became incomplete");
    }
    return { id: randomUUID(), locale, merchantDescription: value };
  });

  const highlightTranslations = input.source.highlights.flatMap((highlight) =>
    MODA_SUPPORTED_LANGUAGE_TAGS.map((locale) => {
      const title = translated.get(
        itemKey({
          sourceEntityKind: "HIGHLIGHT",
          sourceContentKey: highlight.contentKey,
          sourceField: "TITLE",
          targetLanguageTag: locale,
        }),
      );
      const description = translated.get(
        itemKey({
          sourceEntityKind: "HIGHLIGHT",
          sourceContentKey: highlight.contentKey,
          sourceField: "DESCRIPTION",
          targetLanguageTag: locale,
        }),
      );
      if (!title || !description) {
        throw new Error("Validated Merchant Pricing highlight translations became incomplete");
      }
      return {
        id: randomUUID(),
        contentKey: highlight.contentKey,
        locale,
        merchantTitle: title,
        merchantDescription: description,
      };
    }),
  );

  return { planTranslations, highlightTranslations };
}
