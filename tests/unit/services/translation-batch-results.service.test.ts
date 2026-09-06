import { describe, expect, it, vi } from "vitest";

process.env.REDIS_URL ??= "redis://localhost:6379/translation-results-tests";
process.env.OPENAI_API_KEY ??= "test-key";
process.env.TRANSLATION_MODEL ??= "test-model";

const { TranslationBatchResultsService, translationBatchResultsTestInternals } =
  await import("../../../src/services/translation-batch-results.service.js");

const batch = {
  id: "batch-1",
  provider: "openai",
  model: "test-model",
  status: "PROVIDER_COMPLETED",
  outputFileId: "output-1",
  errorFileId: null,
  providerBatchId: "provider-batch-1",
};

function createDatabase(options: {
  kind?: "ADMINISTRATIVE" | "SYSTEM" | "MERCHANT";
  translationStatus?: "PENDING" | "AVAILABLE" | "FAILED";
  currentBatchId?: string | null;
  targetLanguageTag?: string;
  displayLanguageTag?: string;
  retryCount?: number;
} = {}) {
  let queryCount = 0;
  let translationStatus = options.translationStatus ?? "PENDING";
  const query = vi.fn(async () => {
    queryCount += 1;
    if (queryCount % 4 === 1) return [batch];
    if (queryCount % 4 === 2) return [{ providerCustomId: "custom-1", translationId: "translation-1" }];
    if (queryCount % 4 === 3) {
      return [{
        translationId: "translation-1",
        messageId: "message-1",
        threadId: "thread-1",
        kind: options.kind ?? "ADMINISTRATIVE",
        translationStatus,
        currentBatchId: options.currentBatchId === undefined ? "batch-1" : options.currentBatchId,
        targetLanguageTag: options.targetLanguageTag ?? "fr-FR",
        displayLanguageTag: options.displayLanguageTag ?? "fr-FR",
        retryCount: options.retryCount ?? 0,
        messageState: "PROCESSING",
        messageCreatedAt: new Date("2026-09-06T18:00:00Z"),
        respondsThroughMerchantVersion: 4,
      }];
    }
    return [{ count: 0n }];
  });
  const execute = vi.fn(async () => {
    translationStatus = "AVAILABLE";
    return 1;
  });
  const transaction = vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
    callback({ $queryRaw: query, $executeRaw: execute }));
  return { database: { $transaction: transaction }, query, execute };
}

function provider(result: Record<string, unknown>) {
  return {
    readOutputFile: vi.fn(async () => [
      {
        providerCustomId: "custom-1",
        status: "completed" as const,
        translatedText: "Translated body",
        failureCode: null,
        ...result,
      },
    ]),
  };
}

describe("TranslationBatchResultsService", () => {
  it("applies a result, makes an administrative message available, and closes the Batch", async () => {
    const database = createDatabase({ kind: "ADMINISTRATIVE" });
    const service = new TranslationBatchResultsService({
      database: database.database,
      providerFactory: vi.fn(() => provider({}) as never),
    });

    await expect(service.apply({ translationBatchId: "batch-1" })).resolves.toEqual({
      status: "completed",
      batchId: "batch-1",
      applied: 1,
    });
    expect(database.execute).toHaveBeenCalledTimes(4);
    const threadUpdate = database.execute.mock.calls.find(([query]) =>
      query.strings.join("").includes('"merchantMessageVersion"'),
    );
    expect(threadUpdate?.[0].values).toContain(4);
    expect(database.execute.mock.calls.every(([query]) =>
      !query.strings.join("").includes('"originalBody" ='),
    )).toBe(true);
  });

  it("preserves SYSTEM pending support semantics while applying its translation", async () => {
    const database = createDatabase({ kind: "SYSTEM" });
    const service = new TranslationBatchResultsService({
      database: database.database,
      providerFactory: vi.fn(() => provider({}) as never),
    });

    await service.apply({ translationBatchId: "batch-1" });
    expect(database.execute).toHaveBeenCalledTimes(3);
  });

  it("replays an already available result without duplicating the business transition", async () => {
    const database = createDatabase({ kind: "MERCHANT", translationStatus: "AVAILABLE" });
    const service = new TranslationBatchResultsService({
      database: database.database,
      providerFactory: vi.fn(() => provider({}) as never),
    });

    await expect(service.apply({ translationBatchId: "batch-1" })).resolves.toMatchObject({
      status: "completed",
      applied: 0,
    });
    expect(database.execute).toHaveBeenCalledTimes(1);
  });

  it("rejects output custom IDs that are not historical Batch members", async () => {
    const database = createDatabase();
    const currentProvider = {
      readOutputFile: vi.fn(async () => [{
        providerCustomId: "foreign-custom-id",
        status: "completed" as const,
        translatedText: "bad mapping",
        failureCode: null,
      }]),
    };
    const service = new TranslationBatchResultsService({
      database: database.database,
      providerFactory: vi.fn(() => currentProvider as never),
    });

    await expect(service.apply({ translationBatchId: "batch-1" })).rejects.toThrow("Unknown translation Batch provider custom ID");
    expect(database.execute).not.toHaveBeenCalled();
  });

  it("returns retryable item failures to pending with a bounded next attempt", async () => {
    process.env.TRANSLATION_MAX_AUTO_RETRIES = "2";
    const database = createDatabase({ kind: "MERCHANT", retryCount: 0 });
    const currentProvider = provider({
      status: "failed" as const,
      translatedText: null,
      failureCode: "rate_limit",
    });
    const service = new TranslationBatchResultsService({
      database: database.database,
      providerFactory: vi.fn(() => currentProvider as never),
    });

    await expect(service.apply({ translationBatchId: "batch-1" })).resolves.toMatchObject({
      status: "completed",
      applied: 1,
    });
    expect(database.execute).toHaveBeenCalledTimes(2);
  });

  it("marks exhausted non-retryable admin translation failures terminally", async () => {
    process.env.TRANSLATION_MAX_AUTO_RETRIES = "0";
    const database = createDatabase({ kind: "ADMINISTRATIVE", retryCount: 0 });
    const currentProvider = provider({
      status: "failed" as const,
      translatedText: null,
      failureCode: "invalid_request",
    });
    const service = new TranslationBatchResultsService({
      database: database.database,
      providerFactory: vi.fn(() => currentProvider as never),
    });

    await service.apply({ translationBatchId: "batch-1" });
    expect(database.execute).toHaveBeenCalledTimes(3);
  });

  it("does not mutate the message when a failed-result ownership update affects no rows", async () => {
    process.env.TRANSLATION_MAX_AUTO_RETRIES = "0";
    const database = createDatabase({ kind: "ADMINISTRATIVE", retryCount: 0 });
    database.execute
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);
    const currentProvider = provider({
      status: "failed" as const,
      translatedText: null,
      failureCode: "invalid_request",
    });
    const service = new TranslationBatchResultsService({
      database: database.database,
      providerFactory: vi.fn(() => currentProvider as never),
    });

    await expect(service.apply({ translationBatchId: "batch-1" })).resolves.toEqual({
      status: "completed",
      batchId: "batch-1",
      applied: 0,
    });
    expect(database.execute.mock.calls.some(([query]) =>
      query.strings.join("").includes('"support"."MerchantSupportMessage"'),
    )).toBe(false);
  });

  it("does not replay an old Batch into a translation assigned to a newer Batch", async () => {
    const database = createDatabase({ currentBatchId: "batch-2" });
    const service = new TranslationBatchResultsService({
      database: database.database,
      providerFactory: vi.fn(() => provider({}) as never),
    });

    await expect(service.apply({ translationBatchId: "batch-1" })).resolves.toMatchObject({
      status: "completed",
      applied: 0,
    });
    expect(database.execute).toHaveBeenCalledTimes(1);
  });

  it("does not let an additional translation trigger merchant availability", async () => {
    const database = createDatabase({
      kind: "ADMINISTRATIVE",
      targetLanguageTag: "de-DE",
      displayLanguageTag: "fr-FR",
    });
    const service = new TranslationBatchResultsService({
      database: database.database,
      providerFactory: vi.fn(() => provider({}) as never),
    });

    await service.apply({ translationBatchId: "batch-1" });
    expect(database.execute).toHaveBeenCalledTimes(2);
    expect(database.execute.mock.calls.some(([query]) =>
      query.strings.join("").includes('"merchantMessageVersion"'),
    )).toBe(false);
  });

  it("classifies HTTP result failures explicitly", () => {
    expect(translationBatchResultsTestInternals.resultFailureIsRetryable("http-429")).toBe(true);
    expect(translationBatchResultsTestInternals.resultFailureIsRetryable("http-500")).toBe(true);
    for (const status of [400, 401, 403, 404, 422]) {
      expect(translationBatchResultsTestInternals.resultFailureIsRetryable(`http-${status}`)).toBe(false);
    }
  });

  it("bounds result retry configuration", () => {
    process.env.TRANSLATION_BATCH_POLL_INTERVAL_MINUTES = "999999";
    process.env.TRANSLATION_MAX_AUTO_RETRIES = "999999";
    expect(translationBatchResultsTestInternals.retryMinutes()).toBe(24 * 60);
    expect(translationBatchResultsTestInternals.maxAutoRetries()).toBe(10);
  });
});
