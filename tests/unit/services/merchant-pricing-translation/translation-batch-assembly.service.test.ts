import { describe, expect, it, vi } from "vitest";

import { MerchantPricingTranslationBatchAssemblyService } from "../../../../src/services/merchant-pricing-translation/translation-batch-assembly.service.js";

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
  const service = new MerchantPricingTranslationBatchAssemblyService(
    database as never,
    () => ids.shift() ?? "unexpected-id",
  );
  return { service, transaction };
}

describe("MerchantPricingTranslationBatchAssemblyService", () => {
  it("atomically assembles due unbatched items using the run's model snapshot", async () => {
    const { service, transaction } = createHarness();
    await expect(service.assemble("run-1", 25)).resolves.toEqual({
      batchId: "batch-1",
      itemCount: 2,
      provider: "openai",
      model: "model-1",
    });
    expect(sqlText(transaction.$queryRaw.mock.calls[0]?.[0])).toContain('FROM "billing"."MerchantPricingTranslationRun"');
    expect(sqlText(transaction.$queryRaw.mock.calls[1]?.[0])).toContain('"targetLanguageTag" <> "sourceLanguageTag"');
    expect(sqlText(transaction.$queryRaw.mock.calls[1]?.[0])).toContain("FOR UPDATE SKIP LOCKED");
    expect(sqlText(transaction.$executeRaw.mock.calls[0]?.[0])).toContain('INSERT INTO "billing"."MerchantPricingTranslationBatch"');
    expect((transaction.$executeRaw.mock.calls[1]?.[0] as any).values).toContain("merchant-pricing-item-1-batch-1");
  });

  it("does not create a batch when the run is no longer processing", async () => {
    const { service, transaction } = createHarness({ runs: [] });
    await expect(service.assemble("run-1", 25)).resolves.toBeNull();
    expect(transaction.$executeRaw).not.toHaveBeenCalled();
  });

  it("does not create empty batches", async () => {
    const { service, transaction } = createHarness({ candidates: [] });
    await expect(service.assemble("run-1", 25)).resolves.toBeNull();
    expect(transaction.$executeRaw).not.toHaveBeenCalled();
  });
});
