import { describe, expect, it } from "vitest";
import {
  CommerceStoreCategoryTranslationEntityKind,
  CommerceStoreCategoryTranslationField,
  CommerceStoreCategoryTranslationItemStatus,
} from "@prisma/client";
import { MODA_SUPPORTED_LANGUAGE_TAGS } from "@modainteract/moda-interact-shared/internationalization";

import { storeCategoryTranslationPublicationTestInternals } from "../../../src/services/store-category-translation-publication.service.js";

const {
  canonicalSnapshot,
  hashSnapshot,
  buildPublicationPayload,
} = storeCategoryTranslationPublicationTestInternals;

function fixtureSnapshot() {
  return canonicalSnapshot({
    category: {
      id: "cat-1",
      editVersion: 4,
      slug: "apparel",
      displayName: "Apparel",
      description: "Clothing and accessories",
      displayOrder: 2,
      referenceTaxonomySource: "SHOPIFY_STANDARD_PRODUCT_TAXONOMY",
      referenceTaxonomyVersion: "2026-08",
      referenceTaxonomyCategoryId: "gid://shopify/TaxonomyCategory/aa",
    },
    template: {
      id: "tpl-1",
      editVersion: 3,
      key: "apparel_default",
      displayName: "Apparel default",
      description: "",
      promptText: "Base\n{% if mappings.shoes %}\nShoes\n{% endif %}",
    },
    mappings: [
      {
        id: "map-1",
        editVersion: 2,
        conditionKey: "shoes",
        displayName: "Shoes",
        shopifyTaxonomyCategoryId: "gid://shopify/TaxonomyCategory/aa-8",
        weight: 1,
      },
    ],
  });
}

function translationItems() {
  const sources = [
    {
      sourceEntityKind: CommerceStoreCategoryTranslationEntityKind.CATEGORY,
      sourceEntityId: "cat-1",
      sourceField: CommerceStoreCategoryTranslationField.DISPLAY_NAME,
      sourceText: "Apparel",
    },
    {
      sourceEntityKind: CommerceStoreCategoryTranslationEntityKind.CATEGORY,
      sourceEntityId: "cat-1",
      sourceField: CommerceStoreCategoryTranslationField.DESCRIPTION,
      sourceText: "Clothing and accessories",
    },
    {
      sourceEntityKind: CommerceStoreCategoryTranslationEntityKind.MAPPING,
      sourceEntityId: "map-1",
      sourceField: CommerceStoreCategoryTranslationField.DISPLAY_NAME,
      sourceText: "Shoes",
    },
  ];

  let sequence = 0;
  return MODA_SUPPORTED_LANGUAGE_TAGS.flatMap((locale) =>
    sources.map((source) => ({
      id: `item-${sequence++}`,
      ...source,
      sourceLanguageTag: "en",
      targetLanguageTag: locale,
      translatedText: locale === "en" ? source.sourceText : `${locale}:${source.sourceText}`,
      status: CommerceStoreCategoryTranslationItemStatus.AVAILABLE,
    })),
  );
}

describe("Store Category translation publication", () => {
  it("reconstructs the Admin source hash deterministically", () => {
    expect(hashSnapshot(fixtureSnapshot())).toBe(
      "ea2bf18cfb8a54698afbbf604ef53a50bfb75fb3f68f1d8d6cf6e3365647d8fd",
    );
  });


  it("sorts mapping identities before hashing so query order cannot change freshness", () => {
    const base = fixtureSnapshot();
    const second = {
      id: "map-2",
      editVersion: 1,
      conditionKey: "bags",
      displayName: "Bags",
      shopifyTaxonomyCategoryId: "gid://shopify/TaxonomyCategory/aa-9",
      weight: 2,
    };
    const left = canonicalSnapshot({
      category: base.category,
      template: base.defaultTemplate,
      mappings: [second, ...base.mappings],
    });
    const right = canonicalSnapshot({
      category: base.category,
      template: base.defaultTemplate,
      mappings: [...base.mappings, second],
    });
    expect(hashSnapshot(left)).toBe(hashSnapshot(right));
  });

  it("publishes exactly 20 Category rows and 20 rows per mapping", () => {
    const payload = buildPublicationPayload({
      category: {
        id: "cat-1",
        displayName: "Apparel",
        description: "Clothing and accessories",
      },
      mappings: fixtureSnapshot().mappings,
      items: translationItems(),
    });

    expect(payload).not.toBeNull();
    expect(payload?.categoryTranslations).toHaveLength(MODA_SUPPORTED_LANGUAGE_TAGS.length);
    expect(payload?.mappingTranslations).toHaveLength(MODA_SUPPORTED_LANGUAGE_TAGS.length);
    expect(payload?.categoryTranslations.find((row) => row.locale === "en")).toMatchObject({
      displayName: "Apparel",
      description: "Clothing and accessories",
    });
  });

  it("rejects incomplete, non-available, duplicate, or source-mismatched item sets", () => {
    const args = {
      category: {
        id: "cat-1",
        displayName: "Apparel",
        description: "Clothing and accessories",
      },
      mappings: fixtureSnapshot().mappings,
    };

    const incomplete = translationItems();
    incomplete.pop();
    expect(buildPublicationPayload({ ...args, items: incomplete })).toBeNull();

    const pending = translationItems();
    pending[0] = { ...pending[0], status: CommerceStoreCategoryTranslationItemStatus.PENDING };
    expect(buildPublicationPayload({ ...args, items: pending })).toBeNull();

    const sourceMismatch = translationItems();
    sourceMismatch[0] = { ...sourceMismatch[0], sourceText: "Different" };
    expect(buildPublicationPayload({ ...args, items: sourceMismatch })).toBeNull();

    const duplicate = translationItems();
    duplicate[1] = { ...duplicate[1], ...duplicate[0], id: duplicate[1].id };
    expect(buildPublicationPayload({ ...args, items: duplicate })).toBeNull();
  });
});
