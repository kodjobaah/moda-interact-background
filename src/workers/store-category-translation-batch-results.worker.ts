import { StoreCategoryTranslationBatchResultsJobSchema } from "../domain/store-category-translation.js";
import { storeCategoryTranslationBatchResultsService } from "../services/store-category-translation-batch-results.service.js";

export async function handleStoreCategoryTranslationBatchResults(input: unknown): Promise<void> {
  const job = StoreCategoryTranslationBatchResultsJobSchema.parse(input);
  await storeCategoryTranslationBatchResultsService.apply(job);
}
