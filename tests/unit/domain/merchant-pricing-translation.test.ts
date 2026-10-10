import { describe, expect, it } from "vitest";

import {
  MERCHANT_PRICING_TRANSLATION_JOB_NAMES,
  MerchantPricingTranslationBatchPollJobSchema,
  MerchantPricingTranslationBatchResultsJobSchema,
  MerchantPricingTranslationBatchSubmitJobSchema,
  createMerchantPricingTranslationBatchPollJobId,
  createMerchantPricingTranslationBatchResultsJobId,
  createMerchantPricingTranslationBatchSubmitJobId,
} from "../../../src/domain/merchant-pricing-translation.js";

describe("Merchant Pricing translation job contracts", () => {
  it("uses strict v1 schemas with deterministic job ids", () => {
    expect(MerchantPricingTranslationBatchSubmitJobSchema.parse({
      schemaVersion: 1,
      translationBatchId: "batch-1",
    })).toEqual({ schemaVersion: 1, translationBatchId: "batch-1" });
    expect(MerchantPricingTranslationBatchPollJobSchema.parse({
      schemaVersion: 1,
      translationBatchId: "batch-1",
      pollSequence: 2,
    })).toEqual({ schemaVersion: 1, translationBatchId: "batch-1", pollSequence: 2 });
    expect(MerchantPricingTranslationBatchResultsJobSchema.safeParse({
      schemaVersion: 1,
      translationBatchId: "batch-1",
      unexpected: true,
    }).success).toBe(false);

    expect(createMerchantPricingTranslationBatchSubmitJobId("batch-1")).toBe(
      "merchant-pricing-translation-batch-submit-batch-1",
    );
    expect(createMerchantPricingTranslationBatchPollJobId("batch-1", 2)).toBe(
      "merchant-pricing-translation-batch-poll-batch-1-2",
    );
    expect(createMerchantPricingTranslationBatchResultsJobId("batch-1")).toBe(
      "merchant-pricing-translation-batch-results-batch-1",
    );
    expect(Object.values(MERCHANT_PRICING_TRANSLATION_JOB_NAMES)).toHaveLength(3);
  });
});
