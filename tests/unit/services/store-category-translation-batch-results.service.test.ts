import { describe, expect, it, vi } from "vitest";

process.env.REDIS_URL ??= "redis://localhost:6379/store-category-results-tests";

const { StoreCategoryTranslationBatchResultsService } =
  await import("../../../src/services/store-category-translation-batch-results.service.js");

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

function runtimeConfig(overrides: Record<string, number> = {}) {
  return {
    current: vi.fn(() => ({
      translationResultRetrySeconds: 90,
      translationMaxAutoRetries: 2,
      ...overrides,
    })),
  } as any;
}

function createDatabase(options: {
  retryCount?: number;
  runCounts?: { total: bigint; available: bigint; failed: bigint; pending: bigint };
} = {}) {
  const execute = vi.fn(async () => 1);
  const query = vi.fn(async (statement: { strings: readonly string[] }) => {
    const sql = sqlText(statement);
    if (sql.includes('FROM "commerce"."CommerceStoreCategoryTranslationBatch" b')) {
      return [batch];
    }
    if (sql.includes('FROM "commerce"."CommerceStoreCategoryTranslationBatchItem"')
      && sql.includes('SELECT "providerCustomId"')) {
      return [{ providerCustomId: "custom-1", translationItemId: "item-1" }];
    }
    if (sql.includes('INNER JOIN "commerce"."CommerceStoreCategoryTranslationItem" t')
      && sql.includes('t."retryCount"')) {
      return [{
        translationItemId: "item-1",
        status: "PENDING",
        currentBatchId: "batch-1",
        retryCount: options.retryCount ?? 0,
      }];
    }
    if (sql.includes('COUNT(*)::bigint AS "count"')) {
      return [{ count: 0n }];
    }
    if (sql.includes('COUNT(*) FILTER (WHERE "status" = \'AVAILABLE\')')) {
      return [options.runCounts ?? {
        total: 1n,
        available: 1n,
        failed: 0n,
        pending: 0n,
      }];
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const transaction = vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
    callback({ $queryRaw: query, $executeRaw: execute }));
  return { database: { $transaction: transaction }, query, execute };
}

function provider(result: Record<string, unknown>) {
  return {
    readOutputFile: vi.fn(async () => [{
      providerCustomId: "custom-1",
      status: "completed" as const,
      translatedText: "Translated category",
      failureCode: null,
      ...result,
    }]),
  };
}

describe("StoreCategoryTranslationBatchResultsService", () => {
  it("resolves the environment credential, applies provider output, and advances a completed run", async () => {
    const database = createDatabase();
    const credentialResolver = { resolve: vi.fn().mockResolvedValue("api-key") };
    const currentProvider = provider({});
    const providerFactory = vi.fn(() => currentProvider as never);
    const service = new StoreCategoryTranslationBatchResultsService({
      database: database.database,
      credentialResolverFactory: () => credentialResolver as never,
      providerFactory,
    });

    await expect(service.apply({ translationBatchId: "batch-1" })).resolves.toEqual({
      status: "completed",
      batchId: "batch-1",
      applied: 1,
    });

    expect(credentialResolver.resolve).toHaveBeenCalledWith({
      environment: "TEST",
      provider: "openai",
    });
    expect(providerFactory).toHaveBeenCalledWith({
      provider: "openai",
      model: "model-1",
      apiKey: "api-key",
    });
    expect(currentProvider.readOutputFile).toHaveBeenCalledWith("output-1");
    expect(database.execute.mock.calls.some(([statement]: [{ strings: readonly string[] }]) =>
      sqlText(statement).includes('"status" = \'READY_TO_PUBLISH\''),
    )).toBe(true);
  });

  it("returns retryable provider result failures to PENDING using result retry timing", async () => {
    const database = createDatabase({
      retryCount: 0,
      runCounts: { total: 1n, available: 0n, failed: 0n, pending: 1n },
    });
    const service = new StoreCategoryTranslationBatchResultsService({
      database: database.database,
      credentialResolverFactory: () => ({ resolve: vi.fn().mockResolvedValue("api-key") }) as never,
      providerFactory: vi.fn(() => provider({
        status: "failed",
        translatedText: null,
        failureCode: "http-500",
      }) as never),
      runtimeConfig: runtimeConfig({ translationResultRetrySeconds: 75 }),
    });

    await expect(service.apply({ translationBatchId: "batch-1" })).resolves.toMatchObject({
      status: "completed",
      applied: 1,
    });

    const itemUpdate = database.execute.mock.calls.find(([statement]: [{ strings: readonly string[] }]) =>
      sqlText(statement).includes('UPDATE "commerce"."CommerceStoreCategoryTranslationItem"'),
    )?.[0];
    expect(itemUpdate?.values).toContain("PENDING");
    expect(itemUpdate?.values.some((value: unknown) => value instanceof Date)).toBe(true);
    expect(database.execute.mock.calls.some(([statement]: [{ strings: readonly string[] }]) =>
      sqlText(statement).includes('"status" = \'FAILED\', "failureCode" = \'TRANSLATION_ITEM_FAILED\''),
    )).toBe(false);
  });

  it("marks the parent run FAILED when a terminal provider result fails an item", async () => {
    const database = createDatabase({
      retryCount: 0,
      runCounts: { total: 1n, available: 0n, failed: 1n, pending: 0n },
    });
    const service = new StoreCategoryTranslationBatchResultsService({
      database: database.database,
      credentialResolverFactory: () => ({ resolve: vi.fn().mockResolvedValue("api-key") }) as never,
      providerFactory: vi.fn(() => provider({
        status: "failed",
        translatedText: null,
        failureCode: "invalid-request",
      }) as never),
      runtimeConfig: runtimeConfig(),
    });

    await service.apply({ translationBatchId: "batch-1" });

    const itemUpdate = database.execute.mock.calls.find(([statement]: [{ strings: readonly string[] }]) =>
      sqlText(statement).includes('UPDATE "commerce"."CommerceStoreCategoryTranslationItem"'),
    )?.[0];
    expect(itemUpdate?.values).toContain("FAILED");
    expect(database.execute.mock.calls.some(([statement]: [{ strings: readonly string[] }]) =>
      sqlText(statement).includes('"failureCode" = \'TRANSLATION_ITEM_FAILED\''),
    )).toBe(true);
  });
});
