import { describe, expect, it } from "vitest";
import { assertExactTranslationBatchResultMembership } from "../../../../src/services/translation-batch-runtime/result-membership.js";
import { translationItemRetryDisposition } from "../../../../src/services/translation-batch-runtime/item-retry.js";

const messages = {
  countMismatch: "RESULT_COUNT_MISMATCH",
  unknownProviderCustomId: () => "UNKNOWN_RESULT",
  duplicateProviderCustomId: "DUPLICATE_RESULT",
};

describe("ARCH-031 reusable result membership and retry semantics", () => {
  it("rejects missing, extra, unknown and duplicate results", () => {
    const expected = ["item-a", "item-b"];
    const members = (ids: string[]) => ids.map((providerCustomId) => ({ providerCustomId }));
    expect(() => assertExactTranslationBatchResultMembership(expected, members(["item-a"]), messages)).toThrow("RESULT_COUNT_MISMATCH");
    expect(() => assertExactTranslationBatchResultMembership(expected, members(["item-a", "item-b", "item-c"]), messages)).toThrow("RESULT_COUNT_MISMATCH");
    expect(() => assertExactTranslationBatchResultMembership(expected, members(["item-a", "item-x"]), messages)).toThrow("UNKNOWN_RESULT");
    expect(() => assertExactTranslationBatchResultMembership(expected, members(["item-a", "item-a"]), messages)).toThrow("DUPLICATE_RESULT");
    expect(() => assertExactTranslationBatchResultMembership(expected, members(["item-b", "item-a"]), messages)).not.toThrow();
  });
  it("bounds item retry and treats invalid provider output as terminal", () => {
    expect(translationItemRetryDisposition({ failureCode: "http-503", retryCount: 0, maxAutoRetries: 1, retryDelaySeconds: 30, nowMs: 0 }))
      .toEqual({ shouldRetry: true, status: "PENDING", retryIncrement: 1, nextAttemptAt: new Date(30000) });
    expect(translationItemRetryDisposition({ failureCode: "PROTECTED_TOKEN_MISMATCH", retryCount: 0, maxAutoRetries: 0, retryDelaySeconds: 30, nowMs: 0 }).status)
      .toBe("FAILED");
  });
});
