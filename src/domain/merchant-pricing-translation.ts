import { z } from "zod";

export const MERCHANT_PRICING_TRANSLATION_SCHEMA_VERSION = 1 as const;

export const MERCHANT_PRICING_TRANSLATION_JOB_NAMES = {
  BATCH_SUBMIT: "merchant-pricing-translation-batch-submit",
  BATCH_POLL: "merchant-pricing-translation-batch-poll",
  BATCH_RESULTS: "merchant-pricing-translation-batch-results",
} as const;

const TranslationBatchIdSchema = z.string().trim().min(1).max(255);

export const MerchantPricingTranslationBatchSubmitJobSchema = z.object({
  schemaVersion: z.literal(MERCHANT_PRICING_TRANSLATION_SCHEMA_VERSION),
  translationBatchId: TranslationBatchIdSchema,
}).strict();

export const MerchantPricingTranslationBatchPollJobSchema = z.object({
  schemaVersion: z.literal(MERCHANT_PRICING_TRANSLATION_SCHEMA_VERSION),
  translationBatchId: TranslationBatchIdSchema,
  pollSequence: z.number().int().min(1),
}).strict();

export const MerchantPricingTranslationBatchResultsJobSchema = z.object({
  schemaVersion: z.literal(MERCHANT_PRICING_TRANSLATION_SCHEMA_VERSION),
  translationBatchId: TranslationBatchIdSchema,
}).strict();

export type MerchantPricingTranslationBatchSubmitJob = z.infer<
  typeof MerchantPricingTranslationBatchSubmitJobSchema
>;
export type MerchantPricingTranslationBatchPollJob = z.infer<
  typeof MerchantPricingTranslationBatchPollJobSchema
>;
export type MerchantPricingTranslationBatchResultsJob = z.infer<
  typeof MerchantPricingTranslationBatchResultsJobSchema
>;

export function createMerchantPricingTranslationBatchSubmitJobId(batchId: string): string {
  return `merchant-pricing-translation-batch-submit-${batchId}`;
}

export function createMerchantPricingTranslationBatchPollJobId(
  batchId: string,
  pollSequence: number,
): string {
  return `merchant-pricing-translation-batch-poll-${batchId}-${pollSequence}`;
}

export function createMerchantPricingTranslationBatchResultsJobId(batchId: string): string {
  return `merchant-pricing-translation-batch-results-${batchId}`;
}
