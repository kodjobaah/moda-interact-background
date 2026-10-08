import { describe, expect, it, vi } from "vitest";

import { StoreCategoryTranslationBatchPollService } from "../../../src/services/store-category-translation-batch-poll.service.js";
import { backgroundRuntimeConfig } from "../../helpers/background-runtime-config.js";

function providerBatch(failureCode: string) {
  return {
    provider: "openai" as const,
    providerStatus: "failed" as const,
    providerBatchId: "provider-batch-1",
    logicalBatchId: "batch-1",
    status: "failed" as const,
    inputFileId: "input-1",
    outputFileId: null,
    errorFileId: "error-1",
    failureCode,
    createdAt: null,
    completedAt: null,
  };
}

function createHarness(failureCode: string, retryCount = 0) {
  const transaction = {
    $queryRaw: vi.fn()
      .mockResolvedValueOnce([{
        id: "batch-1",
        runId: "run-1",
        categoryId: "category-1",
        environment: "TEST",
        provider: "openai",
        model: "gpt-test",
        providerBatchId: "provider-batch-1",
        status: "SUBMITTED",
        pollSequence: 3,
      }])
      .mockResolvedValueOnce([{ translationItemId: "item-1", retryCount }]),
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
  const database = {
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)),
  };
  const provider = {
    retrieveBatch: vi.fn().mockResolvedValue(providerBatch(failureCode)),
  };
  const queue = { add: vi.fn().mockResolvedValue(undefined) };
  const runtimeConfig = {
    current: () => backgroundRuntimeConfig({
      translationMaxAutoRetries: 3,
      translationResultRetrySeconds: 60,
    }),
  };
  const service = new StoreCategoryTranslationBatchPollService({
    database: database as any,
    providerFactory: () => provider as any,
    queue: queue as any,
    runtimeConfig,
    credentialResolverFactory: () => ({ resolve: vi.fn().mockResolvedValue("provider-api-key") }) as any,
  });
  return { service, transaction, provider, queue };
}

describe("StoreCategoryTranslationBatchPollService terminal retry policy", () => {
  it("releases an item for retry after a retryable terminal provider failure", async () => {
    const { service, transaction } = createHarness("http-500", 0);

    const result = await service.poll({
      schemaVersion: 1,
      translationBatchId: "batch-1",
      pollSequence: 3,
    });

    expect(result).toEqual({ status: "terminal", batchId: "batch-1", providerStatus: "failed" });
    const itemUpdate = transaction.$executeRaw.mock.calls[1]?.[0];
    expect(itemUpdate.values).toContain("PENDING");
    expect(itemUpdate.values).toContain(1);
    expect(itemUpdate.values.some((value: unknown) => value instanceof Date)).toBe(true);
    expect(itemUpdate.values).toContain("http-500");
  });

  it("terminally fails an item after a non-retryable provider failure", async () => {
    const { service, transaction } = createHarness("invalid-request", 0);

    const result = await service.poll({
      schemaVersion: 1,
      translationBatchId: "batch-1",
      pollSequence: 3,
    });

    expect(result).toEqual({ status: "terminal", batchId: "batch-1", providerStatus: "failed" });
    const itemUpdate = transaction.$executeRaw.mock.calls[1]?.[0];
    expect(itemUpdate.values).toContain("FAILED");
    expect(itemUpdate.values).toContain(0);
    expect(itemUpdate.values).toContain(null);
    expect(itemUpdate.values).toContain("invalid-request");
  });
});

describe("StoreCategoryTranslationBatchPollService provider read boundary", () => {
  it("reschedules when credential resolution fails before provider retrieval", async () => {
    const transaction = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{
          id: "batch-1",
          runId: "run-1",
          categoryId: "category-1",
          environment: "TEST",
          provider: "openai",
          model: "gpt-test",
          providerBatchId: "provider-batch-1",
          status: "SUBMITTED",
          pollSequence: 3,
        }])
        .mockResolvedValueOnce([{ pollSequence: 4, nextPollAt: new Date("2026-10-08T09:01:00.000Z") }]),
      $executeRaw: vi.fn(),
    };
    const database = {
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)),
    };
    const providerFactory = vi.fn();
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    const service = new StoreCategoryTranslationBatchPollService({
      database: database as any,
      providerFactory: providerFactory as any,
      queue: queue as any,
      runtimeConfig: {
        current: () => backgroundRuntimeConfig({ translationPollIntervalSeconds: 60 }),
      },
      credentialResolverFactory: () => ({
        resolve: vi.fn().mockRejectedValue(new Error("credential unavailable")),
      }) as any,
    });

    await expect(service.poll({
      schemaVersion: 1,
      translationBatchId: "batch-1",
      pollSequence: 3,
    })).resolves.toEqual({ status: "rescheduled", batchId: "batch-1", pollSequence: 4 });

    expect(providerFactory).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      "store-category-translation-batch-poll",
      expect.objectContaining({ translationBatchId: "batch-1", pollSequence: 4 }),
      expect.objectContaining({ delay: 60_000 }),
    );
  });
});
