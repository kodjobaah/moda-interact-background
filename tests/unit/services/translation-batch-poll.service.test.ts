import { describe, expect, it, vi } from "vitest";

process.env.REDIS_URL ??= "redis://localhost:6379/translation-poll-tests";
process.env.OPENAI_API_KEY ??= "test-key";
process.env.TRANSLATION_MODEL ??= "test-model";

const { TranslationBatchPollService, translationBatchPollTestInternals } =
  await import("../../../src/services/translation-batch-poll.service.js");

type Batch = {
  id: string;
  provider: string;
  model: string;
  providerBatchId: string | null;
  status: string;
  pollSequence: number;
};

function createDatabase(batch: Batch, nextSequence = batch.pollSequence + 1) {
  const query = vi.fn();
  const execute = vi.fn(async () => 1);
  const transaction = vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
    callback({ $queryRaw: query, $executeRaw: execute }));
  query
    .mockResolvedValueOnce([batch])
    .mockResolvedValue([{ pollSequence: nextSequence }]);
  return { database: { $transaction: transaction }, query, execute };
}

function provider(status: "nonterminal" | "completed" | "failed" = "nonterminal") {
  return {
    retrieveBatch: vi.fn(async () => ({
      provider: "openai" as const,
      providerBatchId: "provider-batch-1",
      logicalBatchId: "batch-1",
      status,
      inputFileId: "file-1",
      outputFileId: status === "completed" ? "output-1" : null,
      errorFileId: null,
      failureCode: status === "failed" ? "invalid_request" : null,
      createdAt: null,
      completedAt: null,
    })),
  };
}

const batch: Batch = {
  id: "batch-1",
  provider: "openai",
  model: "test-model",
  providerBatchId: "provider-batch-1",
  status: "SUBMITTED",
  pollSequence: 4,
};

function sqlText(query: { strings: readonly string[] }): string {
  return query.strings.join("");
}

describe("TranslationBatchPollService", () => {
  it("ignores stale or terminal poll jobs without provider work", async () => {
    const database = createDatabase({ ...batch, pollSequence: 5 });
    const currentProvider = provider();
    const service = new TranslationBatchPollService({
      database: database.database,
      providerFactory: vi.fn(() => currentProvider as never),
      queue: { add: vi.fn() },
    });

    await expect(service.poll({ schemaVersion: 1, translationBatchId: "batch-1", pollSequence: 4 }))
      .resolves.toEqual({ status: "stale", batchId: "batch-1" });
    expect(currentProvider.retrieveBatch).not.toHaveBeenCalled();
  });

  it("reschedules nonterminal provider state with the next minute sequence", async () => {
    process.env.TRANSLATION_BATCH_POLL_INTERVAL_MINUTES = "7";
    const database = createDatabase(batch, 5);
    const add = vi.fn();
    const currentProvider = provider();
    const service = new TranslationBatchPollService({
      database: database.database,
      providerFactory: vi.fn(() => currentProvider as never),
      queue: { add },
    });

    await expect(service.poll({ schemaVersion: 1, translationBatchId: "batch-1", pollSequence: 4 }))
      .resolves.toEqual({ status: "rescheduled", batchId: "batch-1", pollSequence: 5 });
    expect(add).toHaveBeenCalledWith(
      "translation-batch-poll",
      { schemaVersion: 1, translationBatchId: "batch-1", pollSequence: 5 },
      expect.objectContaining({ delay: 7 * 60_000 }),
    );
  });

  it("keeps transient provider reads nonterminal and schedules a minute retry", async () => {
    const database = createDatabase(batch, 5);
    const add = vi.fn();
    const currentProvider = provider();
    currentProvider.retrieveBatch.mockRejectedValue(new Error("429"));
    const service = new TranslationBatchPollService({
      database: database.database,
      providerFactory: vi.fn(() => currentProvider as never),
      queue: { add },
    });

    await expect(service.poll({ schemaVersion: 1, translationBatchId: "batch-1", pollSequence: 4 }))
      .resolves.toMatchObject({ status: "rescheduled", pollSequence: 5 });
    expect(database.execute).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("persists provider completion before enqueueing deterministic results work", async () => {
    const database = createDatabase(batch);
    const add = vi.fn();
    const currentProvider = provider("completed");
    const service = new TranslationBatchPollService({
      database: database.database,
      providerFactory: vi.fn(() => currentProvider as never),
      queue: { add },
    });

    await expect(service.poll({ schemaVersion: 1, translationBatchId: "batch-1", pollSequence: 4 }))
      .resolves.toEqual({ status: "completed", batchId: "batch-1" });
    expect(database.execute).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      "translation-batch-results",
      { schemaVersion: 1, translationBatchId: "batch-1" },
      expect.any(Object),
    );
  });

  it("retains terminal Batch history and bounds affected translation retry", async () => {
    process.env.TRANSLATION_MAX_AUTO_RETRIES = "0";
    const query = vi.fn()
      .mockResolvedValueOnce([batch])
      .mockResolvedValueOnce([{
        translationId: "translation-1",
        messageId: "message-1",
        kind: "MERCHANT",
        retryCount: 0,
      }]);
    const execute = vi.fn(async () => 1);
    const database = {
      $transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
        callback({ $queryRaw: query, $executeRaw: execute })),
    };
    const currentProvider = provider("failed");
    const service = new TranslationBatchPollService({
      database,
      providerFactory: vi.fn(() => currentProvider as never),
      queue: { add: vi.fn() },
    });

    await expect(service.poll({ schemaVersion: 1, translationBatchId: "batch-1", pollSequence: 4 }))
      .resolves.toEqual({ status: "terminal", batchId: "batch-1", providerStatus: "failed" });
    expect(execute).toHaveBeenCalledTimes(2);
    const batchUpdate = execute.mock.calls[0]?.[0];
    const translationUpdate = execute.mock.calls[1]?.[0];
    expect(sqlText(batchUpdate)).toContain('AS "support"."MerchantTranslationBatchStatus"');
    expect(batchUpdate.values).toContain("FAILED");
    expect(sqlText(translationUpdate)).toContain('AS "support"."MerchantMessageTranslationStatus"');
    expect(translationUpdate.values).toContain("FAILED");
  });

  it("does not mutate translations when a duplicate terminal poll loses the CAS", async () => {
    const query = vi.fn().mockResolvedValueOnce([batch]);
    const execute = vi.fn().mockResolvedValue(0);
    const database = {
      $transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
        callback({ $queryRaw: query, $executeRaw: execute })),
    };
    const service = new TranslationBatchPollService({
      database,
      providerFactory: vi.fn(() => provider("failed") as never),
      queue: { add: vi.fn() },
    });

    await expect(service.poll({ schemaVersion: 1, translationBatchId: "batch-1", pollSequence: 4 }))
      .resolves.toEqual({ status: "stale", batchId: "batch-1" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("does not mark a message failed when terminal item ownership is lost", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([batch])
      .mockResolvedValueOnce([{
        translationId: "translation-1",
        messageId: "message-1",
        kind: "ADMINISTRATIVE",
        retryCount: 0,
      }]);
    const execute = vi.fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    const database = {
      $transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
        callback({ $queryRaw: query, $executeRaw: execute })),
    };
    const service = new TranslationBatchPollService({
      database,
      providerFactory: vi.fn(() => provider("failed") as never),
      queue: { add: vi.fn() },
    });

    await expect(service.poll({ schemaVersion: 1, translationBatchId: "batch-1", pollSequence: 4 }))
      .resolves.toEqual({ status: "terminal", batchId: "batch-1", providerStatus: "failed" });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("classifies HTTP terminal and transient failures explicitly", () => {
    expect(translationBatchPollTestInternals.failureIsRetryable("http-429")).toBe(true);
    expect(translationBatchPollTestInternals.failureIsRetryable("http-500")).toBe(true);
    for (const status of [400, 401, 403, 404, 422]) {
      expect(translationBatchPollTestInternals.failureIsRetryable(`http-${status}`)).toBe(false);
    }
  });

  it("bounds polling and automatic result retry configuration", () => {
    process.env.TRANSLATION_BATCH_POLL_INTERVAL_MINUTES = "999999";
    process.env.TRANSLATION_MAX_AUTO_RETRIES = "999999";
    expect(translationBatchPollTestInternals.configuredPollMinutes()).toBe(24 * 60);
    expect(translationBatchPollTestInternals.configuredMaxAutoRetries()).toBe(10);
  });
});
