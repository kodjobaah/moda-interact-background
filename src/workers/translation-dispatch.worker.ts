import {
  MERCHANT_COMMUNICATIONS_QUEUE_NAME,
  TranslationDispatchJobSchema,
} from "../domain/translation-batch.js";
import { translationBatchAssemblyService } from "../services/translation-batch-assembly.service.js";

export const merchantCommunicationsQueueName =
  MERCHANT_COMMUNICATIONS_QUEUE_NAME;

export async function handleTranslationDispatch(input: unknown): Promise<void> {
  const dispatch = TranslationDispatchJobSchema.parse(input);
  await translationBatchAssemblyService.assembleFromDispatch(dispatch);
}
