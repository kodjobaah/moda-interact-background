import { describe, expect, it, vi } from "vitest";
import { MODA_SUPPORTED_LANGUAGE_TAGS } from "@modainteract/moda-interact-shared/internationalization";

import {
  MerchantPricingTranslationPublicationService,
} from "../../../../src/services/merchant-pricing-translation-publication.service.js";
import {
  buildMerchantPricingPublicationPayload,
} from "../../../../src/services/merchant-pricing-translation/publication-payload.js";
import {
  canonicalMerchantPricingPublicationSource,
  merchantPricingPublicationSourceHash,
} from "../../../../src/services/merchant-pricing-translation/publication-source.js";

const HIGHLIGHT_KEY = "11111111-1111-4111-8111-111111111111";

function source() {
  const snapshot = canonicalMerchantPricingPublicationSource({
    schemaVersion: 1,
    shopifyPlanHandle: "growth",
    englishDescription: "Recover more abandoned checkouts.",
    highlights: [
      {
        contentKey: HIGHLIGHT_KEY,
        title: "Fast recovery",
        description: "Reach customers while intent is high.",
      },
    ],
  });
  if (!snapshot) throw new Error("fixture source is invalid");
  return snapshot;
}

function translationItems() {
  const currentSource = source();
  return MODA_SUPPORTED_LANGUAGE_TAGS.flatMap((locale) => [
    {
      sourceEntityKind: "PLAN",
      sourceContentKey: null,
      sourceField: "DESCRIPTION",
      sourceLanguageTag: "en",
      targetLanguageTag: locale,
      sourceText: currentSource.englishDescription,
      translatedText:
        locale === "en"
          ? currentSource.englishDescription
          : `${locale}: ${currentSource.englishDescription}`,
      status: "AVAILABLE",
    },
    {
      sourceEntityKind: "HIGHLIGHT",
      sourceContentKey: HIGHLIGHT_KEY,
      sourceField: "TITLE",
      sourceLanguageTag: "en",
      targetLanguageTag: locale,
      sourceText: currentSource.highlights[0].title,
      translatedText:
        locale === "en"
          ? currentSource.highlights[0].title
          : `${locale}: ${currentSource.highlights[0].title}`,
      status: "AVAILABLE",
    },
    {
      sourceEntityKind: "HIGHLIGHT",
      sourceContentKey: HIGHLIGHT_KEY,
      sourceField: "DESCRIPTION",
      sourceLanguageTag: "en",
      targetLanguageTag: locale,
      sourceText: currentSource.highlights[0].description,
      translatedText:
        locale === "en"
          ? currentSource.highlights[0].description
          : `${locale}: ${currentSource.highlights[0].description}`,
      status: "AVAILABLE",
    },
  ]);
}

function statementText(statement: { strings: readonly string[] }) {
  return statement.strings.join("");
}

describe("Merchant Pricing translation publication", () => {
  it("reconstructs source identity independent of highlight order", () => {
    const first = canonicalMerchantPricingPublicationSource({
      schemaVersion: 1,
      shopifyPlanHandle: "growth",
      englishDescription: "Recover more abandoned checkouts.",
      highlights: [
        {
          contentKey: "22222222-2222-4222-8222-222222222222",
          title: "Second",
          description: "Second description",
        },
        {
          contentKey: HIGHLIGHT_KEY,
          title: "First",
          description: "First description",
        },
      ],
    });
    const second = canonicalMerchantPricingPublicationSource({
      schemaVersion: 1,
      shopifyPlanHandle: "growth",
      englishDescription: "Recover more abandoned checkouts.",
      highlights: [...first!.highlights].reverse(),
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(merchantPricingPublicationSourceHash(first!)).toBe(merchantPricingPublicationSourceHash(second!));
  });

  it("builds exactly 20 plan translations and 20 translations per highlight", () => {
    const payload = buildMerchantPricingPublicationPayload({
      source: source(),
      items: translationItems(),
    });

    expect(payload).not.toBeNull();
    expect(payload?.planTranslations).toHaveLength(MODA_SUPPORTED_LANGUAGE_TAGS.length);
    expect(payload?.highlightTranslations).toHaveLength(
      MODA_SUPPORTED_LANGUAGE_TAGS.length,
    );
    expect(payload?.planTranslations.find((row) => row.locale === "en")).toMatchObject({
      merchantDescription: source().englishDescription,
    });
  });

  it("rejects incomplete, duplicate, failed, source-mismatched, or overlong results", () => {
    const currentSource = source();

    const incomplete = translationItems();
    incomplete.pop();
    expect(buildMerchantPricingPublicationPayload({ source: currentSource, items: incomplete })).toBeNull();

    const duplicate = translationItems();
    duplicate[1] = { ...duplicate[0] };
    expect(buildMerchantPricingPublicationPayload({ source: currentSource, items: duplicate })).toBeNull();

    const failed = translationItems();
    failed[0] = { ...failed[0], status: "FAILED" };
    expect(buildMerchantPricingPublicationPayload({ source: currentSource, items: failed })).toBeNull();

    const sourceMismatch = translationItems();
    sourceMismatch[0] = { ...sourceMismatch[0], sourceText: "different" };
    expect(buildMerchantPricingPublicationPayload({ source: currentSource, items: sourceMismatch })).toBeNull();

    const overlong = translationItems();
    const titleIndex = overlong.findIndex(
      (item) =>
        item.sourceEntityKind === "HIGHLIGHT" &&
        item.sourceField === "TITLE" &&
        item.targetLanguageTag !== "en",
    );
    overlong[titleIndex] = {
      ...overlong[titleIndex],
      translatedText: "x".repeat(121),
    };
    expect(buildMerchantPricingPublicationPayload({ source: currentSource, items: overlong })).toBeNull();
  });

  it("atomically promotes READY_TO_APPLY draft translations to READY while leaving the plan inactive", async () => {
    const currentSource = source();
    const executeRaw = vi.fn(async (statement: { strings: readonly string[] }) => {
      const sql = statementText(statement);
      if (sql.includes("UPDATE \"billing\".\"MerchantPricingPlan\"") ||
          sql.includes("UPDATE \"billing\".\"MerchantPricingTranslationRun\"")) {
        return 1;
      }
      return 1;
    });
    const transaction = {
      $queryRaw: vi.fn(async (statement: { strings: readonly string[] }) => {
        const sql = statementText(statement);
        if (sql.includes('FROM "billing"."MerchantPricingTranslationRun"')) {
          return [
            {
              id: "run-1",
              shopifyPlanHandle: "growth",
              sourceSchemaVersion: 1,
              sourceHash: merchantPricingPublicationSourceHash(currentSource),
              sourceSnapshot: currentSource,
              status: "READY_TO_APPLY",
              requestedByAdminId: "admin-1",
              failureCode: null,
            },
          ];
        }
        if (sql.includes('FROM "billing"."MerchantPricingPlan"')) {
          return [
            {
              id: "plan-1",
              shopifyPlanHandle: "growth",
              publicationStatus: "TRANSLATING",
              currentTranslationRunId: "run-1",
              isActive: false,
            },
          ];
        }
        if (sql.includes('FROM "billing"."MerchantPricingPlanTranslation"')) {
          return [
            {
              locale: "en",
              merchantDescription: currentSource.englishDescription,
            },
          ];
        }
        if (sql.includes('FROM "billing"."MerchantPricingPlanHighlight"')) {
          return [
            {
              highlightId: "highlight-1",
              contentKey: HIGHLIGHT_KEY,
              locale: "en",
              merchantTitle: currentSource.highlights[0].title,
              merchantDescription: currentSource.highlights[0].description,
            },
          ];
        }
        if (sql.includes('FROM "billing"."MerchantPricingTranslationItem"')) {
          return translationItems();
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
      $executeRaw: executeRaw,
    };
    const database = {
      $queryRaw: vi.fn(),
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    };
    const service = new MerchantPricingTranslationPublicationService({
      database: database as any,
    });

    await expect(
      service.finalize({ translationRunId: "run-1" }),
    ).resolves.toMatchObject({
      status: "published",
      runId: "run-1",
      planId: "plan-1",
      planTranslationCount: MODA_SUPPORTED_LANGUAGE_TAGS.length,
      highlightTranslationCount: MODA_SUPPORTED_LANGUAGE_TAGS.length,
    });

    const statements = executeRaw.mock.calls.map(([statement]) => statementText(statement));
    expect(
      statements.some(
        (sql) =>
          sql.includes('UPDATE "billing"."MerchantPricingPlan"') &&
          sql.includes('"publicationStatus" = \'READY\'') &&
          sql.includes('"currentTranslationRunId" = NULL') &&
          sql.includes('"isActive" = false'),
      ),
    ).toBe(true);
    expect(
      statements.some(
        (sql) =>
          sql.includes('UPDATE "billing"."MerchantPricingTranslationRun"') &&
          sql.includes('"status" = \'APPLIED\''),
      ),
    ).toBe(true);
  });

  it("records terminal translation failure on the linked catalogue draft", async () => {
    const executeRaw = vi.fn(async () => 1);
    const transaction = {
      $queryRaw: vi.fn(async (statement: { strings: readonly string[] }) => {
        const sql = statementText(statement);
        if (sql.includes('FROM "billing"."MerchantPricingTranslationRun"')) {
          return [
            {
              id: "run-failed",
              shopifyPlanHandle: "growth",
              sourceSchemaVersion: 1,
              sourceHash: "a".repeat(64),
              sourceSnapshot: source(),
              status: "FAILED",
              requestedByAdminId: "admin-1",
              failureCode: "TRANSLATION_ITEM_FAILED",
            },
          ];
        }
        if (sql.includes('FROM "billing"."MerchantPricingPlan"')) {
          return [
            {
              id: "plan-1",
              shopifyPlanHandle: "growth",
              publicationStatus: "TRANSLATING",
              currentTranslationRunId: "run-failed",
              isActive: false,
            },
          ];
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
      $executeRaw: executeRaw,
    };
    const database = {
      $queryRaw: vi.fn(),
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    };
    const service = new MerchantPricingTranslationPublicationService({
      database: database as any,
    });

    await expect(
      service.finalize({ translationRunId: "run-failed" }),
    ).resolves.toMatchObject({
      status: "failure-recorded",
      runId: "run-failed",
      planId: "plan-1",
      failureCode: "TRANSLATION_ITEM_FAILED",
    });

    expect(
      executeRaw.mock.calls.some(([statement]) => {
        const sql = statementText(statement);
        return (
          sql.includes('UPDATE "billing"."MerchantPricingPlan"') &&
          sql.includes('"publicationStatus" = \'TRANSLATION_FAILED\'') &&
          sql.includes('"isActive" = false')
        );
      }),
    ).toBe(true);
  });
});
