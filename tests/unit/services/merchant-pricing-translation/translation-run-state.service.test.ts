import { describe, expect, it, vi } from "vitest";

import { MerchantPricingTranslationRunStateService } from "../../../../src/services/merchant-pricing-translation/translation-run-state.service.js";

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
  return { service: new MerchantPricingTranslationRunStateService(database as never), database, execute, transaction };
}

describe("MerchantPricingTranslationRunStateService", () => {
  it("moves a fully available processing run to READY_TO_APPLY", async () => {
    const harness = createHarness({ counts: { total: 3n, available: 3n, failed: 0n, pending: 0n } });
    await expect(harness.service.advance("run-1")).resolves.toEqual({
      status: "READY_TO_APPLY",
      itemCount: 3,
    });
    expect(sqlText(harness.execute.mock.calls[0]?.[0])).toContain('"status" = \'READY_TO_APPLY\'');
    expect(sqlText(harness.execute.mock.calls[0]?.[0])).toContain('"readyToApplyAt" = NOW()');
  });

  it("moves a run with any failed item to FAILED", async () => {
    const harness = createHarness({ counts: { total: 2n, available: 1n, failed: 1n, pending: 0n } });
    await expect(harness.service.advance("run-1")).resolves.toEqual({
      status: "FAILED",
      failureCode: "TRANSLATION_ITEM_FAILED",
    });
    expect(sqlText(harness.execute.mock.calls[0]?.[0])).toContain('TRANSLATION_ITEM_FAILED');
  });

  it("leaves incomplete and empty runs processing", async () => {
    const incomplete = createHarness({ counts: { total: 2n, available: 1n, failed: 0n, pending: 1n } });
    const empty = createHarness({ counts: { total: 0n, available: 0n, failed: 0n, pending: 0n } });
    await expect(incomplete.service.advance("run-1")).resolves.toEqual({ status: "PROCESSING" });
    await expect(empty.service.advance("run-2")).resolves.toEqual({ status: "PROCESSING" });
    expect(incomplete.execute).not.toHaveBeenCalled();
    expect(empty.execute).not.toHaveBeenCalled();
  });

  it("can advance inside a caller-owned transaction", async () => {
    const harness = createHarness();
    await harness.service.advance("run-1", harness.transaction);
    expect(harness.database.$transaction).not.toHaveBeenCalled();
  });
});
