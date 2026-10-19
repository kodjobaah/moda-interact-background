import { describe, expect, it } from "vitest";
import {
  MAX_MODERATION_EXCEPTION_LOG_CHARS, boundedModerationExceptionMessage,
  moderationExceptionLogFields, moderationFailureDiagnostic, moderationProviderFailure,
} from "../../../../src/services/conversation-moderation/moderation-failure-diagnostics.js";

const hostile = "postgres://user:secret@db.example.test/private?token=very-secret";

describe("ARCH-040 bounded moderation failure diagnostics", () => {
  it.each([
    [401, "provider_authentication_failed"],
    [403, "provider_permission_denied"],
    [404, "provider_endpoint_or_model_not_found"],
    [408, "provider_timeout"],
    [429, "provider_rate_limited"],
    [503, "provider_service_unavailable"],
    [400, "provider_request_rejected"],
  ] as const)("classifies HTTP %s without logging the provider error", (status, code) => {
    const wrapped = moderationProviderFailure(Object.assign(new Error(hostile), {
      status, body: hostile, headers: { Authorization: hostile },
    }));
    expect(moderationFailureDiagnostic(wrapped)).toEqual({
      stage: "provider_request", code, providerRequestAttempted: true, httpStatus: status,
    });
    expect(JSON.stringify(wrapped)).not.toContain(hostile);
    expect(wrapped.message).toBe("moderation_dependency_unavailable");
    expect(wrapped.cause).toBeUndefined();
    expect(moderationExceptionLogFields(wrapped, "test")).toEqual({ exceptionMessage: "[redacted-url]" });
    expect(moderationExceptionLogFields(wrapped, "production")).toEqual({});
  });

  it.each([
    ["ENOTFOUND", "provider_dns_unavailable"],
    ["EAI_AGAIN", "provider_dns_unavailable"],
    ["CERT_HAS_EXPIRED", "provider_tls_failure"],
    ["UND_ERR_CONNECT_TIMEOUT", "provider_timeout"],
    ["ECONNREFUSED", "provider_connection_failed"],
  ] as const)("classifies network cause %s safely", (networkCode, code) => {
    const raw = Object.assign(new Error(hostile), {
      name: "APIConnectionError", cause: Object.assign(new Error(hostile), { code: networkCode }),
    });
    const diagnosis = moderationFailureDiagnostic(raw);
    expect(diagnosis).toEqual({ stage: "provider_request", code, providerRequestAttempted: true });
    expect(JSON.stringify(diagnosis)).not.toContain(hostile);
  });

  it("does not copy unknown error type, status, code, cause or secret-bearing message", () => {
    const raw = Object.assign(new Error(hostile), {
      name: hostile, status: 799, code: hostile, cause: { message: hostile, code: hostile },
    });
    expect(moderationFailureDiagnostic(raw)).toEqual({
      stage: "provider_request", code: "provider_request_failed", providerRequestAttempted: true,
    });
    expect(JSON.stringify(moderationFailureDiagnostic(raw))).not.toContain(hostile);
  });

  it("retains diagnostic exception text, but scrubs secrets and caps it at 512 characters", () => {
    const upstream = new Error(
      `Rate limit exceeded for model omni-moderation-latest; Bearer SECRETSESSIONVALUE ` +
      `at postgres://admin:dbpassword@localhost/test?token=secret ` +
      `Authorization: privateToken\n${"x".repeat(3000)}`,
    );
    const preview = boundedModerationExceptionMessage(upstream);
    expect(preview?.startsWith("Rate limit exceeded for model omni-moderation-latest")).toBe(true);
    expect(preview?.length).toBe(MAX_MODERATION_EXCEPTION_LOG_CHARS);
    expect(preview?.endsWith("...")).toBe(true);
    expect(preview).not.toContain("SECRETSESSIONVALUE");
    expect(preview).not.toContain("dbpassword");
    expect(preview).not.toContain("privateToken");
    expect(preview).toContain("[redacted-url]");
    expect(preview).not.toContain("\n");
    expect(moderationExceptionLogFields(upstream, "development")).toEqual({ exceptionMessage: preview });
    expect(moderationExceptionLogFields(upstream, "production")).toEqual({});
  });

  it("does not serialize the captured original SDK message or its cause", () => {
    const original = Object.assign(new Error("Bad API key: very-secret-key"), { status: 401,
      cause: new Error("provider stack with credentials"), body: "customer message" });
    const wrapped = moderationProviderFailure(original);
    const log = moderationExceptionLogFields(wrapped, "test");
    expect(log.exceptionMessage).toMatch(/Bad API key:/);
    expect(log.exceptionMessage).not.toContain("very-secret-key");
    expect(JSON.stringify(wrapped)).not.toContain("very-secret-key");
    expect(JSON.stringify(wrapped)).not.toContain("customer message");
    expect(wrapped.cause).toBeUndefined();
    expect(moderationExceptionLogFields(wrapped, "production")).toEqual({});
  });

  it("distinguishes known local configuration and response failures", () => {
    expect(moderationFailureDiagnostic(new Error("moderation_configuration_unavailable")))
      .toEqual({ stage: "configuration", code: "credential_unavailable", providerRequestAttempted: false });
    expect(moderationFailureDiagnostic(new Error("moderation_response_invalid")))
      .toEqual({ stage: "provider_response", code: "provider_response_invalid", providerRequestAttempted: true });
  });
});
