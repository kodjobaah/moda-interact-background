import { describe, expect, it } from "vitest";

import {
  STORE_CATEGORY_TRANSLATION_SCHEMA_VERSION,
  StoreCategoryTranslationBatchPollJobSchema,
  StoreCategoryTranslationBatchSubmitJobSchema,
  createStoreCategoryTranslationBatchPollJobId,
  createStoreCategoryTranslationBatchSubmitJobId,
} from "../../../src/domain/store-category-translation.js";

describe("Store Category translation background jobs", () => {
  it("validates repository-local submit and poll contracts", () => {
    expect(StoreCategoryTranslationBatchSubmitJobSchema.parse({
      schemaVersion: STORE_CATEGORY_TRANSLATION_SCHEMA_VERSION,
      translationBatchId: "batch-1",
    })).toEqual({ schemaVersion: 1, translationBatchId: "batch-1" });

    expect(StoreCategoryTranslationBatchPollJobSchema.parse({
      schemaVersion: STORE_CATEGORY_TRANSLATION_SCHEMA_VERSION,
      translationBatchId: "batch-1",
      pollSequence: 2,
    })).toEqual({ schemaVersion: 1, translationBatchId: "batch-1", pollSequence: 2 });
  });

  it("uses deterministic queue job identifiers", () => {
    expect(createStoreCategoryTranslationBatchSubmitJobId("batch-1"))
      .toBe("store-category-translation-batch-submit-batch-1");
    expect(createStoreCategoryTranslationBatchPollJobId("batch-1", 3))
      .toBe("store-category-translation-batch-poll-batch-1-3");
  });
});
