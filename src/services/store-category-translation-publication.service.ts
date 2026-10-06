import { createHash, randomUUID } from "node:crypto";

import {
  CommerceAuditAction,
  CommerceAuditActorType,
  CommerceStoreCategoryTranslationEntityKind,
  CommerceStoreCategoryTranslationField,
  CommerceStoreCategoryTranslationItemStatus,
  CommerceStoreCategoryTranslationRunStatus,
  Prisma,
} from "@prisma/client";
import {
  validateStoreCategoryPromptTemplate,
} from "@modainteract/moda-interact-shared/commerce";
import {
  MODA_SUPPORTED_LANGUAGE_TAGS,
} from "@modainteract/moda-interact-shared/internationalization";
import { createLogger } from "@modainteract/moda-interact-shared/logging";

import prisma from "../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";

const SOURCE_SCHEMA_VERSION = 1;
const SOURCE_LANGUAGE_TAG = "en";
const STALE_FAILURE_CODE = "SOURCE_CONFIGURATION_CHANGED";
const INVALID_TRANSLATION_SET_FAILURE_CODE = "TRANSLATION_SET_INVALID";
const UNSUPPORTED_SOURCE_SCHEMA_FAILURE_CODE = "UNSUPPORTED_SOURCE_SCHEMA";
const INVALID_CONDITIONAL_PROMPT_FAILURE_CODE = "INVALID_CONDITIONAL_PROMPT";

const logger = createLogger({
  serviceName: "moda-merchant-communications-worker",
  environment: resolveDeploymentEnvironmentName(),
});

type PublicationDatabase = Pick<typeof prisma, "$queryRaw" | "$transaction">;

type CurrentMapping = {
  id: string;
  editVersion: number;
  conditionKey: string;
  displayName: string;
  shopifyTaxonomyCategoryId: string;
  weight: number;
};

type CurrentCategory = {
  id: string;
  editVersion: number;
  slug: string;
  displayName: string;
  description: string;
  displayOrder: number;
  referenceTaxonomySource: string | null;
  referenceTaxonomyVersion: string | null;
  referenceTaxonomyCategoryId: string | null;
  enabled: boolean;
  defaultTemplate: {
    id: string;
    editVersion: number;
    key: string;
    displayName: string;
    description: string;
    promptText: string;
    enabled: boolean;
    categoryId: string;
  } | null;
  taxonomyMappings: Array<{
    id: string;
    editVersion: number;
    conditionKey: string | null;
    displayName: string | null;
    shopifyTaxonomyCategoryId: string;
    weight: number;
  }>;
};

type TranslationItem = {
  id: string;
  sourceEntityKind: CommerceStoreCategoryTranslationEntityKind;
  sourceEntityId: string;
  sourceField: CommerceStoreCategoryTranslationField;
  sourceLanguageTag: string;
  targetLanguageTag: string;
  sourceText: string;
  translatedText: string | null;
  status: CommerceStoreCategoryTranslationItemStatus;
};

type PublicationPayload = {
  categoryTranslations: Array<{
    id: string;
    categoryId: string;
    locale: string;
    displayName: string;
    description: string;
  }>;
  mappingTranslations: Array<{
    id: string;
    mappingId: string;
    locale: string;
    displayName: string;
  }>;
};

export type StoreCategoryTranslationPublicationOutcome =
  | { status: "published"; runId: string; categoryId: string; categoryTranslations: number; mappingTranslations: number }
  | { status: "stale"; runId: string; categoryId: string; expectedSourceHash: string; currentSourceHash: string | null }
  | { status: "failed"; runId: string; categoryId: string; failureCode: string }
  | { status: "skipped"; runId: string };

export type StoreCategoryTranslationPublicationReconciliationResult = {
  published: number;
  stale: number;
  failed: number;
  retryableFailures: number;
};

function canonicalSnapshot(input: {
  category: {
    id: string;
    editVersion: number;
    slug: string;
    displayName: string;
    description: string;
    displayOrder: number;
    referenceTaxonomySource: string | null;
    referenceTaxonomyVersion: string | null;
    referenceTaxonomyCategoryId: string | null;
  };
  template: {
    id: string;
    editVersion: number;
    key: string;
    displayName: string;
    description: string;
    promptText: string;
  };
  mappings: CurrentMapping[];
}) {
  return {
    schemaVersion: SOURCE_SCHEMA_VERSION,
    category: input.category,
    defaultTemplate: input.template,
    mappings: [...input.mappings].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function hashSnapshot(snapshot: ReturnType<typeof canonicalSnapshot>): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function translationItemKey(input: {
  entityKind: CommerceStoreCategoryTranslationEntityKind;
  entityId: string;
  field: CommerceStoreCategoryTranslationField;
  locale: string;
}): string {
  return `${input.entityKind}\u0000${input.entityId}\u0000${input.field}\u0000${input.locale}`;
}

function buildPublicationPayload(input: {
  category: Pick<CurrentCategory, "id" | "displayName" | "description">;
  mappings: CurrentMapping[];
  items: TranslationItem[];
}): PublicationPayload | null {
  const expected = new Map<string, { sourceText: string }>();
  for (const locale of MODA_SUPPORTED_LANGUAGE_TAGS) {
    expected.set(
      translationItemKey({
        entityKind: CommerceStoreCategoryTranslationEntityKind.CATEGORY,
        entityId: input.category.id,
        field: CommerceStoreCategoryTranslationField.DISPLAY_NAME,
        locale,
      }),
      { sourceText: input.category.displayName },
    );
    expected.set(
      translationItemKey({
        entityKind: CommerceStoreCategoryTranslationEntityKind.CATEGORY,
        entityId: input.category.id,
        field: CommerceStoreCategoryTranslationField.DESCRIPTION,
        locale,
      }),
      { sourceText: input.category.description },
    );
    for (const mapping of input.mappings) {
      expected.set(
        translationItemKey({
          entityKind: CommerceStoreCategoryTranslationEntityKind.MAPPING,
          entityId: mapping.id,
          field: CommerceStoreCategoryTranslationField.DISPLAY_NAME,
          locale,
        }),
        { sourceText: mapping.displayName },
      );
    }
  }

  if (input.items.length !== expected.size) return null;

  const actual = new Map<string, TranslationItem>();
  for (const item of input.items) {
    if (
      item.status !== CommerceStoreCategoryTranslationItemStatus.AVAILABLE ||
      item.sourceLanguageTag !== SOURCE_LANGUAGE_TAG ||
      item.translatedText === null
    ) {
      return null;
    }
    const key = translationItemKey({
      entityKind: item.sourceEntityKind,
      entityId: item.sourceEntityId,
      field: item.sourceField,
      locale: item.targetLanguageTag,
    });
    const expectedItem = expected.get(key);
    if (!expectedItem || expectedItem.sourceText !== item.sourceText || actual.has(key)) {
      return null;
    }
    if (item.targetLanguageTag === SOURCE_LANGUAGE_TAG && item.translatedText !== item.sourceText) {
      return null;
    }
    actual.set(key, item);
  }
  if (actual.size !== expected.size) return null;

  const categoryTranslations = MODA_SUPPORTED_LANGUAGE_TAGS.map((locale) => {
    const display = actual.get(
      translationItemKey({
        entityKind: CommerceStoreCategoryTranslationEntityKind.CATEGORY,
        entityId: input.category.id,
        field: CommerceStoreCategoryTranslationField.DISPLAY_NAME,
        locale,
      }),
    );
    const description = actual.get(
      translationItemKey({
        entityKind: CommerceStoreCategoryTranslationEntityKind.CATEGORY,
        entityId: input.category.id,
        field: CommerceStoreCategoryTranslationField.DESCRIPTION,
        locale,
      }),
    );
    if (!display || !description || display.translatedText === null || description.translatedText === null) {
      throw new Error("Validated Store Category translation items became incomplete");
    }
    return {
      id: randomUUID(),
      categoryId: input.category.id,
      locale,
      displayName: display.translatedText,
      description: description.translatedText,
    };
  });

  const mappingTranslations = input.mappings.flatMap((mapping) =>
    MODA_SUPPORTED_LANGUAGE_TAGS.map((locale) => {
      const display = actual.get(
        translationItemKey({
          entityKind: CommerceStoreCategoryTranslationEntityKind.MAPPING,
          entityId: mapping.id,
          field: CommerceStoreCategoryTranslationField.DISPLAY_NAME,
          locale,
        }),
      );
      if (!display || display.translatedText === null) {
        throw new Error("Validated mapping translation items became incomplete");
      }
      return {
        id: randomUUID(),
        mappingId: mapping.id,
        locale,
        displayName: display.translatedText,
      };
    }),
  );

  return { categoryTranslations, mappingTranslations };
}

function normalizeMappings(category: CurrentCategory): CurrentMapping[] | null {
  const mappings: CurrentMapping[] = [];
  for (const mapping of category.taxonomyMappings) {
    const conditionKey = mapping.conditionKey?.trim();
    const displayName = mapping.displayName?.trim();
    if (!conditionKey || !displayName) return null;
    mappings.push({
      id: mapping.id,
      editVersion: mapping.editVersion,
      conditionKey,
      displayName,
      shopifyTaxonomyCategoryId: mapping.shopifyTaxonomyCategoryId,
      weight: mapping.weight,
    });
  }
  return mappings.sort((left, right) => left.id.localeCompare(right.id));
}

function currentSnapshot(category: CurrentCategory, mappings: CurrentMapping[]) {
  const template = category.defaultTemplate;
  if (!template) return null;
  return canonicalSnapshot({
    category: {
      id: category.id,
      editVersion: category.editVersion,
      slug: category.slug,
      displayName: category.displayName,
      description: category.description,
      displayOrder: category.displayOrder,
      referenceTaxonomySource: category.referenceTaxonomySource,
      referenceTaxonomyVersion: category.referenceTaxonomyVersion,
      referenceTaxonomyCategoryId: category.referenceTaxonomyCategoryId,
    },
    template: {
      id: template.id,
      editVersion: template.editVersion,
      key: template.key,
      displayName: template.displayName,
      description: template.description,
      promptText: template.promptText,
    },
    mappings,
  });
}

function deterministicFailure(
  transaction: Prisma.TransactionClient,
  runId: string,
  failureCode: string,
): Promise<{ count: number }> {
  return transaction.commerceStoreCategoryTranslationRun.updateMany({
    where: {
      id: runId,
      status: CommerceStoreCategoryTranslationRunStatus.READY_TO_PUBLISH,
    },
    data: {
      status: CommerceStoreCategoryTranslationRunStatus.FAILED,
      failureCode,
      completedAt: new Date(),
    },
  });
}

function staleRun(
  transaction: Prisma.TransactionClient,
  runId: string,
): Promise<{ count: number }> {
  return transaction.commerceStoreCategoryTranslationRun.updateMany({
    where: {
      id: runId,
      status: CommerceStoreCategoryTranslationRunStatus.READY_TO_PUBLISH,
    },
    data: {
      status: CommerceStoreCategoryTranslationRunStatus.STALE,
      failureCode: STALE_FAILURE_CODE,
      completedAt: new Date(),
    },
  });
}

export class StoreCategoryTranslationPublicationService {
  private readonly database: PublicationDatabase;

  constructor(options: { database?: PublicationDatabase } = {}) {
    this.database = options.database ?? prisma;
  }

  async reconcile(limit: number): Promise<StoreCategoryTranslationPublicationReconciliationResult> {
    const rows = await this.database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "commerce"."CommerceStoreCategoryTranslationRun"
      WHERE "status" = 'READY_TO_PUBLISH'
      ORDER BY "readyToPublishAt", "requestedAt", "id"
      LIMIT ${limit}
    `);

    const result: StoreCategoryTranslationPublicationReconciliationResult = {
      published: 0,
      stale: 0,
      failed: 0,
      retryableFailures: 0,
    };

    for (const row of rows) {
      try {
        const outcome = await this.publish({ translationRunId: row.id });
        if (outcome.status === "published") result.published += 1;
        if (outcome.status === "stale") result.stale += 1;
        if (outcome.status === "failed") result.failed += 1;
      } catch (error) {
        result.retryableFailures += 1;
        logger.error("background.store_category_translation.run_publish_retryable_failure", {
          runId: row.id,
          failureCode: error instanceof Error ? error.name : "publication-failed",
        });
      }
    }

    return result;
  }

  async publish(input: { translationRunId: string }): Promise<StoreCategoryTranslationPublicationOutcome> {
    const startedAt = Date.now();
    const outcome = await this.database.$transaction(
      async (transaction) => {
        await transaction.$queryRaw(Prisma.sql`
          SELECT "id"
          FROM "commerce"."CommerceStoreCategoryTranslationRun"
          WHERE "id" = ${input.translationRunId}
          FOR UPDATE
        `);
        const run = await transaction.commerceStoreCategoryTranslationRun.findUnique({
          where: { id: input.translationRunId },
          select: {
            id: true,
            categoryId: true,
            environment: true,
            translationModelConfigurationId: true,
            sourceSchemaVersion: true,
            sourceHash: true,
            status: true,
            requestedByAdminId: true,
          },
        });
        if (!run || run.status !== CommerceStoreCategoryTranslationRunStatus.READY_TO_PUBLISH) {
          return { status: "skipped", runId: input.translationRunId } as const;
        }

        if (run.sourceSchemaVersion !== SOURCE_SCHEMA_VERSION) {
          await deterministicFailure(transaction, run.id, UNSUPPORTED_SOURCE_SCHEMA_FAILURE_CODE);
          return {
            status: "failed",
            runId: run.id,
            categoryId: run.categoryId,
            failureCode: UNSUPPORTED_SOURCE_SCHEMA_FAILURE_CODE,
          } as const;
        }

        await transaction.$queryRaw(Prisma.sql`
          SELECT "id"
          FROM "commerce"."CommercePromptTemplateCategory"
          WHERE "id" = ${run.categoryId}
          FOR UPDATE
        `);
        await transaction.$queryRaw(Prisma.sql`
          SELECT "id"
          FROM "commerce"."CommerceStoreCategoryTaxonomyMapping"
          WHERE "categoryId" = ${run.categoryId}
          ORDER BY "id"
          FOR UPDATE
        `);

        const category = await transaction.commercePromptTemplateCategory.findUnique({
          where: { id: run.categoryId },
          select: {
            id: true,
            editVersion: true,
            slug: true,
            displayName: true,
            description: true,
            displayOrder: true,
            referenceTaxonomySource: true,
            referenceTaxonomyVersion: true,
            referenceTaxonomyCategoryId: true,
            enabled: true,
            defaultTemplate: {
              select: {
                id: true,
                editVersion: true,
                key: true,
                displayName: true,
                description: true,
                promptText: true,
                enabled: true,
                categoryId: true,
              },
            },
            taxonomyMappings: {
              orderBy: [{ id: "asc" }],
              select: {
                id: true,
                editVersion: true,
                conditionKey: true,
                displayName: true,
                shopifyTaxonomyCategoryId: true,
                weight: true,
              },
            },
          },
        }) as CurrentCategory | null;

        const mappings = category ? normalizeMappings(category) : null;
        const snapshot = category && mappings ? currentSnapshot(category, mappings) : null;
        const currentHash = snapshot ? hashSnapshot(snapshot) : null;
        if (
          !category ||
          category.enabled ||
          !category.defaultTemplate ||
          !category.defaultTemplate.enabled ||
          category.defaultTemplate.categoryId !== category.id ||
          !mappings ||
          !snapshot ||
          currentHash !== run.sourceHash
        ) {
          await staleRun(transaction, run.id);
          return {
            status: "stale",
            runId: run.id,
            categoryId: run.categoryId,
            expectedSourceHash: run.sourceHash,
            currentSourceHash: currentHash,
          } as const;
        }

        const promptValidation = validateStoreCategoryPromptTemplate({
          source: category.defaultTemplate.promptText,
          availableConditionKeys: mappings.map((mapping) => mapping.conditionKey),
        });
        if (!promptValidation.valid) {
          await deterministicFailure(transaction, run.id, INVALID_CONDITIONAL_PROMPT_FAILURE_CODE);
          return {
            status: "failed",
            runId: run.id,
            categoryId: run.categoryId,
            failureCode: INVALID_CONDITIONAL_PROMPT_FAILURE_CODE,
          } as const;
        }

        const items = await transaction.commerceStoreCategoryTranslationItem.findMany({
          where: { runId: run.id },
          orderBy: [{ targetLanguageTag: "asc" }, { sourceEntityKind: "asc" }, { sourceEntityId: "asc" }, { sourceField: "asc" }],
          select: {
            id: true,
            sourceEntityKind: true,
            sourceEntityId: true,
            sourceField: true,
            sourceLanguageTag: true,
            targetLanguageTag: true,
            sourceText: true,
            translatedText: true,
            status: true,
          },
        });
        const payload = buildPublicationPayload({ category, mappings, items });
        if (!payload) {
          await deterministicFailure(transaction, run.id, INVALID_TRANSLATION_SET_FAILURE_CODE);
          return {
            status: "failed",
            runId: run.id,
            categoryId: run.categoryId,
            failureCode: INVALID_TRANSLATION_SET_FAILURE_CODE,
          } as const;
        }

        await transaction.commercePromptTemplateCategoryTranslation.deleteMany({
          where: { categoryId: category.id },
        });
        if (mappings.length > 0) {
          await transaction.commerceStoreCategoryTaxonomyMappingTranslation.deleteMany({
            where: { mappingId: { in: mappings.map((mapping) => mapping.id) } },
          });
        }
        await transaction.commercePromptTemplateCategoryTranslation.createMany({
          data: payload.categoryTranslations,
        });
        if (payload.mappingTranslations.length > 0) {
          await transaction.commerceStoreCategoryTaxonomyMappingTranslation.createMany({
            data: payload.mappingTranslations,
          });
        }

        const categoryUpdated = await transaction.commercePromptTemplateCategory.updateMany({
          where: {
            id: category.id,
            enabled: false,
            editVersion: category.editVersion,
          },
          data: {
            enabled: true,
            editVersion: { increment: 1 },
            updatedByAdminId: run.requestedByAdminId,
          },
        });
        if (categoryUpdated.count !== 1) {
          throw new Error("Store Category changed during translation publication");
        }

        const runUpdated = await transaction.commerceStoreCategoryTranslationRun.updateMany({
          where: {
            id: run.id,
            status: CommerceStoreCategoryTranslationRunStatus.READY_TO_PUBLISH,
          },
          data: {
            status: CommerceStoreCategoryTranslationRunStatus.SUCCEEDED,
            failureCode: null,
            completedAt: new Date(),
          },
        });
        if (runUpdated.count !== 1) {
          throw new Error("Store Category translation run changed during publication");
        }

        await transaction.commerceAuditEvent.create({
          data: {
            actorType: CommerceAuditActorType.PLATFORM_ADMIN,
            actorAdminId: run.requestedByAdminId,
            operationId: `store-category-translation-publish:${run.id}`,
            action: CommerceAuditAction.ENABLE_PROMPT_TEMPLATE_CATEGORY,
            environment: run.environment,
            promptTemplateCategoryId: category.id,
            promptTemplateId: category.defaultTemplate.id,
            translationModelConfigurationId: run.translationModelConfigurationId,
            reason: "Store Category enabled after successful translation publication.",
            metadata: {
              translationRunId: run.id,
              sourceHash: run.sourceHash,
              localeCount: MODA_SUPPORTED_LANGUAGE_TAGS.length,
              mappingCount: mappings.length,
              categoryTranslationCount: payload.categoryTranslations.length,
              mappingTranslationCount: payload.mappingTranslations.length,
            },
          },
        });

        return {
          status: "published",
          runId: run.id,
          categoryId: category.id,
          categoryTranslations: payload.categoryTranslations.length,
          mappingTranslations: payload.mappingTranslations.length,
        } as const;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 20_000,
      },
    );

    if (outcome.status === "published") {
      logger.info("background.store_category_translation.run_published", {
        runId: outcome.runId,
        categoryId: outcome.categoryId,
        categoryTranslationCount: outcome.categoryTranslations,
        mappingTranslationCount: outcome.mappingTranslations,
        durationMs: Date.now() - startedAt,
      });
    } else if (outcome.status === "stale") {
      logger.warn("background.store_category_translation.run_stale", {
        runId: outcome.runId,
        categoryId: outcome.categoryId,
        failureCode: STALE_FAILURE_CODE,
        expectedSourceHash: outcome.expectedSourceHash,
        currentSourceHash: outcome.currentSourceHash,
        durationMs: Date.now() - startedAt,
      });
    } else if (outcome.status === "failed") {
      logger.error("background.store_category_translation.run_publication_failed", {
        runId: outcome.runId,
        categoryId: outcome.categoryId,
        failureCode: outcome.failureCode,
        durationMs: Date.now() - startedAt,
      });
    }

    return outcome;
  }
}

export const storeCategoryTranslationPublicationService =
  new StoreCategoryTranslationPublicationService();

export const storeCategoryTranslationPublicationTestInternals = {
  canonicalSnapshot,
  hashSnapshot,
  buildPublicationPayload,
};
