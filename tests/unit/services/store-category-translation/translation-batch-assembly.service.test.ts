import { describe, expect, it, vi } from "vitest";

import { StoreCategoryTranslationBatchAssemblyService } from "../../../../src/services/store-category-translation/translation-batch-assembly.service.js";

function sqlText(value: unknown): string {
  return String((value as { sql?: string })?.sql ?? value);
}

function createHarness(options: {
  runs?: Array<{ id: string; provider: string; providerModelId: string }>;
  candidates?: Array<{ id: string }>;
} = {}) {
  const transaction = {
    $queryRaw: vi.fn()
      .mockResolvedValueOnce(options.runs ?? [{ id: "run-1", provider: "openai", providerModelId: "model-1" }])
      .mockResolvedValueOnce(options.candidates ?? [{ id: "item-1" }, { id: "item-2" }]),
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
  const database = {
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)),
  };
  const ids = ["batch-1", "batch-item-1", "batch-item-2"];
  const idFactory = vi.fn(() => ids.shift() ?? "unexpected-id");
  const service = new StoreCategoryTranslationBatchAssemblyService(database as any, idFactory);
  return { service, database, transaction, idFactory };
}

describe("StoreCategoryTranslationBatchAssemblyService", () => {
  it("assembles one READY batch and attaches the selected pending items atomically", async () => {
    const { service, database, transaction, idFactory } = createHarness();

    await expect(service.assemble("run-1", 25)).resolves.toEqual({
      batchId: "batch-1",
      itemCount: 2,
      provider: "openai",
      model: "model-1",
    });

    expect(database.$transaction).toHaveBeenCalledOnce();
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(2);
    expect(sqlText(transaction.$queryRaw.mock.calls[0]?.[0])).toContain('FOR UPDATE');
    const candidateQuery = sqlText(transaction.$queryRaw.mock.calls[1]?.[0]);
    expect(candidateQuery).toContain('"status" = \'PENDING\'');
    expect(candidateQuery).toContain('"currentBatchId" IS NULL');
    expect(candidateQuery).toContain('"nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW()');
    expect(candidateQuery).toContain("FOR UPDATE SKIP LOCKED");

    expect(transaction.$executeRaw).toHaveBeenCalledTimes(5);
    expect(sqlText(transaction.$executeRaw.mock.calls[0]?.[0])).toContain('INSERT INTO "commerce"."CommerceStoreCategoryTranslationBatch"');
    expect(sqlText(transaction.$executeRaw.mock.calls[0]?.[0])).toContain("'READY'");

    const firstBatchItem = transaction.$executeRaw.mock.calls[1]?.[0] as any;
    expect(sqlText(firstBatchItem)).toContain('INSERT INTO "commerce"."CommerceStoreCategoryTranslationBatchItem"');
    expect(firstBatchItem.values).toContain("batch-item-1");
    expect(firstBatchItem.values).toContain("batch-1");
    expect(firstBatchItem.values).toContain("item-1");
    expect(firstBatchItem.values).toContain("store-category-item-1-batch-1");

    const firstItemUpdate = transaction.$executeRaw.mock.calls[2]?.[0] as any;
    expect(sqlText(firstItemUpdate)).toContain('UPDATE "commerce"."CommerceStoreCategoryTranslationItem"');
    expect(firstItemUpdate.values).toContain("batch-1");
    expect(firstItemUpdate.values).toContain("item-1");

    expect(idFactory).toHaveBeenCalledTimes(3);
  });

  it("returns null without creating a batch when the run is no longer PROCESSING", async () => {
    const { service, transaction, idFactory } = createHarness({ runs: [] });

    await expect(service.assemble("run-1", 25)).resolves.toBeNull();

    expect(transaction.$queryRaw).toHaveBeenCalledOnce();
    expect(transaction.$executeRaw).not.toHaveBeenCalled();
    expect(idFactory).not.toHaveBeenCalled();
  });

  it("returns null when no due unbatched translation items can be claimed", async () => {
    const { service, transaction, idFactory } = createHarness({ candidates: [] });

    await expect(service.assemble("run-1", 25)).resolves.toBeNull();

    expect(transaction.$queryRaw).toHaveBeenCalledTimes(2);
    expect(transaction.$executeRaw).not.toHaveBeenCalled();
    expect(idFactory).not.toHaveBeenCalled();
  });

  it("uses the requested batch limit when claiming pending items", async () => {
    const { service, transaction } = createHarness({ candidates: [{ id: "item-1" }] });

    await service.assemble("run-1", 7);

    const query = transaction.$queryRaw.mock.calls[1]?.[0] as any;
    expect(query.values).toContain(7);
  });
});
