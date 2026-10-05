import { StoreCategoryTranslationBatchPollJobSchema } from "../domain/store-category-translation.js";
import { storeCategoryTranslationBatchPollService } from "../services/store-category-translation-batch-poll.service.js";

export async function handleStoreCategoryTranslationBatchPoll(input: unknown): Promise<void> {
  const job = StoreCategoryTranslationBatchPollJobSchema.parse(input);
  await storeCategoryTranslationBatchPollService.poll(job);
}
