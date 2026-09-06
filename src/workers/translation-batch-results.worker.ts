import { TranslationBatchResultsJobSchema } from "../domain/translation-batch.js";
import { translationBatchResultsService } from "../services/translation-batch-results.service.js";

export async function handleTranslationBatchResults(input: unknown): Promise<void> {
  const job = TranslationBatchResultsJobSchema.parse(input);
  await translationBatchResultsService.apply(job);
}
