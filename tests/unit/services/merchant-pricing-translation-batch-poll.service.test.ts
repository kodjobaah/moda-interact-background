import { describe, expect, it, vi } from "vitest";

process.env.REDIS_URL ??= "redis://localhost:6379/merchant-pricing-poll-tests";

const { MerchantPricingTranslationBatchPollService } =
  await import("../../../src/services/merchant-pricing-translation-batch-poll.service.js");

function sqlText(query: { strings: readonly string[] }): string {
  return query.strings.join("");
}

function createService(failureCode: string, retryCount: number) {
  const query = vi.fn(async (statement: { strings: readonly string[] }) => {
    const sql = sqlText(statement);
    if (sql.includes('FROM "billing"."MerchantPricingTranslationBatch" b')) return [{
      id: "batch-1",
      runId: "run-1",
      environment: "TEST",
      provider: "openai",
      model: "model-1",
      providerBatchId: "provider-batch-1",
      status: "SUBMITTED",
      pollSequence: 3,
    }];
    if (sql.includes('FROM "billing"."MerchantPricingTranslationBatchItem" i')) {
      return [{ translationItemId: "item-1", retryCount }];
    }
    return [];
  });
  const execute = vi.fn(async () => 1);
  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({ $queryRaw: query, $executeRaw: execute }));
  const provider = {
    retrieveBatch: vi.fn(async () => ({
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
    })),
  } as any;
  const service = new MerchantPricingTranslationBatchPollService({
    database: { $transaction: transaction } as any,
    providerFactory: () => provider,
    credentialResolverFactory: () => ({ resolve: vi.fn(async () => "api-key") } as any),
    queue: { add: vi.fn(async () => undefined) },
    runtimeConfig: { current: () => ({
      translationPollIntervalSeconds: 60,
      translationMaxAutoRetries: 2,
      translationResultRetrySeconds: 90,
    }) } as any,
  });
  return { service, execute };
}

describe("MerchantPricingTranslationBatchPollService", () => {
  it("releases an item for bounded retry after a retryable terminal provider failure", async () => {
    const { service, execute } = createService("http-500", 0);
    await expect(service.poll({ schemaVersion: 1, translationBatchId: "batch-1", pollSequence: 3 }))
      .resolves.toEqual({ status: "terminal", batchId: "batch-1", providerStatus: "failed" });
    const itemUpdate = execute.mock.calls[1]?.[0];
    expect(itemUpdate.values).toContain("PENDING");
    expect(itemUpdate.values).toContain(1);
    expect(itemUpdate.values).toContain("http-500");
  });

  it("terminally fails an item after a non-retryable provider failure", async () => {
    const { service, execute } = createService("invalid-request", 0);
    await service.poll({ schemaVersion: 1, translationBatchId: "batch-1", pollSequence: 3 });
    const itemUpdate = execute.mock.calls[1]?.[0];
    expect(itemUpdate.values).toContain("FAILED");
    expect(itemUpdate.values).toContain(0);
    expect(itemUpdate.values).toContain("invalid-request");
  });
});
