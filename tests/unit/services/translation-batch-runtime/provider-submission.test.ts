import { describe, expect, it, vi } from "vitest";

import { submitTranslationProviderBatch } from "../../../../src/services/translation-batch-runtime/provider-submission.js";

function createProvider(overrides: Record<string, unknown> = {}) {
  return {
    prepareBatchInput: vi.fn(async () => ({ inputFileId: "file-1" })),
    createBatch: vi.fn(async () => ({ providerBatchId: "provider-batch-1" })),
    retrieveBatch: vi.fn(),
    findBatchByCorrelation: vi.fn(),
    readOutputFile: vi.fn(),
    ...overrides,
  } as any;
}

const request = {
  translationId: "translation-1",
  providerCustomId: "custom-1",
  sourceLanguageTag: "fr-FR",
  targetLanguageTag: "en-GB",
  sourceText: "Bonjour",
};

describe("translation provider submission runtime", () => {
  it("reuses a persisted input file without preparing another provider file", async () => {
    const provider = createProvider();
    const persistInputFileId = vi.fn();

    await expect(submitTranslationProviderBatch({
      logicalBatchId: "batch-1",
      inputFileId: "file-existing",
      provider,
      loadRequests: vi.fn(async () => [request]),
      persistInputFileId,
      persistSubmitted: vi.fn(async () => undefined),
    })).resolves.toEqual({
      kind: "submitted",
      inputFileId: "file-existing",
      providerBatchId: "provider-batch-1",
    });

    expect(provider.prepareBatchInput).not.toHaveBeenCalled();
    expect(persistInputFileId).not.toHaveBeenCalled();
    expect(provider.createBatch).toHaveBeenCalledWith("batch-1", "file-existing");
  });

  it("prepares and durably records the provider input before creating the batch", async () => {
    const provider = createProvider();
    const persistInputFileId = vi.fn(async () => undefined);

    const result = await submitTranslationProviderBatch({
      logicalBatchId: "batch-1",
      inputFileId: null,
      provider,
      loadRequests: vi.fn(async () => [request]),
      persistInputFileId,
      persistSubmitted: vi.fn(async () => undefined),
    });

    expect(result).toEqual({
      kind: "submitted",
      inputFileId: "file-1",
      providerBatchId: "provider-batch-1",
    });
    expect(provider.prepareBatchInput).toHaveBeenCalledWith([request]);
    expect(persistInputFileId).toHaveBeenCalledWith("file-1");
    expect(provider.createBatch).toHaveBeenCalledWith("batch-1", "file-1");
    expect(persistInputFileId.mock.invocationCallOrder[0]).toBeLessThan(
      provider.createBatch.mock.invocationCallOrder[0],
    );
  });

  it("classifies preparation failures as definitely retryable by default", async () => {
    const failure = new Error("upload unavailable");
    const provider = createProvider({
      prepareBatchInput: vi.fn(async () => { throw failure; }),
    });

    await expect(submitTranslationProviderBatch({
      logicalBatchId: "batch-1",
      inputFileId: null,
      provider,
      loadRequests: vi.fn(async () => [request]),
      persistInputFileId: vi.fn(async () => undefined),
      persistSubmitted: vi.fn(async () => undefined),
    })).resolves.toEqual({
      kind: "failed",
      phase: "prepare",
      classification: "DEFINITE_RETRYABLE_NOT_CREATED",
      error: failure,
    });

    expect(provider.createBatch).not.toHaveBeenCalled();
  });

  it("preserves an explicit terminal preparation classification", async () => {
    const failure = Object.assign(new Error("invalid request"), {
      classification: "DEFINITE_TERMINAL_NOT_CREATED" as const,
    });
    const provider = createProvider({
      prepareBatchInput: vi.fn(async () => { throw failure; }),
    });

    await expect(submitTranslationProviderBatch({
      logicalBatchId: "batch-1",
      inputFileId: null,
      provider,
      loadRequests: vi.fn(async () => [request]),
      persistInputFileId: vi.fn(async () => undefined),
      persistSubmitted: vi.fn(async () => undefined),
    })).resolves.toMatchObject({
      kind: "failed",
      phase: "prepare",
      classification: "DEFINITE_TERMINAL_NOT_CREATED",
    });
  });

  it("classifies input-file validation failure inside the create phase", async () => {
    const failure = new Error("input file unavailable");
    const provider = createProvider();

    await expect(submitTranslationProviderBatch({
      logicalBatchId: "batch-1",
      inputFileId: "file-existing",
      provider,
      loadRequests: vi.fn(async () => [request]),
      persistInputFileId: vi.fn(async () => undefined),
      persistSubmitted: vi.fn(async () => undefined),
      validateInputFileId: () => { throw failure; },
    })).resolves.toEqual({
      kind: "failed",
      phase: "create",
      classification: "AMBIGUOUS_CREATE",
      error: failure,
    });

    expect(provider.createBatch).not.toHaveBeenCalled();
  });

  it("treats failure to durably persist an accepted provider batch as ambiguous", async () => {
    const failure = Object.assign(new Error("accepted batch persistence lost"), {
      classification: "AMBIGUOUS_CREATE" as const,
    });
    const provider = createProvider();

    await expect(submitTranslationProviderBatch({
      logicalBatchId: "batch-1",
      inputFileId: "file-existing",
      provider,
      loadRequests: vi.fn(async () => [request]),
      persistInputFileId: vi.fn(async () => undefined),
      persistSubmitted: vi.fn(async () => { throw failure; }),
    })).resolves.toEqual({
      kind: "failed",
      phase: "create",
      classification: "AMBIGUOUS_CREATE",
      error: failure,
    });
  });

  it("classifies provider create uncertainty as ambiguous by default", async () => {
    const failure = new Error("provider create timed out");
    const provider = createProvider({
      createBatch: vi.fn(async () => { throw failure; }),
    });

    await expect(submitTranslationProviderBatch({
      logicalBatchId: "batch-1",
      inputFileId: "file-existing",
      provider,
      loadRequests: vi.fn(async () => [request]),
      persistInputFileId: vi.fn(async () => undefined),
      persistSubmitted: vi.fn(async () => undefined),
    })).resolves.toEqual({
      kind: "failed",
      phase: "create",
      classification: "AMBIGUOUS_CREATE",
      error: failure,
    });
  });
});
