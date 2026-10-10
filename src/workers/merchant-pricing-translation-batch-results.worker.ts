import { MerchantPricingTranslationBatchResultsJobSchema } from "../domain/merchant-pricing-translation.js";
import { merchantPricingTranslationBatchResultsService } from "../services/merchant-pricing-translation-batch-results.service.js";

export async function handleMerchantPricingTranslationBatchResults(input: unknown): Promise<void> {
  const job = MerchantPricingTranslationBatchResultsJobSchema.parse(input);
  await merchantPricingTranslationBatchResultsService.apply(job);
}
