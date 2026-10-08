import type { NormalizedProviderStatus } from "../../providers/translation.provider.js";

export type TranslationBatchCorrelationRoute = "completed" | "poll";

export function routeTranslationBatchCorrelation(
  status: NormalizedProviderStatus,
): TranslationBatchCorrelationRoute {
  return status === "completed" ? "completed" : "poll";
}
