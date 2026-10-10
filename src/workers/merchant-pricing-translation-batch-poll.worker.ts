import { MerchantPricingTranslationBatchPollJobSchema } from "../domain/merchant-pricing-translation.js";
import { merchantPricingTranslationBatchPollService } from "../services/merchant-pricing-translation-batch-poll.service.js";

export async function handleMerchantPricingTranslationBatchPoll(input: unknown): Promise<void> {
  const job = MerchantPricingTranslationBatchPollJobSchema.parse(input);
  await merchantPricingTranslationBatchPollService.poll(job);
}
