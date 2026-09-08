import { describe, expect, it, vi } from "vitest";

import { startBillingReconciliationScheduler } from "../../../src/runtime/billing-scheduler.js";

describe("billing reconciliation scheduler", () => {
  it("does not overlap a slow scan and schedules the next pass after it settles", async () => {
    vi.useFakeTimers();
    try {
      let resolveScan!: () => void;
      const scan = vi.fn(() => new Promise<void>((resolve) => { resolveScan = resolve; }));
      const stop = startBillingReconciliationScheduler(scan, 60_000);

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(scan).toHaveBeenCalledOnce();

      resolveScan();
      await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(60_000);
      expect(scan).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps future scans scheduled after failure and cancels on shutdown", async () => {
    vi.useFakeTimers();
    try {
      const scan = vi.fn()
        .mockRejectedValueOnce(new Error("temporary failure"))
        .mockResolvedValue(undefined);
      const error = vi.fn();
      const stop = startBillingReconciliationScheduler(scan, 60_000, error);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(error).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(scan).toHaveBeenCalledTimes(2);
      stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(scan).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports scheduled failures through the supplied bounded reporter", async () => {
    vi.useFakeTimers();
    try {
      const failure = new Error("provider failure");
      const scan = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
      const reporter = vi.fn();
      const stop = startBillingReconciliationScheduler(scan, 60_000, reporter);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(reporter).toHaveBeenCalledWith(failure);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});