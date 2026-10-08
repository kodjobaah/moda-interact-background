export type TranslationSubmitFailureClassification =
  | "DEFINITE_RETRYABLE_NOT_CREATED"
  | "DEFINITE_TERMINAL_NOT_CREATED"
  | "AMBIGUOUS_CREATE";

type SubmissionFailureLike = {
  classification?: TranslationSubmitFailureClassification;
  submissionClassification?: TranslationSubmitFailureClassification;
};

export function classifyTranslationSubmissionFailure(
  error: unknown,
  fallback: TranslationSubmitFailureClassification,
): TranslationSubmitFailureClassification {
  if (error && typeof error === "object") {
    const candidate = error as SubmissionFailureLike;
    if (candidate.classification) return candidate.classification;
    if (candidate.submissionClassification) return candidate.submissionClassification;
  }
  return fallback;
}

export function translationSubmissionFailureCode(error: unknown): string {
  if (error instanceof Error) return error.name.slice(0, 120);
  return "provider-submission-failed";
}

export function isTranslationProviderFailureRetryable(
  failureCode: string | null,
): boolean {
  if (!failureCode) return true;
  const normalized = failureCode.toLowerCase();
  const httpStatus = normalized.match(/\bhttp[-_: ]?(\d{3})\b/)?.[1];
  if (httpStatus) {
    const status = Number(httpStatus);
    return status === 429 || status >= 500;
  }
  return !/(auth|permission|invalid|malformed|unsupported|content_policy|bad_request)/.test(
    normalized,
  );
}
