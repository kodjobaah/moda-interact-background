/**
 * Bounded moderation diagnostics. An SDK exception-message preview is kept
 * separately from the serialisable error and logged only in test/development.
 * Truncation alone does not protect secrets, so known secret shapes are scrubbed.
 * Never log error objects, stacks, causes, provider bodies or moderation input.
 */
export type ModerationFailureStage = "configuration" | "provider_request" | "provider_response";
export type ModerationFailureCode =
  | "credential_unavailable"
  | "configured_model_mismatch"
  | "configured_endpoint_invalid"
  | "provider_client_initialization_failed"
  | "provider_timeout"
  | "provider_dns_unavailable"
  | "provider_tls_failure"
  | "provider_connection_failed"
  | "provider_authentication_failed"
  | "provider_permission_denied"
  | "provider_rate_limited"
  | "provider_endpoint_or_model_not_found"
  | "provider_request_rejected"
  | "provider_service_unavailable"
  | "provider_http_failure"
  | "provider_request_failed"
  | "provider_result_missing"
  | "provider_model_mismatch"
  | "provider_response_invalid";

export type ModerationFailureDiagnostic = Readonly<{
  stage: ModerationFailureStage;
  code: ModerationFailureCode;
  providerRequestAttempted: boolean;
  httpStatus?: number;
}>;

export const MAX_MODERATION_EXCEPTION_LOG_CHARS = 512;
const MAX_EXCEPTION_SOURCE_CHARS = 4096;
// Non-enumerable storage prevents ordinary error serialization from leaking SDK
// messages. The preview itself is capped and scrubbed before retention.
const exceptionPreviews = new WeakMap<Error, string>();

function safeMessageField(error: unknown): string | undefined {
  const value = field(error, "message");
  return typeof value === "string" && value.length ? value : undefined;
}

/** A short excerpt of the actual exception message, with secret-like data removed. */
export function boundedModerationExceptionMessage(error: unknown): string | undefined {
  const raw = safeMessageField(error);
  if (!raw) return undefined;
  // Only scan a bounded prefix of untrusted provider text.
  const redacted = raw.slice(0, MAX_EXCEPTION_SOURCE_CHARS)
    .replace(/\b(?:postgres(?:ql)?|https?|redis(?:s)?|amqps?|mysql):\/\/[^\s"'<>]+/giu, "[redacted-url]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/giu, "$1 [redacted]")
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{6,}|ghp_[A-Za-z0-9_]{6,}|xox[baprs]-[^\s"']{6,})/giu, "[redacted-credential]")
    .replace(/\b((?:api[\s_-]?key|access[_-]?token|password|secret|authorization|client[_-]?secret|token)\s*[:=]\s*)\S+/giu, "$1[redacted]");
  const message = Array.from(redacted, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("").trim();
  if (!message) return undefined;
  return message.length > MAX_MODERATION_EXCEPTION_LOG_CHARS
    ? `${message.slice(0, MAX_MODERATION_EXCEPTION_LOG_CHARS - 3)}...`
    : message;
}

/** Original SDK message preview, if one was captured before wrapping. */
export function moderationExceptionMessage(error: unknown): string | undefined {
  if (error instanceof ModerationDependencyFailure) {
    return exceptionPreviews.get(error) ?? boundedModerationExceptionMessage(error);
  }
  return boundedModerationExceptionMessage(error);
}

/** Diagnostic-only message field: never expose provider text in production logs. */
export function moderationExceptionLogFields(error: unknown, environment: string): { exceptionMessage?: string } {
  if (environment !== "test" && environment !== "development") return {};
  const preview = moderationExceptionMessage(error);
  return preview ? { exceptionMessage: preview } : {};
}

/** No error cause or source message is attached as a serialisable property. */
export class ModerationDependencyFailure extends Error {
  constructor(
    message: "moderation_configuration_unavailable" | "moderation_configuration_invalid" |
      "moderation_configuration_mismatch" | "moderation_response_invalid" |
      "moderation_dependency_unavailable",
    public readonly diagnostic: ModerationFailureDiagnostic,
    upstreamError?: unknown,
  ) {
    super(message);
    this.name = "ModerationDependencyFailure";
    const preview = boundedModerationExceptionMessage(upstreamError);
    if (preview) exceptionPreviews.set(this, preview);
  }
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try { return (value as Record<string, unknown>)[key]; }
  catch { return undefined; }
}

function httpStatus(error: unknown): number | undefined {
  const value = field(error, "status");
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599
    ? value : undefined;
}

function codeForHttp(status: number): ModerationFailureCode {
  if (status === 401) return "provider_authentication_failed";
  if (status === 403) return "provider_permission_denied";
  if (status === 404) return "provider_endpoint_or_model_not_found";
  if (status === 408 || status === 504) return "provider_timeout";
  if (status === 429) return "provider_rate_limited";
  if (status >= 500) return "provider_service_unavailable";
  if (status === 400 || status === 422) return "provider_request_rejected";
  return "provider_http_failure";
}

function codeForNetwork(error: unknown): ModerationFailureCode | null {
  // The OpenAI SDK may wrap network errors under a cause. Only exact known
  // transport codes are recognised; arbitrary cause/code strings never log.
  for (const item of [error, field(error, "cause"), field(field(error, "cause"), "cause")]) {
    switch (field(item, "code")) {
      case "ENOTFOUND":
      case "EAI_AGAIN": return "provider_dns_unavailable";
      case "CERT_HAS_EXPIRED":
      case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
      case "SELF_SIGNED_CERT_IN_CHAIN":
      case "DEPTH_ZERO_SELF_SIGNED_CERT": return "provider_tls_failure";
      case "ETIMEDOUT":
      case "UND_ERR_CONNECT_TIMEOUT": return "provider_timeout";
      case "ECONNREFUSED":
      case "ECONNRESET":
      case "EHOSTUNREACH":
      case "ENETUNREACH": return "provider_connection_failed";
    }
  }
  if (field(error, "name") === "APIConnectionTimeoutError" ||
      field(error, "name") === "TimeoutError" || field(error, "name") === "AbortError") {
    return "provider_timeout";
  }
  if (field(error, "name") === "APIConnectionError") return "provider_connection_failed";
  return null;
}

/** Classifies an SDK rejection without retaining any untrusted error data. */
export function moderationProviderFailure(error: unknown): ModerationDependencyFailure {
  const status = httpStatus(error);
  const code = status === undefined
    ? codeForNetwork(error) ?? "provider_request_failed"
    : codeForHttp(status);
  return new ModerationDependencyFailure("moderation_dependency_unavailable", {
    stage: "provider_request", code, providerRequestAttempted: true,
    ...(status === undefined ? {} : { httpStatus: status }),
  }, error);
}

/** Also works with an injected moderation client that throws an ordinary Error. */
export function moderationFailureDiagnostic(error: unknown): ModerationFailureDiagnostic {
  if (error instanceof ModerationDependencyFailure) return error.diagnostic;
  const message = error instanceof Error ? error.message : null;
  if (message === "moderation_configuration_unavailable") {
    return { stage: "configuration", code: "credential_unavailable", providerRequestAttempted: false };
  }
  if (message === "moderation_configuration_invalid") {
    return { stage: "configuration", code: "configured_endpoint_invalid", providerRequestAttempted: false };
  }
  if (message === "moderation_configuration_mismatch") {
    return { stage: "configuration", code: "configured_model_mismatch", providerRequestAttempted: false };
  }
  if (message === "moderation_response_invalid") {
    return { stage: "provider_response", code: "provider_response_invalid", providerRequestAttempted: true };
  }
  return moderationProviderFailure(error).diagnostic;
}
