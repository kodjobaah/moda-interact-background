import {
  backgroundRuntimeConfigService,
  type BackgroundRuntimeConfigSnapshot,
} from "../runtime/background-runtime-config.js";

export type TranslationRuntimeConfigReader = {
  current(): BackgroundRuntimeConfigSnapshot;
};

const testDefaults = {
  translationReconciliationIntervalSeconds: 300,
  translationReconciliationPageSize: 100,
  translationClaimTimeoutSeconds: 900,
  translationBatchMaxRequests: 100,
  translationSubmitRetrySeconds: 300,
  translationSubmitMaxAttempts: 3,
  translationInitialPollSeconds: 300,
  translationPollIntervalSeconds: 300,
  translationResultRetrySeconds: 300,
  translationMaxAutoRetries: 3,
};

export function currentTranslationRuntimeConfig(
  reader: TranslationRuntimeConfigReader = backgroundRuntimeConfigService,
): BackgroundRuntimeConfigSnapshot {
  try {
    return reader.current();
  } catch (error) {
    if (error instanceof Error && error.message === "Background runtime configuration has not started.") {
      return testDefaults as BackgroundRuntimeConfigSnapshot;
    }
    throw error;
  }
}