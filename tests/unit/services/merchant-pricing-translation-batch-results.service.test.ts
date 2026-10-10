import { describe, expect, it, vi } from "vitest";

process.env.REDIS_URL ??= "redis://localhost:6379/merchant-pricing-results-tests";

const { MerchantPricingTranslationBatchResultsService } =
  await import("../../../src/services/merchant-pricing-translation-batch-results.service.js");

const batch = {
  id: "batch-1",
  runId: "run-1",
  environment: "TEST",
  provider: "openai",
  model: "model-1",
  status: "PROVIDER_COMPLETED",
  outputFileId: "output-1",
  errorFileId: null,
};

function sqlText(query: { strings: readonly string[] }): string {
  return query.strings.join("");
}

function createDatabase(options: { translatedField?: "TITLE" | "DESCRIPTION"; entity?: "PLAN" | "HIGHLIGHT"; retryCount?: number; batchPresent?: boolean; runCounts?: { total: bigint; available: bigint; failed: bigint; pending: bigint } } = {}) {
  const execute = vi.fn(async () => 1);
  const query = vi.fn(async (statement: { strings: readonly string[] }) => {
    const sql = sqlText(statement);
    if (sql.includes('FROM "billing"."MerchantPricingTranslationBatch" b')) return options.batchPresent === false ? [] : [batch];
    if (sql.includes('SELECT "providerCustomId"')) return [{ providerCustomId: "custom-1", translationItemId: "item-1" }];
    if (sql.includes('t."sourceEntityKind"::text')) return [{
      translationItemId: "item-1",
      sourceEntityKind: options.entity ?? "PLAN",
      sourceField: options.translatedField ?? "DESCRIPTION",
      status: "PENDING",
      currentBatchId: "batch-1",
      retryCount: options.retryCount ?? 0,
    }];
    if (sql.includes('FROM "billing"."MerchantPricingTranslationBatchItem" i')
      && sql.includes('t."retryCount"')) return [{
      translationItemId: "item-1",
      retryCount: options.retryCount ?? 0,
    }];
    if (sql.includes('COUNT(*)::bigint AS "count"')) return [{ count: 0n }];
    if (sql.includes('COUNT(*) FILTER (WHERE "status" = \'AVAILABLE\')')) return [options.runCounts ?? { total: 1n, available: 1n, failed: 0n, pending: 0n }];
    throw new Error(`unexpected query: ${sql}`);
  });
  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({ $queryRaw: query, $executeRaw: execute }));
  return { database: { $transaction: transaction }, query, execute };
}

function provider(translatedText: string | null, status: "completed" | "failed" = "completed") {
  return {
    readOutputFile: vi.fn(async () => [{
      providerCustomId: "custom-1",
      status,
      translatedText,
      failureCode: status === "failed" ? "http-500" : null,
    }]),
  } as any;
}

const runtimeConfig = {
  current: () => ({ translationResultRetrySeconds: 90, translationMaxAutoRetries: 2 }),
} as any;

describe("MerchantPricingTranslationBatchResultsService", () => {
  it("ignores late result work once the run is no longer PROCESSING", async () => {
    const database = createDatabase({ batchPresent: false });
    const providerFactory = vi.fn();
    const service = new MerchantPricingTranslationBatchResultsService({
      database: database.database,
      providerFactory,
      credentialResolverFactory: () => ({ resolve: vi.fn() } as any),
      runtimeConfig,
    });
    await expect(service.apply({ translationBatchId: "batch-1" })).resolves.toEqual({
      status: "skipped",
      batchId: "batch-1",
    });
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it("validates translated content before making an item AVAILABLE and advances the run", async () => {
    const database = createDatabase();
    const service = new MerchantPricingTranslationBatchResultsService({
      database: database.database,
      credentialResolverFactory: () => ({ resolve: vi.fn(async () => "api-key") } as any),
      providerFactory: () => provider("Description en français"),
      runtimeConfig,
    });
    await expect(service.apply({ translationBatchId: "batch-1" })).resolves.toMatchObject({ status: "completed", applied: 1 });
    expect(database.execute.mock.calls.some(([statement]: [{ strings: readonly string[] }]) =>
      sqlText(statement).includes('"status" = \'READY_TO_APPLY\''),
    )).toBe(true);
  });

  it("returns oversized provider output to bounded item retry instead of accepting it", async () => {
    const database = createDatabase({
      entity: "HIGHLIGHT",
      translatedField: "TITLE",
      runCounts: { total: 1n, available: 0n, failed: 0n, pending: 1n },
    });
    const service = new MerchantPricingTranslationBatchResultsService({
      database: database.database,
      credentialResolverFactory: () => ({ resolve: vi.fn(async () => "api-key") } as any),
      providerFactory: () => provider("x".repeat(121)),
      runtimeConfig,
    });
    await service.apply({ translationBatchId: "batch-1" });
    const itemUpdate = database.execute.mock.calls.find(([statement]: [{ strings: readonly string[] }]) =>
      sqlText(statement).includes('UPDATE "billing"."MerchantPricingTranslationItem"'),
    )?.[0];
    expect(itemUpdate?.values).toContain("PENDING");
    expect(itemUpdate?.values).toContain("translation-output-validation-failed");
  });

  it("turns provider result-set failures into bounded durable retry work", async () => {
    const database = createDatabase({
      runCounts: { total: 1n, available: 0n, failed: 0n, pending: 1n },
    });
    const badProvider = { readOutputFile: vi.fn(async () => []) } as any;
    const service = new MerchantPricingTranslationBatchResultsService({
      database: database.database,
      credentialResolverFactory: () => ({ resolve: vi.fn(async () => "api-key") } as any),
      providerFactory: () => badProvider,
      runtimeConfig,
    });
    await expect(service.apply({ translationBatchId: "batch-1" })).resolves.toMatchObject({
      status: "failed",
      failureCode: "provider-results-unavailable",
    });
    expect(database.execute.mock.calls.some(([statement]: [{ strings: readonly string[] }]) =>
      sqlText(statement).includes('"status" = \'FAILED\'') && sqlText(statement).includes('MerchantPricingTranslationBatch'),
    )).toBe(true);
  });
});
