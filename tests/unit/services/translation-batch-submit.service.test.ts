import { describe, expect, it, vi } from "vitest";

process.env.REDIS_URL ??= "redis://localhost:6379/translation-submit-tests";
process.env.OPENAI_API_KEY ??= "test-key";
process.env.TRANSLATION_MODEL ??= "test-model";

const { TranslationBatchSubmissionError, TranslationBatchSubmitService } =
  await import("../../../src/services/translation-batch-submit.service.js");

function createDatabase(options: {
  claim?: Record<string, unknown>[];
  requests?: Record<string, unknown>[];
} = {}) {
  const execute = vi.fn(async () => 1);
  let queryCall = 0;
  const transaction = vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => {
    queryCall += 1;
    const rows = queryCall === 1 ? options.claim ?? [] : options.requests ?? [];
    return callback({
      $queryRaw: vi.fn(async () => rows),
      $executeRaw: execute,
    });
  });
  return { database: { $transaction: transaction }, execute, transaction };
}

function createProvider(overrides: Record<string, unknown> = {}) {
  return {
    prepareBatchInput: vi.fn(async () => ({ inputFileId: "file-1" })),
    createBatch: vi.fn(async () => ({
      provider: "openai" as const,
      providerBatchId: "provider-batch-1",
      logicalBatchId: "batch-1",
      status: "nonterminal" as const,
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
  };
}

const claimedBatch = {
  id: "batch-1",
  provider: "openai",
  model: "test-model",
  inputFileId: null,
  submitAttemptCount: 1,
};

const request = {
  translationId: "translation-1",
  providerCustomId: "translation-custom-1",
  direction: "MERCHANT_TO_ADMIN",
  sourceLanguageTag: "fr-FR",
  targetLanguageTag: "en-GB",
  sourceText: "Authoritative source",
};

describe("TranslationBatchSubmitService", () => {
  it("lets only one concurrent delivery cross provider create", async () => {
    let claimed = true;
    const database = createDatabase({
      claim: [],
      requests: [request],
    });
    database.transaction.mockImplementation(async (callback) => {
      return callback({
        $queryRaw: vi.fn(async () => {
          if (!claimed) return [];
          claimed = false;
          return [claimedBatch];
        }),
        $executeRaw: database.execute,
      });
    });
    const provider = createProvider();
    const service = new TranslationBatchSubmitService({
      database: database.database,
      provider,
      queue: { add: vi.fn(async () => undefined) },
    });

    const results = await Promise.all([
      service.submit({ translationBatchId: "batch-1" }),
      service.submit({ translationBatchId: "batch-1" }),
    ]);

    expect(results.filter((result) => result.status === "claimed")).toHaveLength(1);
    expect(provider.createBatch).toHaveBeenCalledTimes(1);
  });

  it("loads authoritative requests, persists success, and schedules the first poll in minutes", async () => {
    process.env.TRANSLATION_BATCH_INITIAL_POLL_MINUTES = "7";
    const database = createDatabase({ claim: [claimedBatch], requests: [request] });
    const provider = createProvider();
    const add = vi.fn(async () => undefined);
    const service = new TranslationBatchSubmitService({
      database: database.database,
      provider,
      queue: { add },
    });

    const result = await service.submit({ translationBatchId: "batch-1" });

    expect(result).toMatchObject({ status: "claimed", providerBatchId: "provider-batch-1" });
    expect(provider.prepareBatchInput).toHaveBeenCalledWith([request]);
    expect(provider.createBatch).toHaveBeenCalledWith("batch-1", "file-1");
    expect(add).toHaveBeenCalledWith(
      "translation-batch-poll",
      { schemaVersion: 1, translationBatchId: "batch-1", pollSequence: 1 },
      expect.objectContaining({ delay: 7 * 60_000 }),
    );
    expect(database.execute).toHaveBeenCalledTimes(2);
  });

  it("does not submit a batch that is no longer READY", async () => {
    const database = createDatabase();
    const provider = createProvider();
    const service = new TranslationBatchSubmitService({
      database: database.database,
      provider,
      queue: { add: vi.fn(async () => undefined) },
    });

    await expect(service.submit({ translationBatchId: "batch-1" })).resolves.toEqual({
      status: "skipped",
      batchId: "batch-1",
    });
    expect(provider.createBatch).not.toHaveBeenCalled();
  });

  it("returns definite retryable preparation failure to READY with a minute delay", async () => {
    process.env.TRANSLATION_BATCH_SUBMIT_RETRY_MINUTES = "11";
    const database = createDatabase({ claim: [claimedBatch], requests: [request] });
    const provider = createProvider({
      prepareBatchInput: vi.fn(async () => {
        throw new TranslationBatchSubmissionError(
          "DEFINITE_RETRYABLE_NOT_CREATED",
          "upload unavailable",
        );
      }),
    });
    const service = new TranslationBatchSubmitService({
      database: database.database,
      provider,
      queue: { add: vi.fn(async () => undefined) },
    });

    await expect(service.submit({ translationBatchId: "batch-1" })).resolves.toEqual({
      status: "skipped",
      batchId: "batch-1",
    });
    expect(provider.createBatch).not.toHaveBeenCalled();
    expect(database.execute).toHaveBeenCalledTimes(1);
  });

  it("preserves an explicit terminal preparation failure", async () => {
    const database = createDatabase({ claim: [claimedBatch], requests: [request] });
    const provider = createProvider({
      prepareBatchInput: vi.fn(async () => {
        throw new TranslationBatchSubmissionError(
          "DEFINITE_TERMINAL_NOT_CREATED",
          "invalid request",
        );
      }),
    });
    const service = new TranslationBatchSubmitService({
      database: database.database,
      provider,
      queue: { add: vi.fn(async () => undefined) },
    });

    await expect(service.submit({ translationBatchId: "batch-1" })).resolves.toEqual({
      status: "skipped",
      batchId: "batch-1",
    });
    expect(database.execute).toHaveBeenCalledTimes(1);
  });

  it("records ambiguous create as SUBMISSION_UNKNOWN and never retries create", async () => {
    const database = createDatabase({ claim: [claimedBatch], requests: [request] });
    const provider = createProvider({
      createBatch: vi.fn(async () => {
        throw new TranslationBatchSubmissionError("AMBIGUOUS_CREATE", "timeout");
      }),
    });
    const service = new TranslationBatchSubmitService({
      database: database.database,
      provider,
      queue: { add: vi.fn(async () => undefined) },
    });

    await expect(service.submit({ translationBatchId: "batch-1" })).rejects.toThrow("timeout");
    expect(provider.createBatch).toHaveBeenCalledTimes(1);
    expect(database.execute).toHaveBeenCalledTimes(2);
  });

  it("keeps an ambiguous create unknown even after the attempt limit", async () => {
    process.env.TRANSLATION_BATCH_SUBMIT_MAX_ATTEMPTS = "1";
    const database = createDatabase({
      claim: [{ ...claimedBatch, submitAttemptCount: 1 }],
      requests: [request],
    });
    const provider = createProvider({
      createBatch: vi.fn(async () => {
        throw new TranslationBatchSubmissionError("AMBIGUOUS_CREATE", "timeout");
      }),
    });
    const service = new TranslationBatchSubmitService({
      database: database.database,
      provider,
      queue: { add: vi.fn(async () => undefined) },
    });

    await expect(service.submit({ translationBatchId: "batch-1" })).rejects.toThrow("timeout");
    expect(database.execute).toHaveBeenCalledTimes(2);
  });

  it("keeps durable SUBMITTED state when poll enqueue fails", async () => {
    const database = createDatabase({ claim: [{ ...claimedBatch, inputFileId: "file-existing" }], requests: [] });
    const provider = createProvider();
    const service = new TranslationBatchSubmitService({
      database: database.database,
      provider,
      queue: { add: vi.fn(async () => { throw new Error("Redis unavailable"); }) },
    });

    await expect(service.submit({ translationBatchId: "batch-1" })).resolves.toMatchObject({
      status: "claimed",
    });
    expect(provider.prepareBatchInput).not.toHaveBeenCalled();
    expect(provider.createBatch).toHaveBeenCalledWith("batch-1", "file-existing");
    expect(database.execute).toHaveBeenCalledTimes(1);
  });
});