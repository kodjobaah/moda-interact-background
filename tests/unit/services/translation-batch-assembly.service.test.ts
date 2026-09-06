import { describe, expect, it, vi } from "vitest";

import { TranslationBatchAssemblyService } from "../../../src/services/translation-batch-assembly.service.js";

process.env.TRANSLATION_MODEL = "test-model";

function createDatabase() {
  const candidates = [
    {
      id: "translation-1",
      direction: "MERCHANT_TO_ADMIN",
      sourceLanguageTag: "fr-FR",
      targetLanguageTag: "en-GB",
      sourceText: "Authoritative body",
    },
  ];
  const $queryRaw = vi.fn(async () => candidates);
  const $executeRaw = vi.fn(async () => 1);
  const transaction = vi.fn(async (callback) =>
    callback({ $queryRaw, $executeRaw }),
  );
  return {
    database: { $transaction: transaction },
    $queryRaw,
    $executeRaw,
    transaction,
  };
}

describe("TranslationBatchAssemblyService", () => {
  it("commits the durable batch before requesting submit work", async () => {
    const database = createDatabase();
    const add = vi.fn(async () => undefined);
    const service = new TranslationBatchAssemblyService({
      database: database.database,
      queue: { add },
      maxRequests: 10,
    });
    const events: string[] = [];
    database.transaction.mockImplementationOnce(async (callback) => {
      const result = await callback({
        $queryRaw: database.$queryRaw,
        $executeRaw: database.$executeRaw,
      });
      events.push("committed");
      return result;
    });
    add.mockImplementationOnce(async () => {
      events.push("enqueued");
    });

    const result = await service.assembleFromDispatch({
      schemaVersion: 1,
      translationId: "translation-1",
    });

    expect(result.translationIds).toEqual(["translation-1"]);
    expect(events).toEqual(["committed", "enqueued"]);
    expect(add).toHaveBeenCalledWith(
      "translation-batch-submit",
      expect.objectContaining({ schemaVersion: 1 }),
      expect.objectContaining({ jobId: expect.stringContaining("translation-batch-submit-") }),
    );
  });

  it("keeps the committed batch durable when submit enqueue fails", async () => {
    const database = createDatabase();
    const add = vi.fn(async () => {
      throw new Error("Redis unavailable");
    });
    const service = new TranslationBatchAssemblyService({
      database: database.database,
      queue: { add },
      maxRequests: 1,
    });

    await expect(
      service.assembleFromDispatch({
        schemaVersion: 1,
        translationId: "translation-1",
      }),
    ).resolves.toMatchObject({ translationIds: ["translation-1"] });
    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("returns idempotently when no eligible translation is available", async () => {
    const database = createDatabase();
    database.$queryRaw.mockResolvedValueOnce([]);
    const add = vi.fn(async () => undefined);
    const service = new TranslationBatchAssemblyService({
      database: database.database,
      queue: { add },
    });

    await expect(
      service.assembleFromDispatch({
        schemaVersion: 1,
        translationId: "translation-1",
      }),
    ).resolves.toEqual({ batchId: null, translationIds: [], submitJobId: null });
    expect(database.$executeRaw).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
});
