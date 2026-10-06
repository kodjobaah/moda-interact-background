import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const servicePath = "src/services/store-category-translation-publication.service.ts";
const service = fs.readFileSync(path.join(root, servicePath), "utf8");
const entrypoint = fs.readFileSync(
  path.join(root, "src/entrypoints/merchant-communications.ts"),
  "utf8",
);

const required = [
  "commercePromptTemplateCategoryTranslation",
  "commerceStoreCategoryTaxonomyMappingTranslation",
  "SOURCE_CONFIGURATION_CHANGED",
  "TRANSLATION_SET_INVALID",
  "READY_TO_PUBLISH",
  "SUCCEEDED",
  "ENABLE_PROMPT_TEMPLATE_CATEGORY",
  "TransactionIsolationLevel.Serializable",
  "background.store_category_translation.run_published",
  "background.store_category_translation.run_stale",
];
for (const token of required) {
  if (!service.includes(token)) {
    throw new Error(`ARCH-029 B02 missing required publication token: ${token}`);
  }
}

const forbidden = [
  "createOpenAITranslationProvider",
  "OPENAI_API_KEY",
  "connectionRedis",
  "new Queue(",
  '"support"."MerchantMessageTranslation"',
  '"support"."MerchantTranslationBatch"',
  '"support"."MerchantTranslationBatchItem"',
];
for (const token of forbidden) {
  if (service.includes(token)) {
    throw new Error(`ARCH-029 B02 crossed a publication boundary: ${token}`);
  }
}

if (!entrypoint.includes("storeCategoryTranslationPublicationService.reconcile")) {
  throw new Error("Store Category translation publication is not attached to translation reconciliation");
}

console.log("ARCH-029 Store Category translation publication validation passed");
