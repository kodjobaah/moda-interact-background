import { isTranslationProviderFailureRetryable } from "./failure-policy.js";

export type TranslationItemRetryDisposition = {
  shouldRetry: boolean;
  status: "PENDING" | "FAILED";
  retryIncrement: 0 | 1;
  nextAttemptAt: Date | null;
};

export function translationItemRetryDisposition(input: {
  failureCode: string | null;
  retryCount: number;
  maxAutoRetries: number;
  retryDelaySeconds: number;
  nowMs?: number;
}): TranslationItemRetryDisposition {
  const shouldRetry =
    isTranslationProviderFailureRetryable(input.failureCode)
    && input.retryCount < input.maxAutoRetries;
  return {
    shouldRetry,
    status: shouldRetry ? "PENDING" : "FAILED",
    retryIncrement: shouldRetry ? 1 : 0,
    nextAttemptAt: shouldRetry
      ? new Date((input.nowMs ?? Date.now()) + input.retryDelaySeconds * 1000)
      : null,
  };
}
