import { describe, it, expect } from "vitest";
import { translationProviderTestInternals } from "../../../../src/providers/translation.provider.js";

describe("shared Batch provider keyed-segment request adapter", () => {
  it("uses protected-keyed JSON output instructions only for WhatsApp template jobs", () => {
    const keyed = JSON.parse(translationProviderTestInternals.buildBatchRequestLine({
      translationId: "translation-1", sourceLanguageTag: "en-GB", targetLanguageTag: "fr-FR",
      sourceText: JSON.stringify({ schemaVersion: 1, segments: [{ key: "body.text", text: "Hello __MODA_PROTECTED_0_0__" }] }),
      translationFormat: "keyed-segments-v1",
    }, "test-model"));
    expect(keyed.body.input[0].content).toContain("__MODA_PROTECTED_N_N__");
    expect(keyed.body.max_output_tokens).toBe(8192);
    const ordinary = JSON.parse(translationProviderTestInternals.buildBatchRequestLine({
      translationId: "translation-2", sourceLanguageTag: "en-GB", targetLanguageTag: "fr-FR",
      sourceText: "Hello world",
    }, "test-model"));
    expect(ordinary.body.input[0].content).not.toContain("__MODA_PROTECTED_N_N__");
    expect(ordinary.body.max_output_tokens).toBe(2000);
  });
});
