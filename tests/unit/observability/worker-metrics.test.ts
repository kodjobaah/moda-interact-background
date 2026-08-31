import { beforeEach, describe, expect, it, vi } from "vitest";

const metricMocks = vi.hoisted(() => {
  const operationsAdd = vi.fn();
  const durationRecord = vi.fn();
  const processingAgeRecord = vi.fn();
  const createCounter = vi.fn(() => ({ add: operationsAdd }));
  const createHistogram = vi.fn((name: string) =>
    name.endsWith("processing_age_ms")
      ? { record: processingAgeRecord }
      : { record: durationRecord },
  );
  const getMeter = vi.fn(() => ({ createCounter, createHistogram }));

  return {
    operationsAdd,
    durationRecord,
    processingAgeRecord,
    createCounter,
    createHistogram,
    getMeter,
  };
});

vi.mock("@opentelemetry/api", () => ({
  metrics: {
    getMeter: metricMocks.getMeter,
  },
}));

const { observeWorkerJob } = await import(
  "../../../src/observability/worker-metrics.js"
);

const definition = {
  workerName: "checkout",
  queueName: "checkout-events",
  jobNames: ["checkout-created", "checkout-updated"],
} as const;

function job(overrides: Record<string, unknown> = {}) {
  return {
    name: "checkout-created",
    timestamp: 1_000,
    processedOn: 1_250,
    attemptsStarted: 1,
    attemptsMade: 0,
    ...overrides,
  };
}

describe("background worker operational metrics", () => {
  beforeEach(() => {
    metricMocks.operationsAdd.mockReset();
    metricMocks.durationRecord.mockReset();
    metricMocks.processingAgeRecord.mockReset();
    vi.restoreAllMocks();
  });

  it("creates the bounded instruments once at module scope", () => {
    expect(metricMocks.getMeter).toHaveBeenCalledOnce();
    expect(metricMocks.getMeter).toHaveBeenCalledWith(
      "moda-interact-background.worker",
    );
    expect(metricMocks.createCounter).toHaveBeenCalledOnce();
    expect(metricMocks.createCounter).toHaveBeenCalledWith(
      "moda.background.worker.job.operations",
      {
        description: "Number of background job processing attempts",
        unit: "1",
      },
    );
    expect(metricMocks.createHistogram).toHaveBeenCalledTimes(2);
    expect(metricMocks.createHistogram).toHaveBeenCalledWith(
      "moda.background.worker.job.duration_ms",
      {
        description: "Background job processor execution duration",
        unit: "ms",
      },
    );
    expect(metricMocks.createHistogram).toHaveBeenCalledWith(
      "moda.background.worker.job.processing_age_ms",
      {
        description: "Elapsed time from job creation to processing attempt",
        unit: "ms",
      },
    );
  });

  it("records successful initial-attempt throughput, duration, and age", async () => {
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(20)
      .mockReturnValueOnce(45);
    const result = { processed: true };

    await expect(
      observeWorkerJob(definition, job(), async () => result),
    ).resolves.toBe(result);

    const attributes = {
      "moda.worker.name": "checkout",
      "bullmq.queue.name": "checkout-events",
      "bullmq.job.name": "checkout-created",
      "moda.worker.outcome": "success",
      "moda.worker.attempt": "initial",
    };
    expect(metricMocks.operationsAdd).toHaveBeenCalledWith(1, attributes);
    expect(metricMocks.durationRecord).toHaveBeenCalledWith(25, attributes);
    expect(metricMocks.processingAgeRecord).toHaveBeenCalledWith(
      250,
      attributes,
    );
  });

  it("records retry failure while preserving the original error", async () => {
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(107);
    const failure = new Error("business failure");

    await expect(
      observeWorkerJob(
        definition,
        job({ attemptsStarted: 2, attemptsMade: 1 }),
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);

    expect(metricMocks.operationsAdd).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        "moda.worker.outcome": "failure",
        "moda.worker.attempt": "retry",
      }),
    );
  });

  it("bounds unknown job names and excludes identifiers and payload data", async () => {
    const sensitiveValues = Array.from(
      { length: 50 },
      (_, index) => `customer-${index}@example.com`,
    );

    for (const sensitiveValue of sensitiveValues) {
      await observeWorkerJob(
        definition,
        job({
          name: sensitiveValue,
          id: `job-${sensitiveValue}`,
          data: {
            shopId: `shop-${sensitiveValue}`,
            message: sensitiveValue,
          },
        }),
        async () => undefined,
      );
    }

    expect(metricMocks.operationsAdd).toHaveBeenCalledTimes(50);
    for (const [, attributes] of metricMocks.operationsAdd.mock.calls) {
      expect(attributes).toEqual({
        "moda.worker.name": "checkout",
        "bullmq.queue.name": "checkout-events",
        "bullmq.job.name": "unknown",
        "moda.worker.outcome": "success",
        "moda.worker.attempt": "initial",
      });
      expect(JSON.stringify(attributes)).not.toMatch(/customer|shop-|job-/);
    }
  });

  it("clamps negative processing age to zero", async () => {
    await observeWorkerJob(
      definition,
      job({ timestamp: 2_000, processedOn: 1_500 }),
      async () => undefined,
    );

    expect(metricMocks.processingAgeRecord).toHaveBeenCalledWith(
      0,
      expect.any(Object),
    );
  });

  it("isolates every metric recording failure from job results and errors", async () => {
    metricMocks.operationsAdd.mockImplementation(() => {
      throw new Error("counter unavailable");
    });
    metricMocks.durationRecord.mockImplementation(() => {
      throw new Error("duration unavailable");
    });
    metricMocks.processingAgeRecord.mockImplementation(() => {
      throw new Error("age unavailable");
    });
    const result = { processed: true };

    await expect(
      observeWorkerJob(definition, job(), async () => result),
    ).resolves.toBe(result);
    expect(metricMocks.operationsAdd).toHaveBeenCalledOnce();
    expect(metricMocks.durationRecord).toHaveBeenCalledOnce();
    expect(metricMocks.processingAgeRecord).toHaveBeenCalledOnce();

    const failure = new Error("business failure");
    await expect(
      observeWorkerJob(definition, job(), async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});