import { z } from "zod";

export const STORE_CATEGORY_TRANSLATION_SCHEMA_VERSION = 1 as const;

export const STORE_CATEGORY_TRANSLATION_JOB_NAMES = {
  BATCH_SUBMIT: "store-category-translation-batch-submit",
  BATCH_POLL: "store-category-translation-batch-poll",
  BATCH_RESULTS: "store-category-translation-batch-results",
} as const;

const TranslationBatchIdSchema = z.string().trim().min(1).max(255);

export const StoreCategoryTranslationBatchSubmitJobSchema = z.object({
  schemaVersion: z.literal(STORE_CATEGORY_TRANSLATION_SCHEMA_VERSION),
  translationBatchId: TranslationBatchIdSchema,
}).strict();

export const StoreCategoryTranslationBatchPollJobSchema = z.object({
  schemaVersion: z.literal(STORE_CATEGORY_TRANSLATION_SCHEMA_VERSION),
  translationBatchId: TranslationBatchIdSchema,
  pollSequence: z.number().int().min(1),
}).strict();

export const StoreCategoryTranslationBatchResultsJobSchema = z.object({
  schemaVersion: z.literal(STORE_CATEGORY_TRANSLATION_SCHEMA_VERSION),
  translationBatchId: TranslationBatchIdSchema,
}).strict();

export type StoreCategoryTranslationBatchSubmitJob = z.infer<
  typeof StoreCategoryTranslationBatchSubmitJobSchema
>;
export type StoreCategoryTranslationBatchPollJob = z.infer<
  typeof StoreCategoryTranslationBatchPollJobSchema
>;
export type StoreCategoryTranslationBatchResultsJob = z.infer<
  typeof StoreCategoryTranslationBatchResultsJobSchema
>;

export function createStoreCategoryTranslationBatchSubmitJobId(batchId: string): string {
  return `store-category-translation-batch-submit-${batchId}`;
}

export function createStoreCategoryTranslationBatchPollJobId(
  batchId: string,
  pollSequence: number,
): string {
  return `store-category-translation-batch-poll-${batchId}-${pollSequence}`;
}

export function createStoreCategoryTranslationBatchResultsJobId(batchId: string): string {
  return `store-category-translation-batch-results-${batchId}`;
}
