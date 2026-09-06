import { describe, expect, it, vi } from "vitest";

process.env.REDIS_URL ??= "redis://localhost:6379/translation-lifecycle-tests";
process.env.OPENAI_API_KEY ??= "test-key";
process.env.TRANSLATION_MODEL ??= "test-model";

const { TranslationBatchResultsService } =
  await import("../../../src/services/translation-batch-results.service.js");

describe("translation Batch replay boundary", () => {
  it("replays a partially applied result without duplicating its business transition", async () => {
    let queryCount = 0;
    let status: "PENDING" | "AVAILABLE" = "PENDING";
    const query = vi.fn(async () => {
      queryCount += 1;
      const step = queryCount % 4;
      if (step === 1) return [{
        id: "batch-1", provider: "openai", model: "test-model", status: "PROVIDER_COMPLETED",
        outputFileId: "output-1", errorFileId: null, providerBatchId: "provider-batch-1",
      }];
      if (step === 2) return [{ providerCustomId: "custom-1", translationId: "translation-1" }];
      if (step === 3) return [{
        translationId: "translation-1", messageId: "message-1", threadId: "thread-1",
        kind: "MERCHANT", translationStatus: status, retryCount: 0,
        currentBatchId: "batch-1", targetLanguageTag: "fr-FR", displayLanguageTag: "fr-FR",
        messageState: "AVAILABLE", messageCreatedAt: new Date(), respondsThroughMerchantVersion: null,
      }];
      return [{ count: 0n }];
    });
    const execute = vi.fn(async () => {
      status = "AVAILABLE";
      return 1;
    });
    const database = {
      $transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
        callback({ $queryRaw: query, $executeRaw: execute })),
    };
    const provider = {
      readOutputFile: vi.fn(async () => [{
        providerCustomId: "custom-1", status: "completed" as const,
        translatedText: "Translated", failureCode: null,
      }]),
    };
    const service = new TranslationBatchResultsService({
      database,
      providerFactory: vi.fn(() => provider as never),
    });

    await service.apply({ translationBatchId: "batch-1" });
    await expect(service.apply({ translationBatchId: "batch-1" })).resolves.toMatchObject({ applied: 0 });
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
