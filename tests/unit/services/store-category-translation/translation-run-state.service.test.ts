import { describe, expect, it, vi } from "vitest";

import { StoreCategoryTranslationRunStateService } from "../../../../src/services/store-category-translation/translation-run-state.service.js";

function sqlText(query: { strings: readonly string[] }): string {
  return query.strings.join("");
}

function createHarness(options: {
  counts?: { total: bigint; available: bigint; failed: bigint; pending: bigint };
  changed?: number;
} = {}) {
  const query = vi.fn(async () => [options.counts ?? {
    total: 1n,
    available: 1n,
    failed: 0n,
    pending: 0n,
  }]);
  const execute = vi.fn(async () => options.changed ?? 1);
  const transaction = { $queryRaw: query, $executeRaw: execute };
  const database = {
    $transaction: vi.fn(async (callback: (current: typeof transaction) => Promise<unknown>) =>
      callback(transaction)),
  };
  return { service: new StoreCategoryTranslationRunStateService(database as never), database, query, execute, transaction };
}

describe("StoreCategoryTranslationRunStateService", () => {
  it("moves a fully available processing run to READY_TO_PUBLISH", async () => {
    const harness = createHarness({
      counts: { total: 3n, available: 3n, failed: 0n, pending: 0n },
    });

    await expect(harness.service.advance("run-1")).resolves.toEqual({
      status: "READY_TO_PUBLISH",
      localeItemCount: 3,
    });

    const update = harness.execute.mock.calls[0]?.[0];
    expect(sqlText(update)).toContain('"status" = \'READY_TO_PUBLISH\'');
    expect(sqlText(update)).toContain('"failureCode" = NULL');
  });

  it("moves a processing run with any failed item to FAILED", async () => {
    const harness = createHarness({
      counts: { total: 2n, available: 1n, failed: 1n, pending: 0n },
    });

    await expect(harness.service.advance("run-1")).resolves.toEqual({
      status: "FAILED",
      failureCode: "TRANSLATION_ITEM_FAILED",
    });

    const update = harness.execute.mock.calls[0]?.[0];
    expect(sqlText(update)).toContain('"status" = \'FAILED\'');
    expect(sqlText(update)).toContain('TRANSLATION_ITEM_FAILED');
  });

  it("keeps incomplete or empty runs PROCESSING without a state mutation", async () => {
    const incomplete = createHarness({
      counts: { total: 2n, available: 1n, failed: 0n, pending: 1n },
    });
    const empty = createHarness({
      counts: { total: 0n, available: 0n, failed: 0n, pending: 0n },
    });

    await expect(incomplete.service.advance("run-1")).resolves.toEqual({ status: "PROCESSING" });
    await expect(empty.service.advance("run-2")).resolves.toEqual({ status: "PROCESSING" });
    expect(incomplete.execute).not.toHaveBeenCalled();
    expect(empty.execute).not.toHaveBeenCalled();
  });

  it("returns PROCESSING when another worker wins the run transition CAS", async () => {
    const harness = createHarness({
      counts: { total: 1n, available: 0n, failed: 1n, pending: 0n },
      changed: 0,
    });

    await expect(harness.service.advance("run-1")).resolves.toEqual({ status: "PROCESSING" });
  });

  it("can advance inside a caller-owned transaction without opening another transaction", async () => {
    const harness = createHarness({
      counts: { total: 1n, available: 1n, failed: 0n, pending: 0n },
    });

    await expect(harness.service.advance("run-1", harness.transaction)).resolves.toEqual({
      status: "READY_TO_PUBLISH",
      localeItemCount: 1,
    });

    expect(harness.database.$transaction).not.toHaveBeenCalled();
  });
});
