import { describe, it, expect } from "vitest";
import { translationProviderTestInternals } from "../../../../src/providers/translation.provider.js";

describe("shared Batch provider keyed-segment request adapter", () => {
  it("constrains the actual keyed Batch JSONL body to the strict result shape and bounds", () => {
    const line = JSON.parse(translationProviderTestInternals.buildBatchRequestLine({
      translationId: "keyed-result", providerCustomId: "exact-custom-id", sourceLanguageTag: "en", targetLanguageTag: "tr",
      sourceText: JSON.stringify({ schemaVersion: 1, segments: [{ key: "body", text: "Synthetic" }] }),
      translationFormat: "keyed-segments-v1",
    }, "configured-model"));
    expect(line).toMatchObject({ custom_id: "exact-custom-id", method: "POST", url: "/v1/responses",
      body: { model: "configured-model", tools: [], max_output_tokens: 8192,
        text: { format: { type: "json_schema", name: "keyed_translation_segments_v1", strict: true } } } });
    const schema = line.body.text.format.schema;
    expect(schema).toMatchObject({ type: "object", additionalProperties: false, required: ["schemaVersion", "segments"] });
    expect(Object.keys(schema.properties)).toEqual(["schemaVersion", "segments"]);
    expect(schema.properties.schemaVersion.const ?? schema.properties.schemaVersion.enum?.[0]).toBe(1);
    expect(schema.properties.segments).toMatchObject({ type: "array", minItems: 1, maxItems: 64,
      items: { type: "object", additionalProperties: false, required: ["key", "text"],
        properties: { key: { type: "string", minLength: 1, maxLength: 256 },
          text: { type: "string", minLength: 1, maxLength: 8192 } } } });
    expect(Object.keys(schema.properties.segments.items.properties)).toEqual(["key", "text"]);
  });
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
    expect(ordinary.body).not.toHaveProperty("text");
  });
});
