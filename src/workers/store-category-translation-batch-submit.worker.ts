import { StoreCategoryTranslationBatchSubmitJobSchema } from "../domain/store-category-translation.js";
import { storeCategoryTranslationBatchSubmitService } from "../services/store-category-translation-batch-submit.service.js";

export async function handleStoreCategoryTranslationBatchSubmit(input: unknown): Promise<void> {
  const job = StoreCategoryTranslationBatchSubmitJobSchema.parse(input);
  await storeCategoryTranslationBatchSubmitService.submit(job);
}
