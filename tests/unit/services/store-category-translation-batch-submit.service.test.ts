import { describe, expect, it, vi } from "vitest";

process.env.REDIS_URL ??= "redis://localhost:6379/store-category-submit-tests";

const { StoreCategoryTranslationBatchSubmitService } =
  await import("../../../src/services/store-category-translation-batch-submit.service.js");

const claimedBatch = {
  id: "batch-1",
  runId: "run-1",
  environment: "TEST",
  provider: "openai",
  model: "model-1",
  inputFileId: null,
  submitAttemptCount: 1,
};

const request = {
  translationId: "item-1",
  providerCustomId: "custom-1",
  sourceLanguageTag: "en-GB",
  targetLanguageTag: "fr-FR",
  sourceText: "Shoes",
};

function createDatabase(options: {
  claim?: Record<string, unknown>[];
  requests?: Record<string, unknown>[];
  executeResults?: number[];
} = {}) {
  const queryResults = [options.claim ?? [], options.requests ?? []];
  const executeResults = [...(options.executeResults ?? [])];
  const queryRaw = vi.fn(async (_query: unknown) => queryResults.shift() ?? []);
  const executeRaw = vi.fn(async (_query: any) => executeResults.shift() ?? 1);
  const transaction = vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback({
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
  }));
  return {
    database: { $transaction: transaction },
    queryRaw,
    executeRaw,
  };
}

function createProvider(overrides: Record<string, unknown> = {}) {
  return {
    prepareBatchInput: vi.fn(async () => ({ inputFileId: "file-1" })),
    createBatch: vi.fn(async () => ({
      providerBatchId: "provider-batch-1",
      provider: "openai",
      logicalBatchId: "batch-1",
      status: "nonterminal",
      inputFileId: "file-1",
      outputFileId: null,
      errorFileId: null,
      failureCode: null,
      createdAt: null,
      completedAt: null,
    })),
    retrieveBatch: vi.fn(),
    findBatchByCorrelation: vi.fn(),
    readOutputFile: vi.fn(),
    ...overrides,
  } as any;
}

function runtimeConfig() {
  return { current: vi.fn(() => ({
    translationInitialPollSeconds: 420,
    translationSubmitRetrySeconds: 660,
    translationSubmitMaxAttempts: 3,
  })) } as any;
}

describe("StoreCategoryTranslationBatchSubmitService", () => {
  it("resolves the environment credential and submits through the shared provider lifecycle", async () => {
    const database = createDatabase({ claim: [claimedBatch], requests: [request] });
    const provider = createProvider();
    const providerFactory = vi.fn(() => provider);
    const resolve = vi.fn(async () => "api-key");
    const add = vi.fn(async () => undefined);
    const service = new StoreCategoryTranslationBatchSubmitService({
      database: database.database,
      providerFactory,
      credentialResolverFactory: () => ({ resolve } as any),
      queue: { add },
      runtimeConfig: runtimeConfig(),
    });

    await expect(service.submit({ translationBatchId: "batch-1" })).resolves.toEqual({
      status: "claimed",
      batchId: "batch-1",
      providerBatchId: "provider-batch-1",
    });

    expect(resolve).toHaveBeenCalledWith({ environment: "TEST", provider: "openai" });
    expect(providerFactory).toHaveBeenCalledWith({
      provider: "openai",
      model: "model-1",
      apiKey: "api-key",
    });
    expect(provider.prepareBatchInput).toHaveBeenCalledWith([request]);
    expect(provider.createBatch).toHaveBeenCalledWith("batch-1", "file-1");
    expect(add).toHaveBeenCalledWith(
      "store-category-translation-batch-poll",
      expect.objectContaining({ translationBatchId: "batch-1", pollSequence: 1 }),
      expect.objectContaining({ delay: 420_000 }),
    );
  });

  it("returns preparation failures to READY without calling provider create", async () => {
    const database = createDatabase({ claim: [claimedBatch], requests: [request] });
    const provider = createProvider({
      prepareBatchInput: vi.fn(async () => { throw new Error("upload unavailable"); }),
    });
    const service = new StoreCategoryTranslationBatchSubmitService({
      database: database.database,
      providerFactory: () => provider,
      credentialResolverFactory: () => ({ resolve: vi.fn(async () => "api-key") } as any),
      queue: { add: vi.fn(async () => undefined) },
      runtimeConfig: runtimeConfig(),
    });

    await expect(service.submit({ translationBatchId: "batch-1" })).resolves.toEqual({
      status: "skipped",
      batchId: "batch-1",
    });
    expect(provider.createBatch).not.toHaveBeenCalled();
    expect(database.executeRaw).toHaveBeenCalledTimes(1);
    expect(database.executeRaw.mock.calls[0]?.[0].values).toContain("READY");
  });

  it("records uncertain provider create as SUBMISSION_UNKNOWN and rethrows", async () => {
    const database = createDatabase({
      claim: [{ ...claimedBatch, inputFileId: "file-existing" }],
      requests: [],
    });
    const provider = createProvider({
      createBatch: vi.fn(async () => { throw new Error("timeout"); }),
    });
    const service = new StoreCategoryTranslationBatchSubmitService({
      database: database.database,
      providerFactory: () => provider,
      credentialResolverFactory: () => ({ resolve: vi.fn(async () => "api-key") } as any),
      queue: { add: vi.fn(async () => undefined) },
      runtimeConfig: runtimeConfig(),
    });

    await expect(service.submit({ translationBatchId: "batch-1" })).rejects.toThrow("timeout");
    expect(database.executeRaw).toHaveBeenCalledTimes(1);
    expect(database.executeRaw.mock.calls[0]?.[0].values).toContain("SUBMISSION_UNKNOWN");
  });

  it("treats credential resolution failure as a terminal non-created submission", async () => {
    const database = createDatabase({ claim: [claimedBatch] });
    const service = new StoreCategoryTranslationBatchSubmitService({
      database: database.database,
      providerFactory: vi.fn(),
      credentialResolverFactory: () => ({
        resolve: vi.fn(async () => { throw new Error("credential unavailable"); }),
      } as any),
      queue: { add: vi.fn(async () => undefined) },
      runtimeConfig: runtimeConfig(),
    });

    await expect(service.submit({ translationBatchId: "batch-1" })).resolves.toEqual({
      status: "skipped",
      batchId: "batch-1",
    });
    expect(database.executeRaw).toHaveBeenCalledTimes(2);
    expect(database.executeRaw.mock.calls[0]?.[0].values).toContain("FAILED");
  });
});
