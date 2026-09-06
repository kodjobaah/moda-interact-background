import {
  TranslationBatchSubmitJobSchema,
} from "../domain/translation-batch.js";
import { translationBatchSubmitService } from "../services/translation-batch-submit.service.js";

export async function handleTranslationBatchSubmit(input: unknown): Promise<void> {
  const job = TranslationBatchSubmitJobSchema.parse(input);
  await translationBatchSubmitService.submit(job);
}