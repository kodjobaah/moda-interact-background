import { describe, expect, it, vi } from "vitest";

import { startDynamicLeasedScheduler } from "../../../src/runtime/dynamic-leased-scheduler.js";

function harness() {
  let snapshot: any = { version: 1, interval: 10 };
  const listeners = new Set<(next: any) => void>();
  const config = {
    current: vi.fn(() => snapshot),
    getFresh: vi.fn(async () => snapshot),
    subscribe: vi.fn((listener: (next: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); }),
    change(next: any) { snapshot = next; for (const listener of listeners) listener(next); },
  };
  const lease = { tryAcquire: vi.fn(async () => ({ name: "BILLING_RECONCILIATION", ownerToken: "owner", generation: 1 })) };
  return { config, lease };
}

describe("dynamic leased scheduler", () => {
  it("never overlaps local work and stop is idempotent", async () => {
    vi.useFakeTimers();
    try {
      const { config, lease } = harness();
      let resolveRun!: () => void;
      let active = 0;
      const run = vi.fn(() => { active += 1; return new Promise<void>((resolve) => { resolveRun = () => { active -= 1; resolve(); }; }); });
      const stop = await startDynamicLeasedScheduler({ config: config as any, lease: lease as any, leaseName: "BILLING_RECONCILIATION" as any, intervalMs: 10, runImmediately: true, run });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(run).toHaveBeenCalledOnce();
      expect(active).toBe(1);
      resolveRun();
      await stop();
      await stop();
    } finally { vi.useRealTimers(); }
  });

  it("reschedules waiting work on interval changes and reads fresh config after lease acquisition", async () => {
    vi.useFakeTimers();
    try {
      const { config, lease } = harness();
      const run = vi.fn().mockResolvedValue(undefined);
      const stop = await startDynamicLeasedScheduler({ config: config as any, lease: lease as any, leaseName: "BILLING_RECONCILIATION" as any, intervalMs: 100, getIntervalMs: (value) => value.interval, run });
      config.change({ version: 2, interval: 5 });
      await vi.advanceTimersByTimeAsync(5);
      expect(config.getFresh).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledWith(config.current(), expect.anything());
      await stop();
    } finally { vi.useRealTimers(); }
  });

  it("does not interrupt a running cycle and skips when the lease is unavailable", async () => {
    vi.useFakeTimers();
    try {
      const { config, lease } = harness();
      let resolveRun!: () => void;
      lease.tryAcquire.mockResolvedValueOnce(null).mockResolvedValue({ name: "BILLING_RECONCILIATION", ownerToken: "owner", generation: 1 });
      const run = vi.fn(() => new Promise<void>((resolve) => { resolveRun = resolve; }));
      const stop = await startDynamicLeasedScheduler({ config: config as any, lease: lease as any, leaseName: "BILLING_RECONCILIATION" as any, intervalMs: 10, run });
      await vi.advanceTimersByTimeAsync(10);
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10);
      expect(run).toHaveBeenCalledOnce();
      config.change({ version: 3, interval: 1 });
      expect(run).toHaveBeenCalledOnce();
      resolveRun();
      await stop();
    } finally { vi.useRealTimers(); }
  });

  it("allows only one of two schedulers to execute the shared lease", async () => {
    vi.useFakeTimers();
    try {
      const first = harness();
      const second = harness();
      let acquired = false;
      const acquire = vi.fn(async () => {
        if (acquired) return null;
        acquired = true;
        return { name: "BILLING_RECONCILIATION", ownerToken: "owner", generation: 1 };
      });
      first.lease.tryAcquire = acquire;
      second.lease.tryAcquire = acquire;
      const run = vi.fn().mockResolvedValue(undefined);
      const stopFirst = await startDynamicLeasedScheduler({ config: first.config as any, lease: first.lease as any, leaseName: "BILLING_RECONCILIATION" as any, intervalMs: 10, runImmediately: true, run });
      const stopSecond = await startDynamicLeasedScheduler({ config: second.config as any, lease: second.lease as any, leaseName: "BILLING_RECONCILIATION" as any, intervalMs: 10, runImmediately: true, run });
      await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledOnce();
      await stopFirst();
      await stopSecond();
    } finally { vi.useRealTimers(); }
  });
});