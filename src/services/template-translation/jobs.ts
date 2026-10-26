import { z } from "zod";

export const TEMPLATE_TRANSLATION_SCHEMA_VERSION = 1 as const;
export const TEMPLATE_TRANSLATION_JOB_NAMES = {
  SUBMIT: "whatsapp-template-translation-submit",
  POLL: "whatsapp-template-translation-poll",
  RESULTS: "whatsapp-template-translation-results",
} as const;

const BatchId = z.string().min(1).max(255);
export const TemplateTranslationSubmitJobSchema = z.object({
  schemaVersion: z.literal(TEMPLATE_TRANSLATION_SCHEMA_VERSION),
  translationBatchId: BatchId,
}).strict();
export const TemplateTranslationPollJobSchema = TemplateTranslationSubmitJobSchema.extend({
  pollSequence: z.number().int().positive(),
});
export const TemplateTranslationResultsJobSchema = TemplateTranslationSubmitJobSchema;
export const templateTranslationSubmitJobId = (id: string) => `whatsapp-template-translate-submit-${id}`;
export const templateTranslationPollJobId = (id: string, sequence: number) => `whatsapp-template-translate-poll-${id}-${sequence}`;
export const templateTranslationResultsJobId = (id: string) => `whatsapp-template-translate-results-${id}`;
