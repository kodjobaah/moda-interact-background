import { describe, expect, it } from "vitest";

import { assertExactTranslationBatchResultMembership } from "../../../../src/services/translation-batch-runtime/result-membership.js";

const messages = {
  countMismatch: "count mismatch",
  unknownProviderCustomId: (providerCustomId: string) => `unknown:${providerCustomId}`,
  duplicateProviderCustomId: "duplicate",
};

describe("translation batch result membership", () => {
  it("accepts exactly one result for every expected provider custom ID", () => {
    expect(() => assertExactTranslationBatchResultMembership(
      ["item-1", "item-2"],
      [{ providerCustomId: "item-2" }, { providerCustomId: "item-1" }],
      messages,
    )).not.toThrow();
  });

  it("rejects a result-count mismatch", () => {
    expect(() => assertExactTranslationBatchResultMembership(
      ["item-1", "item-2"],
      [{ providerCustomId: "item-1" }],
      messages,
    )).toThrow("count mismatch");
  });

  it("rejects an unknown provider custom ID", () => {
    expect(() => assertExactTranslationBatchResultMembership(
      ["item-1"],
      [{ providerCustomId: "unexpected" }],
      messages,
    )).toThrow("unknown:unexpected");
  });

  it("rejects duplicate provider custom IDs", () => {
    expect(() => assertExactTranslationBatchResultMembership(
      ["item-1", "item-2"],
      [{ providerCustomId: "item-1" }, { providerCustomId: "item-1" }],
      messages,
    )).toThrow("duplicate");
  });
});
