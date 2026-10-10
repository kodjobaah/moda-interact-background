import { describe, expect, it, vi } from "vitest";

process.env.REDIS_URL ??= "redis://localhost:6379/merchant-pricing-submit-tests";

const { MerchantPricingTranslationBatchSubmitService } =
  await import("../../../src/services/merchant-pricing-translation-batch-submit.service.js");

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
  sourceText: "Recover abandoned checkouts",
};

function createDatabase(options: {
  claim?: Record<string, unknown>[];
  requests?: Record<string, unknown>[];
} = {}) {
  const queryResults = [options.claim ?? [], options.requests ?? []];
  const queryRaw = vi.fn(async () => queryResults.shift() ?? []);
  const executeRaw = vi.fn(async () => 1);
  const transaction = vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback({
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
  }));
  return { database: { $transaction: transaction }, queryRaw, executeRaw };
}

function createProvider() {
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
  } as any;
}

const runtimeConfig = {
  current: () => ({
    translationInitialPollSeconds: 420,
    translationSubmitRetrySeconds: 660,
    translationSubmitMaxAttempts: 3,
  }),
} as any;

describe("MerchantPricingTranslationBatchSubmitService", () => {
  it("uses the durable run model snapshot and item language/source values", async () => {
    const database = createDatabase({ claim: [claimedBatch], requests: [request] });
    const provider = createProvider();
    const providerFactory = vi.fn(() => provider);
    const resolve = vi.fn(async () => "api-key");
    const add = vi.fn(async () => undefined);
    const service = new MerchantPricingTranslationBatchSubmitService({
      database: database.database,
      providerFactory,
      credentialResolverFactory: () => ({ resolve } as any),
      queue: { add },
      runtimeConfig,
    });

    await expect(service.submit({ translationBatchId: "batch-1" })).resolves.toMatchObject({
      status: "claimed",
      providerBatchId: "provider-batch-1",
    });
    expect(providerFactory).toHaveBeenCalledWith({ provider: "openai", model: "model-1", apiKey: "api-key" });
    expect(provider.prepareBatchInput).toHaveBeenCalledWith([request]);
    expect(add).toHaveBeenCalledWith(
      "merchant-pricing-translation-batch-poll",
      expect.objectContaining({ translationBatchId: "batch-1", pollSequence: 1 }),
      expect.objectContaining({ delay: 420_000 }),
    );
  });
  it("persists ambiguous provider creation as SUBMISSION_UNKNOWN and rethrows for reconciliation", async () => {
    const database = createDatabase({ claim: [{ ...claimedBatch, inputFileId: "file-existing" }] });
    const provider = createProvider();
    provider.createBatch = vi.fn(async () => { throw new Error("timeout"); });
    const service = new MerchantPricingTranslationBatchSubmitService({
      database: database.database,
      providerFactory: () => provider,
      credentialResolverFactory: () => ({ resolve: vi.fn(async () => "api-key") } as any),
      queue: { add: vi.fn(async () => undefined) },
      runtimeConfig,
    });

    await expect(service.submit({ translationBatchId: "batch-1" })).rejects.toThrow("timeout");
    expect(database.executeRaw.mock.calls[0]?.[0].values).toContain("SUBMISSION_UNKNOWN");
  });

});
