import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModerationOperation } from "../../../../src/services/conversation-moderation/moderation-operation.js";

const mocks = vi.hoisted(() => ({ create: vi.fn(), constructorOptions: vi.fn() }));
vi.mock("openai", () => ({
  default: class FakeOpenAI {
    constructor(options: unknown) { mocks.constructorOptions(options); }
    moderations = { create: mocks.create };
  },
}));
import { moderationSdkBaseUrl, openAiModerateText } from
  "../../../../src/services/conversation-moderation/moderation-client.js";
import { ModerationDependencyFailure, moderationExceptionLogFields } from
  "../../../../src/services/conversation-moderation/moderation-failure-diagnostics.js";

const operation = (options: { key?: string; modelId?: string; baseUrl?: string | null } = {}): ModerationOperation => ({
  moderation: { key: "omini.moderation", version: 7,
    value: { baseUrl: options.baseUrl === undefined ? "https://api.openai.com/v1/moderations" : options.baseUrl,
      modelId: options.modelId ?? "omni-moderation-latest" } },
  providerVersion: 4, openAiApiKey: options.key ?? "arch040-test-only-key",
});
const request = (config = operation()) => ({ text: "fixture", model: "omni-moderation-latest", timeoutMs: 8000, operation: config });

afterEach(() => { mocks.create.mockReset(); mocks.constructorOptions.mockReset(); });

describe("ARCH-040 moderation client uses ARCH-043 operation snapshot", () => {
  it("fails closed when the sealed OpenAI credential is absent, even with a legacy env key", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "must-not-use-legacy-env";
    try {
      await expect(openAiModerateText(request(operation({ key: "" }))))
        .rejects.toThrow("moderation_configuration_unavailable");
      expect(mocks.create).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });
  it("uses the model, decrypted key and /v1 base from the same operation", async () => {
    const config = operation();
    mocks.create.mockResolvedValue({ model: "omni-moderation-latest", results: [{
      flagged: true, categories: { harassment: true }, category_scores: { harassment: 0.92 },
      category_applied_input_types: { harassment: ["text"] },
    }], _request_id: "req-test" });
    await expect(openAiModerateText(request(config)))
      .resolves.toEqual(expect.objectContaining({ flagged: true, requestId: "req-test",
        categoryScores: { harassment: 0.92 } }));
    expect(mocks.constructorOptions).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "arch040-test-only-key", baseURL: "https://api.openai.com/v1",
      maxRetries: 0, timeout: 8000,
    }));
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      model: "omni-moderation-latest", input: "fixture",
    }), { maxRetries: 0, timeout: 8000 });
  });
  it("supports a null endpoint with explicit official SDK base and converts custom endpoint paths", () => {
    expect(moderationSdkBaseUrl(null)).toBe("https://api.openai.com/v1");
    expect(moderationSdkBaseUrl("https://moderation.example.org/custom/v1/moderations"))
      .toBe("https://moderation.example.org/custom/v1");
    expect(() => moderationSdkBaseUrl("https://moderation.example.org/custom/v1"))
      .toThrow("moderation_configuration_invalid");
  });
  it("rejects conflicting model or malformed vendor result, never ALLOW", async () => {
    await expect(openAiModerateText(request(operation({ modelId: "some-other-model" }))))
      .rejects.toThrow("moderation_configuration_mismatch");
    expect(mocks.constructorOptions).not.toHaveBeenCalled();
    mocks.create.mockResolvedValue({ model: "omni-moderation-latest", results: [] });
    await expect(openAiModerateText(request())).rejects.toThrow("moderation_response_invalid");
    mocks.create.mockResolvedValue({ model: "wrong-model", results: [{
      flagged: false, categories: {}, category_scores: {},
    }] });
    await expect(openAiModerateText(request())).rejects.toThrow("moderation_response_invalid");
    mocks.create.mockRejectedValue(Object.assign(new Error("Bearer very-secret postgres://user:password@host/db"), { status: 429 }));
    await expect(openAiModerateText(request())).rejects.toMatchObject({
      message: "moderation_dependency_unavailable",
      diagnostic: { stage: "provider_request", code: "provider_rate_limited",
        providerRequestAttempted: true, httpStatus: 429 },
    });
  });

  it("distinguishes pre-call, request, and response failures without the upstream error", async () => {
    await expect(openAiModerateText(request(operation({ baseUrl: "https://example.com/v1" }))))
      .rejects.toMatchObject({ diagnostic: { stage: "configuration",
        code: "configured_endpoint_invalid", providerRequestAttempted: false } });
    mocks.create.mockRejectedValueOnce(Object.assign(new Error("secret-rich upstream body"), { status: 401 }));
    try {
      await openAiModerateText(request());
      throw new Error("Expected an API failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ModerationDependencyFailure);
      expect(JSON.stringify(error)).not.toContain("secret-rich");
      expect(moderationExceptionLogFields(error, "test")).toEqual({ exceptionMessage: "secret-rich upstream body" });
      expect(moderationExceptionLogFields(error, "production")).toEqual({});
      expect(error).toMatchObject({ diagnostic: { code: "provider_authentication_failed", httpStatus: 401 } });
    }
    mocks.create.mockResolvedValueOnce({ model: "different-model", results: [{
      flagged: false, categories: {}, category_scores: {},
    }] });
    await expect(openAiModerateText(request())).rejects.toMatchObject({
      diagnostic: { stage: "provider_response", code: "provider_model_mismatch",
        providerRequestAttempted: true },
    });
  });
});
