import { TranslationBatchPollJobSchema } from "../domain/translation-batch.js";
import { translationBatchPollService } from "../services/translation-batch-poll.service.js";

export async function handleTranslationBatchPoll(input: unknown): Promise<void> {
  const job = TranslationBatchPollJobSchema.parse(input);
  await translationBatchPollService.poll(job);
}
