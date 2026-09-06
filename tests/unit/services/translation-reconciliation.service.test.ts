import { describe, expect, it, vi } from "vitest";

import { TranslationReconciliationService } from "../../../src/services/translation-reconciliation.service.js";

function createDatabase() {
  return {
    $queryRaw: vi.fn()
      .mockResolvedValueOnce([{ id: "translation-1" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(),
  };
}

function createQueue(state: string | undefined) {
  const remove = vi.fn().mockResolvedValue(undefined);
  const existing = state
    ? { getState: vi.fn().mockResolvedValue(state), remove }
    : undefined;
  return {
    getJob: vi.fn().mockResolvedValue(existing),
    add: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    remove,
  };
}

function emptyScanDatabase() {
  return {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(),
  };
}

describe("TranslationReconciliationService", () => {
  it("reuses a healthy deterministic dispatch job", async () => {
    const queue = createQueue("waiting");
    const service = new TranslationReconciliationService({
      queue,
      database: createDatabase(),
    });

    const result = await service.reconcile();

    expect(result.repairedJobs).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
    expect(queue.remove).not.toHaveBeenCalled();
  });

  it.each(["failed", "completed"])(
    "removes and recreates a stale %s deterministic dispatch job",
    async (state) => {
      const queue = createQueue(state);
      const service = new TranslationReconciliationService({
        queue,
        database: createDatabase(),
      });

      const result = await service.reconcile();

      expect(result.repairedJobs).toBe(1);
      expect(queue.remove).toHaveBeenCalledOnce();
      expect(queue.add).toHaveBeenCalledOnce();
      expect(queue.add.mock.calls[0]?.[2]).toEqual(
        expect.objectContaining({ jobId: expect.stringContaining("translation-dispatch-") }),
      );
    },
  );

  it("persists completed correlation files and restores results", async () => {
    const database = emptyScanDatabase();
    database.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
      id: "batch-1",
      status: "SUBMISSION_UNKNOWN",
      pollSequence: 1,
      provider: "openai",
      model: "gpt-test",
      inputFileId: "input-1",
      providerBatchId: null,
      submissionStartedAt: new Date("2026-09-06T18:00:00Z"),
      outputFileId: null,
      errorFileId: null,
      }]);
    const queue = createQueue(undefined);
    const provider = {
      findBatchByCorrelation: vi.fn().mockResolvedValue({
        kind: "match",
        batch: {
          provider: "openai",
          providerBatchId: "provider-1",
          logicalBatchId: "batch-1",
          status: "completed",
          inputFileId: "input-1",
          outputFileId: "output-1",
          errorFileId: "error-1",
          failureCode: null,
          createdAt: null,
          completedAt: null,
        },
      }),
    };
    const service = new TranslationReconciliationService({
      queue,
      database,
      providerFactory: () => provider,
    });

    const result = await service.reconcile();

    expect(result.repairedJobs).toBe(1);
    expect(provider.findBatchByCorrelation).toHaveBeenCalledWith(expect.objectContaining({
      logicalBatchId: "batch-1",
      inputFileId: "input-1",
    }));
    expect(database.$executeRaw).toHaveBeenCalledOnce();
    expect(queue.add).toHaveBeenCalledWith(
      "translation-batch-results",
      expect.objectContaining({ translationBatchId: "batch-1" }),
      expect.objectContaining({ jobId: expect.stringContaining("translation-batch-results-") }),
    );
  });

  it("uses canonical polling for terminal correlation and does not enqueue from a lost CAS", async () => {
    const database = emptyScanDatabase();
    database.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
      id: "batch-terminal",
      status: "SUBMISSION_UNKNOWN",
      pollSequence: 2,
      provider: "openai",
      model: "gpt-test",
      inputFileId: null,
      providerBatchId: null,
      submissionStartedAt: null,
      outputFileId: null,
      errorFileId: null,
      }]);
    database.$executeRaw.mockResolvedValueOnce(1);
    const queue = createQueue(undefined);
    const provider = {
      findBatchByCorrelation: vi.fn().mockResolvedValue({
        kind: "match",
        batch: {
          provider: "openai",
          providerBatchId: "provider-terminal",
          logicalBatchId: "batch-terminal",
          status: "failed",
          inputFileId: "input-terminal",
          outputFileId: null,
          errorFileId: "error-terminal",
          failureCode: "provider-failed",
          createdAt: null,
          completedAt: null,
        },
      }),
    };
    const service = new TranslationReconciliationService({ queue, database, providerFactory: () => provider });
    await service.reconcile();
    expect(queue.add).toHaveBeenCalledWith(
      "translation-batch-poll",
      expect.objectContaining({ translationBatchId: "batch-terminal", pollSequence: 2 }),
      expect.anything(),
    );

    const lostCasDatabase = emptyScanDatabase();
    lostCasDatabase.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
      id: "batch-stale", status: "SUBMISSION_UNKNOWN", pollSequence: 1, provider: "openai", model: "gpt-test",
      inputFileId: null, providerBatchId: null, submissionStartedAt: null, outputFileId: null, errorFileId: null,
      }]);
    lostCasDatabase.$executeRaw.mockResolvedValueOnce(0);
    const lostQueue = createQueue(undefined);
    const lostService = new TranslationReconciliationService({
      queue: lostQueue,
      database: lostCasDatabase,
      providerFactory: () => provider,
    });
    await lostService.reconcile();
    expect(lostQueue.add).not.toHaveBeenCalled();
  });

  it("scans each batch state independently so unknown work cannot starve repair", async () => {
    const database = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: "ready-1" }])
        .mockResolvedValueOnce([{ id: "poll-1", status: "SUBMITTED", pollSequence: 3 }])
        .mockResolvedValueOnce([{ id: "completed-1" }])
        .mockResolvedValueOnce([]),
      $executeRaw: vi.fn().mockResolvedValue(1),
      $transaction: vi.fn(),
    };
    const queue = createQueue(undefined);
    const service = new TranslationReconciliationService({ queue, database });

    const result = await service.reconcile();

    expect(result.repairedJobs).toBe(3);
    expect(queue.add).toHaveBeenCalledTimes(3);
  });

  it("repairs an exact targeted request and only resets FAILED translations", async () => {
    const database = emptyScanDatabase();
    database.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "request-outside-page", scope: "TRANSLATION", translationId: "failed-1" }])
      .mockResolvedValueOnce([{ id: "failed-1", status: "FAILED", currentBatchId: null, batchStatus: null, pollSequence: null }])
      .mockResolvedValueOnce([{ id: "failed-1" }]);
    const queue = createQueue(undefined);
    const service = new TranslationReconciliationService({ queue, database });

    const result = await service.reconcile("request-outside-page");

    expect(result.requestsProcessed).toBe(1);
    expect(queue.add).toHaveBeenCalledWith(
      "translation-dispatch",
      expect.objectContaining({ translationId: "failed-1" }),
      expect.anything(),
    );
    const resetSql = database.$queryRaw.mock.calls[6]?.[0];
    expect(resetSql?.values).toContain("failed-1");
  });

  it("keeps multi-page FAILED_TRANSLATIONS requests retryable and reclaims stale processing", async () => {
    const database = emptyScanDatabase();
    database.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "request-1", scope: "FAILED_TRANSLATIONS", translationId: null }])
      .mockResolvedValueOnce([{ id: "failed-1" }])
      .mockResolvedValueOnce([{ id: "remaining-failed" }]);
    const queue = createQueue(undefined);
    const service = new TranslationReconciliationService({ queue, database });

    await service.reconcile();

    const remainingProbe = database.$queryRaw.mock.calls[7]?.[0];
    expect(remainingProbe?.sql).toContain('LIMIT 1');
    expect(remainingProbe?.sql).not.toContain('COUNT');
    expect(database.$executeRaw).toHaveBeenCalledWith(expect.objectContaining({
      values: expect.arrayContaining(["request-1"]),
    }));
    expect(queue.add).toHaveBeenCalledWith(
      "translation-dispatch",
      expect.objectContaining({ translationId: "failed-1" }),
      expect.anything(),
    );
  });

  it("completes FAILED_TRANSLATIONS when the bounded remaining probe is empty", async () => {
    const database = emptyScanDatabase();
    database.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "request-2", scope: "FAILED_TRANSLATIONS", translationId: null }])
      .mockResolvedValueOnce([{ id: "failed-2" }])
      .mockResolvedValueOnce([]);
    const queue = createQueue(undefined);
    const service = new TranslationReconciliationService({ queue, database });

    await service.reconcile();

    const completionUpdate = database.$executeRaw.mock.calls.at(-1)?.[0];
    expect(completionUpdate?.sql).toContain('"status" = \'COMPLETED\'');
  });

  it("returns a claimed request to PENDING when queue repair fails", async () => {
    const database = emptyScanDatabase();
    database.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "request-1", scope: "TRANSLATION", translationId: "failed-1" }])
      .mockResolvedValueOnce([{ id: "failed-1", status: "FAILED", currentBatchId: null, batchStatus: null, pollSequence: null }])
      .mockResolvedValueOnce([{ id: "failed-1" }]);
    const queue = createQueue(undefined);
    queue.add.mockRejectedValue(new Error("redis unavailable"));
    const service = new TranslationReconciliationService({ queue, database });

    await expect(service.reconcile()).rejects.toThrow("redis unavailable");
    expect(database.$executeRaw).toHaveBeenLastCalledWith(expect.objectContaining({
      values: expect.arrayContaining(["request-1"]),
    }));
  });
});