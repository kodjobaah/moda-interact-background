import { describe, expect, it, vi } from "vitest";

import { StoreCategoryTranslationReconciliationService } from "../../../src/services/store-category-translation-reconciliation.service.js";
import { backgroundRuntimeConfig } from "../../helpers/background-runtime-config.js";

function createQueue() {
  return {
    getJob: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createDatabase(unknownBatch: Record<string, unknown>, updateCount = 1) {
  return {
    $queryRaw: vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([unknownBatch])
      .mockResolvedValueOnce([]),
    $executeRaw: vi.fn().mockResolvedValue(updateCount),
    $transaction: vi.fn(),
  };
}

function terminalCorrelation(status: "failed" | "expired" | "cancelled") {
  return {
    kind: "match" as const,
    batch: {
      provider: "openai" as const,
      providerStatus: status,
      providerBatchId: `provider-${status}`,
      logicalBatchId: "batch-1",
      status,
      inputFileId: "input-1",
      outputFileId: null,
      errorFileId: `error-${status}`,
      failureCode: status === "failed" ? "http-500" : status,
      createdAt: null,
      completedAt: null,
    },
  };
}

const unknownBatch = {
  id: "batch-1",
  runId: "run-1",
  environment: "TEST",
  status: "SUBMISSION_UNKNOWN",
  pollSequence: 3,
  provider: "openai",
  model: "gpt-test",
  inputFileId: "input-1",
  providerBatchId: null,
  submissionStartedAt: new Date("2026-10-08T07:00:00.000Z"),
  outputFileId: null,
  errorFileId: null,
};

describe("StoreCategoryTranslationReconciliationService provider correlation", () => {
  it.each(["failed", "expired", "cancelled"] as const)(
    "routes a correlated %s provider batch through canonical polling",
    async (status) => {
      const database = createDatabase(unknownBatch);
      const queue = createQueue();
      const provider = {
        findBatchByCorrelation: vi.fn().mockResolvedValue(terminalCorrelation(status)),
      };
      const resolve = vi.fn().mockResolvedValue("provider-api-key");
      const service = new StoreCategoryTranslationReconciliationService({
        database: database as any,
        queue: queue as any,
        providerFactory: () => provider as any,
        credentialResolverFactory: () => ({ resolve }) as any,
      });

      const result = await service.reconcile(backgroundRuntimeConfig());

      expect(result.repairedJobs).toBe(1);
      expect(database.$executeRaw).toHaveBeenCalledOnce();
      const update = database.$executeRaw.mock.calls[0]?.[0];
      expect(update.sql).toContain('UPDATE "commerce"."CommerceStoreCategoryTranslationBatch"');
      expect(update.sql).toContain('"status" = \'SUBMITTED\'');
      expect(update.sql).toContain('"nextPollAt" = NOW()');
      expect(update.sql).not.toContain("CommerceStoreCategoryTranslationItem");
      expect(queue.add).toHaveBeenCalledWith(
        "store-category-translation-batch-poll",
        expect.objectContaining({ translationBatchId: "batch-1", pollSequence: 3 }),
        expect.objectContaining({ jobId: expect.stringContaining("store-category-translation-batch-poll-batch-1-3") }),
      );
    },
  );

  it("does not enqueue poll when the SUBMISSION_UNKNOWN recovery CAS is lost", async () => {
    const database = createDatabase(unknownBatch, 0);
    const queue = createQueue();
    const provider = {
      findBatchByCorrelation: vi.fn().mockResolvedValue(terminalCorrelation("failed")),
    };
    const service = new StoreCategoryTranslationReconciliationService({
      database: database as any,
      queue: queue as any,
      providerFactory: () => provider as any,
      credentialResolverFactory: () => ({ resolve: vi.fn().mockResolvedValue("provider-api-key") }) as any,
    });

    const result = await service.reconcile(backgroundRuntimeConfig());

    expect(result.repairedJobs).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });
});
