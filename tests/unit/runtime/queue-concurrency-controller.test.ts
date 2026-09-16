import { describe, expect, it, vi } from "vitest";

import {
  CONTROLLED_QUEUE_DEFINITIONS,
  bindWorkerConcurrency,
  startQueueConcurrencyController,
} from "../../../src/runtime/queue-concurrency-controller.js";

function configSnapshot(version = 1) {
  return {
    version,
    checkoutQueueGlobalConcurrency: 11,
    orderQueueGlobalConcurrency: 12,
    pendingRecoveryQueueGlobalConcurrency: 13,
    recoveryResumeQueueGlobalConcurrency: 14,
    whatsappQueueGlobalConcurrency: 15,
    merchantCommunicationsQueueGlobalConcurrency: 16,
    billingSubscriptionQueueGlobalConcurrency: 17,
  };
}

function harness() {
  let snapshot = configSnapshot();
  const listeners = new Set<(next: typeof snapshot) => void>();
  const config = {
    current: vi.fn(() => snapshot),
    getFresh: vi.fn(async () => snapshot),
    subscribe: vi.fn((listener: (next: typeof snapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    publish(next: typeof snapshot) {
      snapshot = next;
      for (const listener of listeners) listener(next);
    },
  };
  const events: string[] = [];
  const lease = {
    runWithLease: vi.fn(async (_name: string, work: () => Promise<void>) => {
      events.push("lease");
      return { kind: "completed" as const, value: await work({}), leaseLost: false };
    }),
  };
  const values = CONTROLLED_QUEUE_DEFINITIONS.map(() => undefined as number | undefined);
  const queues = values.map((_value, index) => ({
    setGlobalConcurrency: vi.fn(async (value: number) => {
      events.push(`set:${index}`);
      values[index] = value;
    }),
    getGlobalConcurrency: vi.fn(async () => values[index]),
    close: vi.fn(async () => undefined),
  }));
  return { config, lease, queues, values, events };
}

describe("queue concurrency controller", () => {
  it("maps every field in deterministic order and verifies each Redis value", async () => {
    const { config, lease, queues, values, events } = harness();
    const stop = await startQueueConcurrencyController({ config: config as any, lease: lease as any, queues });

    expect(events[0]).toBe("lease");
    expect(events.slice(1)).toEqual(CONTROLLED_QUEUE_DEFINITIONS.map((_, index) => `set:${index}`));
    expect(values).toEqual([11, 12, 13, 14, 13, 15, 16, 17]);
    expect(queues.every((queue) => queue.getGlobalConcurrency.mock.calls.length === 1)).toBe(true);
    await stop();
  });

  it("reads fresh configuration after lease acquisition and heals a failed run", async () => {
    vi.useFakeTimers();
    try {
      const { config, lease, queues } = harness();
      const order: string[] = [];
      lease.runWithLease.mockImplementationOnce(async (_name, work) => {
        order.push("lease");
        const result = await work({});
        return { kind: "completed", value: result, leaseLost: false };
      });
      config.getFresh.mockImplementationOnce(async () => {
        order.push("fresh");
        return config.current();
      });
      queues[0].setGlobalConcurrency.mockRejectedValueOnce(new Error("redis"));
      const stop = await startQueueConcurrencyController({ config: config as any, lease: lease as any, queues, log: { error: vi.fn() } as any });
      expect(order).toEqual(["lease", "fresh"]);
      queues[0].setGlobalConcurrency.mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(queues[0].setGlobalConcurrency).toHaveBeenCalledTimes(2);
      await stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows only the lease winner to write and responds to newer versions", async () => {
    const first = harness();
    const second = harness();
    let acquired = false;
    const run = vi.fn(async (_name: string, work: () => Promise<void>) => {
      if (acquired) return { kind: "skipped" as const };
      acquired = true;
      return { kind: "completed" as const, value: await work({}), leaseLost: false };
    });
    first.lease.runWithLease = run;
    second.lease.runWithLease = run;
    const stopFirst = await startQueueConcurrencyController({ config: first.config as any, lease: first.lease as any, queues: first.queues });
    const stopSecond = await startQueueConcurrencyController({ config: second.config as any, lease: second.lease as any, queues: second.queues });
    expect(first.queues[0].setGlobalConcurrency).toHaveBeenCalledOnce();
    expect(second.queues[0].setGlobalConcurrency).not.toHaveBeenCalled();
    first.config.publish({ ...configSnapshot(0), checkoutQueueGlobalConcurrency: 99 });
    await Promise.resolve();
    await Promise.resolve();
    expect(first.queues[0].setGlobalConcurrency).toHaveBeenCalledWith(11);
    await stopFirst();
    await stopSecond();
  });

  it("updates local worker concurrency only for strictly newer versions", () => {
    const snapshot = configSnapshot();
    const listeners = new Set<(next: typeof snapshot) => void>();
    const config = {
      current: () => snapshot,
      subscribe: (listener: (next: typeof snapshot) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const worker = {} as { concurrency?: number };
    bindWorkerConcurrency(worker as any, config as any, "whatsappQueueGlobalConcurrency");
    expect(worker.concurrency).toBe(15);
    for (const version of [1, 0]) listeners.forEach((listener) => listener({ ...snapshot, version, whatsappQueueGlobalConcurrency: 3 }));
    expect(worker.concurrency).toBe(15);
    listeners.forEach((listener) => listener({ ...snapshot, version: 2, whatsappQueueGlobalConcurrency: 30 }));
    expect(worker.concurrency).toBe(30);
  });
});