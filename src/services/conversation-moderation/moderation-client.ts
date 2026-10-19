import OpenAI from "openai";
import type { ModerationResponse } from "./moderation-policy.js";
import type { ModerationOperation } from "./moderation-operation.js";
import { ModerationDependencyFailure, moderationProviderFailure } from "./moderation-failure-diagnostics.js";

export type ModerateText = (input: {
  text: string; model: string; timeoutMs: number; operation: ModerationOperation;
}) => Promise<ModerationResponse>;

/** ARCH-043 stores the full moderation endpoint; the OpenAI SDK wants its parent base URL.
 * Passing baseURL explicitly also prevents OPENAI_BASE_URL from overriding database policy.
 */
export function moderationSdkBaseUrl(endpoint: string | null): string {
  const url = new URL(endpoint ?? "https://api.openai.com/v1/moderations");
  if (url.username || url.password || url.search || url.hash ||
      !url.pathname.endsWith("/moderations")) {
    throw new Error("moderation_configuration_invalid");
  }
  url.pathname = url.pathname.slice(0, -"/moderations".length);
  return url.href.replace(/\/$/, "");
}

/** No vendor call at webhook ingress. Credential/policy come from the same fresh
 * sealed ARCH-043 snapshot that selected this assessment's requestedModel.
 */
export const openAiModerateText: ModerateText = async ({ text, model, timeoutMs, operation }) => {
  const key = operation.openAiApiKey;
  if (!key || !key.trim()) {
    throw new ModerationDependencyFailure("moderation_configuration_unavailable", {
      stage: "configuration", code: "credential_unavailable", providerRequestAttempted: false,
    });
  }
  if (model !== operation.moderation.value.modelId) {
    throw new ModerationDependencyFailure("moderation_configuration_mismatch", {
      stage: "configuration", code: "configured_model_mismatch", providerRequestAttempted: false,
    });
  }
  let baseURL: string;
  try { baseURL = moderationSdkBaseUrl(operation.moderation.value.baseUrl); }
  catch (error) {
    throw new ModerationDependencyFailure("moderation_configuration_invalid", {
      stage: "configuration", code: "configured_endpoint_invalid", providerRequestAttempted: false,
    }, error);
  }
  let client: OpenAI;
  try { client = new OpenAI({ apiKey: key, baseURL, maxRetries: 0, timeout: timeoutMs }); }
  catch (error) {
    throw new ModerationDependencyFailure("moderation_configuration_invalid", {
      stage: "configuration", code: "provider_client_initialization_failed", providerRequestAttempted: false,
    }, error);
  }
  let response: Awaited<ReturnType<typeof client.moderations.create>>;
  try {
    response = await client.moderations.create(
      { model, input: text }, { maxRetries: 0, timeout: timeoutMs },
    );
  } catch (error) { throw moderationProviderFailure(error); }
  const result = response.results?.[0];
  if (!result) {
    throw new ModerationDependencyFailure("moderation_response_invalid", {
      stage: "provider_response", code: "provider_result_missing", providerRequestAttempted: true,
    });
  }
  if (response.model !== model) {
    throw new ModerationDependencyFailure("moderation_response_invalid", {
      stage: "provider_response", code: "provider_model_mismatch", providerRequestAttempted: true,
    });
  }
  return {
    flagged: result.flagged,
    categories: result.categories as unknown as Record<string, boolean>,
    categoryScores: result.category_scores as unknown as Record<string, number>,
    ...(result.category_applied_input_types
      ? { appliedInputTypes: result.category_applied_input_types as unknown as Record<string, string[]> } : {}),
    returnedModel: response.model,
    ...((response as { _request_id?: string })._request_id
      ? { requestId: (response as { _request_id?: string })._request_id! } : {}),
  };
};
