import { beforeEach, describe, expect, it, vi } from "vitest";

const metricMocks = vi.hoisted(() => {
  const queueWaitRecord = vi.fn();
  const transitionAdd = vi.fn();
  const gaugeCallbacks: Array<(result: { observe: (value: number, attributes: Record<string, string>) => void }) => void> = [];
  const createObservableGauge = vi.fn(() => {
    const addCallback = vi.fn((callback) => gaugeCallbacks.push(callback));
    return { addCallback, removeCallback: vi.fn() };
  });
  const getMeter = vi.fn(() => ({
    createObservableGauge,
    createCounter: vi.fn(() => ({ add: transitionAdd })),
    createHistogram: vi.fn(() => ({ record: queueWaitRecord })),
  }));

  return { createObservableGauge, gaugeCallbacks, getMeter, queueWaitRecord, transitionAdd };
});

const bullMQMocks = vi.hoisted(() => {
  const queues: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const controls = {
    queueConstructorCalls: 0,
    queueEventsConstructorCalls: 0,
    throwOnQueueConstructorCall: 0,
    throwOnQueueEventsConstructorCall: 0,
    rejectSampling: false,
  };
  class Queue {
    name: string;
    constructor(name: string) {
      controls.queueConstructorCalls += 1;
      if (controls.queueConstructorCalls === controls.throwOnQueueConstructorCall) {
        throw new Error("queue setup failed");
      }
      this.name = name;
      queues.push(this as unknown as Record<string, unknown>);
    }
    getJobCounts = vi.fn(async () => {
      if (controls.rejectSampling) throw new Error("sampling failed");
      return { waiting: 2, active: 1, delayed: 3, failed: 4 };
    });
    getJobs = vi.fn(async () => [{ timestamp: 1_000, delay: 5_000 }]);
    on = vi.fn((event: string, handler: () => void) => {
      if (event === "error") (this as unknown as { errorHandler: () => void }).errorHandler = handler;
      return this;
    });
    close = vi.fn(async () => undefined);
  }
  class QueueEvents {
    constructor(name: string) {
      controls.queueEventsConstructorCalls += 1;
      if (controls.queueEventsConstructorCalls === controls.throwOnQueueEventsConstructorCall) {
        throw new Error("queue events setup failed");
      }
      events.push(this as unknown as Record<string, unknown>);
      this.name = name;
    }
    name: string;
    on = vi.fn((event: string, handler: () => void) => {
      if (event === "error") (this as unknown as { errorHandler: () => void }).errorHandler = handler;
      return this;
    });
    close = vi.fn(async () => undefined);
  }

  return { Queue, QueueEvents, controls, events, queues };
});

vi.mock("@opentelemetry/api", () => ({ metrics: { getMeter: metricMocks.getMeter } }));
vi.mock("bullmq", () => ({ Queue: bullMQMocks.Queue, QueueEvents: bullMQMocks.QueueEvents }));

const { recordQueueEligibility, recordQueueWait, startQueuePerformanceTelemetry } = await import(
  "../../../src/observability/queue-performance.js"
);

describe("queue performance telemetry", () => {
  beforeEach(() => {
    metricMocks.queueWaitRecord.mockReset();
    metricMocks.transitionAdd.mockReset();
    bullMQMocks.queues.length = 0;
    bullMQMocks.events.length = 0;
    Object.assign(bullMQMocks.controls, {
      queueConstructorCalls: 0,
      queueEventsConstructorCalls: 0,
      throwOnQueueConstructorCall: 0,
      throwOnQueueEventsConstructorCall: 0,
      rejectSampling: false,
    });
  });

  it("measures queue wait from eligibility and clamps early processing", () => {
    recordQueueEligibility("pending-recovery-candidates", "recovery-job", 6_000);
    recordQueueEligibility("checkout-events", "checkout-job", 2_000);
    recordQueueWait("pending-recovery-candidates", {
      id: "recovery-job",
      processedOn: 6_250,
    });
    recordQueueWait("checkout-events", {
      id: "checkout-job",
      processedOn: 1_500,
    });

    expect(metricMocks.queueWaitRecord).toHaveBeenNthCalledWith(
      1,
      250,
      { "bullmq.queue.name": "pending-recovery-candidates" },
    );
    expect(metricMocks.queueWaitRecord).toHaveBeenNthCalledWith(
      2,
      0,
      { "bullmq.queue.name": "checkout-events" },
    );
  });

  it("does not emit a queue-wait sample when eligibility was not observed", () => {
    recordQueueWait("checkout-events", {
      id: "unobserved-job",
      processedOn: 6_250,
    });

    expect(metricMocks.queueWaitRecord).not.toHaveBeenCalled();
  });

  it("uses the latest observed eligibility after a reschedule", () => {
    recordQueueEligibility("pending-recovery-candidates", "rescheduled-job", 1_000);
    recordQueueEligibility("pending-recovery-candidates", "rescheduled-job", 9_000);
    recordQueueWait("pending-recovery-candidates", {
      id: "rescheduled-job",
      processedOn: 9_250,
    });

    expect(metricMocks.queueWaitRecord).toHaveBeenCalledWith(
      250,
      { "bullmq.queue.name": "pending-recovery-candidates" },
    );
  });

  it("creates one bounded observer per queue and closes all resources", async () => {
    const close = startQueuePerformanceTelemetry({
      connection: {} as never,
      queueNames: ["checkout-events", "order-events", "checkout-events"],
      sampleIntervalMs: 60_000,
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(bullMQMocks.queues).toHaveLength(2);
    expect(bullMQMocks.events).toHaveLength(2);
    expect(bullMQMocks.queues[0]?.getJobCounts).toHaveBeenCalledWith(
      "waiting",
      "active",
      "delayed",
      "failed",
    );
    expect(bullMQMocks.queues[0]?.getJobs).toHaveBeenCalledWith(
      "waiting",
      0,
      0,
      true,
    );

    await close();
    expect(bullMQMocks.queues[0]?.close).toHaveBeenCalledOnce();
    expect(bullMQMocks.queues[1]?.close).toHaveBeenCalledOnce();
    expect(bullMQMocks.events[0]?.close).toHaveBeenCalledOnce();
    expect(bullMQMocks.events[1]?.close).toHaveBeenCalledOnce();
  });

  it("does not throw when telemetry resource setup fails", async () => {
    bullMQMocks.controls.throwOnQueueEventsConstructorCall = 1;

    const close = startQueuePerformanceTelemetry({
      connection: {} as never,
      queueNames: ["checkout-events"],
    });

    await expect(close()).resolves.toBeUndefined();
    expect(bullMQMocks.queues[0]?.close).toHaveBeenCalledOnce();
  });

  it("consumes telemetry resource error events safely", async () => {
    const close = startQueuePerformanceTelemetry({
      connection: {} as never,
      queueNames: ["checkout-events"],
    });

    expect(() => (bullMQMocks.queues[0] as { errorHandler: () => void }).errorHandler()).not.toThrow();
    expect(() => (bullMQMocks.events[0] as { errorHandler: () => void }).errorHandler()).not.toThrow();
    await close();
  });

  it("suppresses a stale queue snapshot after sampling fails", async () => {
    const close = startQueuePerformanceTelemetry({
      connection: {} as never,
      queueNames: ["checkout-events"],
      sampleIntervalMs: 1,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const observations: number[] = [];
    metricMocks.gaugeCallbacks[0]?.({ observe: (value) => observations.push(value) });
    expect(observations).toContain(2);

    bullMQMocks.controls.rejectSampling = true;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const refreshedObservations: number[] = [];
    metricMocks.gaugeCallbacks[0]?.({ observe: (value) => refreshedObservations.push(value) });
    expect(refreshedObservations).not.toContain(2);
    await close();
  });
});
