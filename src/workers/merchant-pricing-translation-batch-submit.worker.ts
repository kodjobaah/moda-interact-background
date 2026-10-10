import { MerchantPricingTranslationBatchSubmitJobSchema } from "../domain/merchant-pricing-translation.js";
import { merchantPricingTranslationBatchSubmitService } from "../services/merchant-pricing-translation-batch-submit.service.js";

export async function handleMerchantPricingTranslationBatchSubmit(input: unknown): Promise<void> {
  const job = MerchantPricingTranslationBatchSubmitJobSchema.parse(input);
  await merchantPricingTranslationBatchSubmitService.submit(job);
}
