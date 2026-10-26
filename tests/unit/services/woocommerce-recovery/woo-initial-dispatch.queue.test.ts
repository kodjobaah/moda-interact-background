import { describe, expect, it, vi } from "vitest";
import {
  WooInitialDispatchQueue, InvalidWooInitialDispatchJob,
  wooInitialDispatchJobId, parseWooInitialDispatchJob,
  WOO_INITIAL_DISPATCH_JOB,
  type WooInitialDispatchJob, type WooInitialQueuePort,
} from "../../../../src/services/woocommerce-recovery/woo-initial-dispatch.queue.js";

function fixture() {
  const jobs = new Map<string, {
    name: string; id: string; data: WooInitialDispatchJob;
    getState: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn>;
  }>();
  const queue = {
    add: vi.fn(async (name: string, data: WooInitialDispatchJob, options: { jobId: string }) => {
      const stored = { name, data, id: options.jobId,
        getState: vi.fn(async () => "waiting"), retry: vi.fn(async () => {}),
      };
      jobs.set(options.jobId, stored);
      return stored;
    }),
    getJob: vi.fn(async (id: string) => jobs.get(id) ?? null),
    close: vi.fn(async () => {}),
  };
  return { jobs, queue, sender: new WooInitialDispatchQueue(queue as unknown as WooInitialQueuePort) };
}

describe("ARCH-048-BG005 internal Woo first-dispatch queue", () => {
  it("enqueues a deterministic v1 job on the existing candidate queue", async () => {
    const f = fixture();
    await f.sender.initial("recovery1", "attempt1");
    const data = { source: "woocommerce", recoveryId: "recovery1", attemptId: "attempt1" } as const;
    expect(f.queue.add).toHaveBeenCalledExactlyOnceWith(WOO_INITIAL_DISPATCH_JOB, data, {
      jobId: wooInitialDispatchJobId(data),
    });
    const found = f.jobs.get(wooInitialDispatchJobId(data));
    expect(parseWooInitialDispatchJob(found!)).toEqual(data);
  });

  it("deduplicates a waiting attempt and makes a failed attempt retryable", async () => {
    const f = fixture();
    await f.sender.initial("recovery1", "attempt1");
    await f.sender.initial("recovery1", "attempt1");
    expect(f.queue.add).toHaveBeenCalledTimes(1);
    const job = Array.from(f.jobs.values())[0]!;
    job.getState.mockResolvedValue("failed");
    await f.sender.initial("recovery1", "attempt1");
    expect(job.retry).toHaveBeenCalledExactlyOnceWith("failed");
    expect(f.queue.add).toHaveBeenCalledTimes(1);
  });

  it("does not call a successful enqueue failed when the consumer has already removed the job", async () => {
    const f = fixture();
    f.queue.getJob.mockResolvedValue(null);
    await expect(f.sender.initial("recovery1", "attempt1")).resolves.toBeUndefined();
    expect(f.queue.add).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatched job source/id and never accepts an arbitrary attempt", async () => {
    const data = { source: "woocommerce", recoveryId: "recovery1", attemptId: "attempt1" } as const;
    expect(() => parseWooInitialDispatchJob({ name: WOO_INITIAL_DISPATCH_JOB, id: "malicious", data }))
      .toThrow(InvalidWooInitialDispatchJob);
    expect(() => parseWooInitialDispatchJob({ name: WOO_INITIAL_DISPATCH_JOB,
      id: wooInitialDispatchJobId(data), data: { ...data, sequence: 2 } }))
      .toThrow(InvalidWooInitialDispatchJob);
    expect(() => parseWooInitialDispatchJob({ name: WOO_INITIAL_DISPATCH_JOB,
      id: wooInitialDispatchJobId(data), data: { ...data, source: "shopify" } }))
      .toThrow(InvalidWooInitialDispatchJob);
  });

  it("propagates Redis rejection and refuses unconfirmed enqueue", async () => {
    const f = fixture();
    const error = new Error("Redis unavailable");
    f.queue.add.mockRejectedValueOnce(error);
    await expect(f.sender.initial("recovery1", "attempt1")).rejects.toBe(error);
    const noConfirmation = fixture();
    noConfirmation.queue.add.mockImplementation(async () => {});
    await expect(noConfirmation.sender.initial("recovery1", "attempt1"))
      .rejects.toThrow("WOO_INITIAL_ENQUEUE_UNCONFIRMED");
  });
});
