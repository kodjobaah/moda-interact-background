import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const files = [
  "src/commerce/translation-provider-credential.ts",
  "src/domain/store-category-translation.ts",
  "src/services/store-category-translation-batch-submit.service.ts",
  "src/services/store-category-translation-batch-poll.service.ts",
  "src/services/store-category-translation-batch-results.service.ts",
  "src/services/store-category-translation-reconciliation.service.ts",
  "src/workers/store-category-translation-batch-submit.worker.ts",
  "src/workers/store-category-translation-batch-poll.worker.ts",
  "src/workers/store-category-translation-batch-results.worker.ts",
];

const sources = files.map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]);
const combined = sources.map(([, source]) => source).join("\n");

const required = [
  '"commerce"."CommerceStoreCategoryTranslationRun"',
  '"commerce"."CommerceStoreCategoryTranslationItem"',
  '"commerce"."CommerceStoreCategoryTranslationBatch"',
  '"commerce"."CommerceStoreCategoryTranslationBatchItem"',
  "STORE_CATEGORY_TRANSLATION_JOB_NAMES",
  "createCommerceTranslationProviderCredentialAad",
];
for (const token of required) {
  if (!combined.includes(token)) throw new Error(`ARCH-029 B01 missing required runtime token: ${token}`);
}

const forbidden = [
  '"support"."MerchantMessageTranslation"',
  '"support"."MerchantTranslationBatch"',
  '"support"."MerchantTranslationBatchItem"',
  '"commerce"."CommercePromptTemplateCategoryTranslation"',
  '"commerce"."CommerceStoreCategoryTaxonomyMappingTranslation"',
];
for (const token of forbidden) {
  if (combined.includes(token)) throw new Error(`ARCH-029 B01 crossed a persistence boundary: ${token}`);
}

const worker = fs.readFileSync(path.join(root, "src/workers/merchant-communications.worker.ts"), "utf8");
for (const name of ["BATCH_SUBMIT", "BATCH_POLL", "BATCH_RESULTS"]) {
  if (!worker.includes(`STORE_CATEGORY_TRANSLATION_JOB_NAMES.${name}`)) {
    throw new Error(`merchant-communications worker is missing Store Category ${name}`);
  }
}

const entrypoint = fs.readFileSync(path.join(root, "src/entrypoints/merchant-communications.ts"), "utf8");
if (!entrypoint.includes("storeCategoryTranslationReconciliationService.reconcile(snapshot)")) {
  throw new Error("Store Category translation reconciliation is not attached to the existing scheduler");
}

const provider = fs.readFileSync(path.join(root, "src/providers/translation.provider.ts"), "utf8");
if (!provider.includes("options.apiKey?.trim()")) {
  throw new Error("translation provider does not accept a database-backed API key");
}
if (!provider.includes("request.direction !== undefined")) {
  throw new Error("translation provider has not been generalized beyond support-message direction");
}

console.log("ARCH-029 Store Category translation runtime validation passed");
