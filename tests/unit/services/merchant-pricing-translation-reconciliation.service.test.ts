import { describe, expect, it, vi } from "vitest";

process.env.REDIS_URL ??= "redis://localhost:6379/merchant-pricing-reconciliation-tests";

const { MerchantPricingTranslationReconciliationService } =
  await import("../../../src/services/merchant-pricing-translation-reconciliation.service.js");

const runtimeConfig = {
  translationReconciliationPageSize: 25,
  translationBatchMaxRequests: 100,
  translationClaimTimeoutSeconds: 300,
} as any;

function queue() {
  return {
    getJob: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function database(sequence: unknown[][], executeResult = 1) {
  const execute = vi.fn(async () => executeResult);
  const transaction = {
    $queryRaw: vi.fn(async () => [{ total: 1n, available: 0n, failed: 1n, pending: 0n }]),
    $executeRaw: execute,
  };
  return {
    $queryRaw: vi.fn(async () => sequence.shift() ?? []),
    $executeRaw: execute,
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)),
    transaction,
  };
}

describe("MerchantPricingTranslationReconciliationService", () => {
  it("repairs a missing deterministic submit job from durable READY state", async () => {
    const db = database([
      [], // start runs
      [], // processing runs
      [{ id: "batch-1", runId: "run-1", environment: "TEST", status: "READY", pollSequence: 0, provider: "openai", model: "model-1", inputFileId: null, providerBatchId: null, submissionStartedAt: null, outputFileId: null, errorFileId: null }],
      [], // due polls
      [], // provider completed
      [], // unknown
      [], // final runs
    ]);
    const currentQueue = queue();
    const service = new MerchantPricingTranslationReconciliationService({
      database: db as any,
      queue: currentQueue as any,
      runtimeConfig: { current: () => runtimeConfig } as any,
    });

    await expect(service.reconcile(runtimeConfig)).resolves.toMatchObject({ repairedJobs: 1 });
    expect(currentQueue.add).toHaveBeenCalledWith(
      "merchant-pricing-translation-batch-submit",
      { schemaVersion: 1, translationBatchId: "batch-1" },
      { jobId: "merchant-pricing-translation-batch-submit-batch-1" },
    );
  });

  it("fails an ambiguous correlation conflict instead of resubmitting unsafe duplicate work", async () => {
    const unknown = {
      id: "batch-conflict", runId: "run-conflict", environment: "TEST", status: "SUBMISSION_UNKNOWN",
      pollSequence: 0, provider: "openai", model: "model-1", inputFileId: "input-1",
      providerBatchId: null, submissionStartedAt: new Date("2026-10-10T09:00:00.000Z"),
      outputFileId: null, errorFileId: null,
    };
    const db = database([[], [], [], [], [], [unknown], [{ id: "run-conflict" }]]);
    const service = new MerchantPricingTranslationReconciliationService({
      database: db as any,
      queue: queue() as any,
      runtimeConfig: { current: () => runtimeConfig } as any,
      credentialResolverFactory: () => ({ resolve: vi.fn(async () => "api-key") } as any),
      providerFactory: () => ({
        findBatchByCorrelation: vi.fn(async () => ({ kind: "conflict", batches: [] })),
      } as any),
    });

    await expect(service.reconcile(runtimeConfig)).resolves.toMatchObject({
      correlationConflicts: 1,
      runsFailed: 1,
    });
    expect(db.transaction.$executeRaw.mock.calls.some(([statement]: [{ strings: readonly string[] }]) =>
      statement.strings.join("").includes(`"status" = 'FAILED'`)
      && statement.strings.join("").includes('MerchantPricingTranslationBatch'),
    )).toBe(true);
    expect(db.transaction.$executeRaw.mock.calls.some(([statement]: [{ strings: readonly string[] }]) =>
      statement.strings.join("").includes('CORRELATION_CONFLICT')
      && statement.strings.join("").includes('MerchantPricingTranslationItem'),
    )).toBe(true);
  });

  it("repairs an ambiguous nonterminal provider Batch with a valid first poll sequence", async () => {
    const unknown = {
      id: "batch-poll", runId: "run-poll", environment: "TEST", status: "SUBMISSION_UNKNOWN",
      pollSequence: 0, provider: "openai", model: "model-1", inputFileId: "input-1",
      providerBatchId: null, submissionStartedAt: new Date("2026-10-10T09:00:00.000Z"),
      outputFileId: null, errorFileId: null,
    };
    const db = database([[], [], [], [], [], [unknown], []]);
    const currentQueue = queue();
    const service = new MerchantPricingTranslationReconciliationService({
      database: db as any,
      queue: currentQueue as any,
      runtimeConfig: { current: () => runtimeConfig } as any,
      credentialResolverFactory: () => ({ resolve: vi.fn(async () => "api-key") } as any),
      providerFactory: () => ({
        findBatchByCorrelation: vi.fn(async () => ({
          kind: "match",
          batch: {
            provider: "openai", providerStatus: "in_progress", providerBatchId: "provider-batch-1",
            logicalBatchId: "batch-poll", status: "nonterminal", inputFileId: "input-1",
            outputFileId: null, errorFileId: null, failureCode: null, createdAt: null, completedAt: null,
          },
        })),
      } as any),
    });

    await expect(service.reconcile(runtimeConfig)).resolves.toMatchObject({ repairedJobs: 1 });
    expect(currentQueue.add).toHaveBeenCalledWith(
      "merchant-pricing-translation-batch-poll",
      { schemaVersion: 1, translationBatchId: "batch-poll", pollSequence: 1 },
      { jobId: "merchant-pricing-translation-batch-poll-batch-poll-1" },
    );
    expect(db.$executeRaw.mock.calls.some(([statement]: [{ strings: readonly string[] }]) =>
      statement.strings.join("").includes('GREATEST("pollSequence", 1)'),
    )).toBe(true);
  });

  it("recovers an ambiguous completed provider Batch by correlation and repairs results work", async () => {
    const unknown = {
      id: "batch-1",
      runId: "run-1",
      environment: "TEST",
      status: "SUBMISSION_UNKNOWN",
      pollSequence: 0,
      provider: "openai",
      model: "model-1",
      inputFileId: "input-1",
      providerBatchId: null,
      submissionStartedAt: new Date("2026-10-10T09:00:00.000Z"),
      outputFileId: null,
      errorFileId: null,
    };
    const db = database([[], [], [], [], [], [unknown], []]);
    const currentQueue = queue();
    const findBatchByCorrelation = vi.fn(async () => ({
      kind: "match" as const,
      batch: {
        provider: "openai" as const,
        providerStatus: "completed" as const,
        providerBatchId: "provider-batch-1",
        logicalBatchId: "batch-1",
        status: "completed" as const,
        inputFileId: "input-1",
        outputFileId: "output-1",
        errorFileId: null,
        failureCode: null,
        createdAt: null,
        completedAt: null,
      },
    }));
    const service = new MerchantPricingTranslationReconciliationService({
      database: db as any,
      queue: currentQueue as any,
      runtimeConfig: { current: () => runtimeConfig } as any,
      credentialResolverFactory: () => ({ resolve: vi.fn(async () => "api-key") } as any),
      providerFactory: () => ({ findBatchByCorrelation } as any),
    });

    await expect(service.reconcile(runtimeConfig)).resolves.toMatchObject({ repairedJobs: 1 });
    expect(findBatchByCorrelation).toHaveBeenCalledWith(expect.objectContaining({
      logicalBatchId: "batch-1",
      inputFileId: "input-1",
    }));
    expect(currentQueue.add).toHaveBeenCalledWith(
      "merchant-pricing-translation-batch-results",
      { schemaVersion: 1, translationBatchId: "batch-1" },
      { jobId: "merchant-pricing-translation-batch-results-batch-1" },
    );
  });
});
