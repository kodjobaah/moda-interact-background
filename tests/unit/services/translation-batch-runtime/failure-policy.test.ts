import { describe, expect, it } from "vitest";

import {
  classifyTranslationSubmissionFailure,
  isTranslationProviderFailureRetryable,
  translationSubmissionFailureCode,
} from "../../../../src/services/translation-batch-runtime/failure-policy.js";

describe("translation batch failure policy", () => {
  it("prefers explicit submission classifications and otherwise uses the fallback", () => {
    expect(classifyTranslationSubmissionFailure(
      { classification: "DEFINITE_TERMINAL_NOT_CREATED" },
      "AMBIGUOUS_CREATE",
    )).toBe("DEFINITE_TERMINAL_NOT_CREATED");
    expect(classifyTranslationSubmissionFailure(
      { submissionClassification: "DEFINITE_RETRYABLE_NOT_CREATED" },
      "AMBIGUOUS_CREATE",
    )).toBe("DEFINITE_RETRYABLE_NOT_CREATED");
    expect(classifyTranslationSubmissionFailure(
      new Error("provider failure"),
      "AMBIGUOUS_CREATE",
    )).toBe("AMBIGUOUS_CREATE");
  });

  it("uses the bounded Error.name as the provider submission failure code", () => {
    const named = new Error("failed");
    named.name = "ProviderFailure";
    expect(translationSubmissionFailureCode(named)).toBe("ProviderFailure");

    const longNamed = new Error("failed");
    longNamed.name = "x".repeat(121);
    expect(translationSubmissionFailureCode(longNamed)).toBe("x".repeat(120));

    expect(translationSubmissionFailureCode("failed")).toBe("provider-submission-failed");
  });

  it("classifies HTTP and semantic provider failures consistently", () => {
    expect(isTranslationProviderFailureRetryable(null)).toBe(true);
    expect(isTranslationProviderFailureRetryable("http-429")).toBe(true);
    expect(isTranslationProviderFailureRetryable("HTTP_500")).toBe(true);
    expect(isTranslationProviderFailureRetryable("rate_limit")).toBe(true);

    for (const status of [400, 401, 403, 404, 422]) {
      expect(isTranslationProviderFailureRetryable(`http-${status}`)).toBe(false);
    }
    for (const code of [
      "auth_failed",
      "permission_denied",
      "invalid_request",
      "malformed-provider-output",
      "unsupported_language",
      "content_policy",
      "bad_request",
    ]) {
      expect(isTranslationProviderFailureRetryable(code)).toBe(false);
    }
  });
});
