import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}

describe("Merchant Pricing translation runtime wiring", () => {
  it("registers all three local job types on the existing merchant-communications worker", () => {
    const worker = source("src/workers/merchant-communications.worker.ts");
    expect(worker).toContain("MERCHANT_PRICING_TRANSLATION_JOB_NAMES");
    expect(worker).toContain("handleMerchantPricingTranslationBatchSubmit");
    expect(worker).toContain("handleMerchantPricingTranslationBatchPoll");
    expect(worker).toContain("handleMerchantPricingTranslationBatchResults");
    expect(worker).toContain("MERCHANT_COMMUNICATIONS_QUEUE_NAME");
  });

  it("adds Merchant Pricing reconciliation to the existing leased scheduler with failure isolation", () => {
    const entrypoint = source("src/entrypoints/merchant-communications.ts");
    expect(entrypoint).toContain('leaseName: "TRANSLATION_RECONCILIATION"');
    expect(entrypoint).toContain("Promise.allSettled");
    expect(entrypoint).toContain("merchantPricingTranslationReconciliationService.reconcile(snapshot)");
    expect(entrypoint).toContain(
      "merchantPricingTranslationPublicationService.reconcile(",
    );
    expect(entrypoint).not.toContain("MERCHANT_PRICING_TRANSLATION_RECONCILIATION");
  });

  it("keeps Merchant Pricing runtime state in billing and reuses generic provider helpers", () => {
    const reconciliation = source("src/services/merchant-pricing-translation-reconciliation.service.ts");
    const submit = source("src/services/merchant-pricing-translation-batch-submit.service.ts");
    const results = source("src/services/merchant-pricing-translation-batch-results.service.ts");
    const publication = source("src/services/merchant-pricing-translation-publication.service.ts");
    const publicationPersistence = source(
      "src/services/merchant-pricing-translation/publication-persistence.ts",
    );
    expect(reconciliation).toContain('"billing"."MerchantPricingTranslationRun"');
    expect(submit).toContain("submitTranslationProviderBatch");
    expect(results).toContain("applyTranslationProviderResults");
    expect(results).toContain("validateMerchantPricingTranslatedText");
    expect(publication).toContain('"billing"."MerchantPricingPlan"');
    expect(publication).toContain("READY_TO_APPLY");
    expect(publicationPersistence).toContain("TRANSLATION_FAILED");
    expect(publicationPersistence).toContain('"publicationStatus" = \'READY\'');
    expect(publication).toContain("@modainteract/moda-interact-shared/logging");
    expect(publication).not.toContain("console.");
    expect(publication).not.toContain("new Queue");
  });
});
