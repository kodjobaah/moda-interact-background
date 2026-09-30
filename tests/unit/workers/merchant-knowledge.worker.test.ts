import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  processor: undefined as undefined | ((job: any) => Promise<void>),
  queueName: undefined as string | undefined,
  options: undefined as any,
  observe: vi.fn(async (_definition: unknown, _job: unknown, work: () => Promise<unknown>) => work()),
  telemetry: { name: "telemetry" },
}));

vi.mock("bullmq", () => ({
  Worker: class {
    constructor(queueName: string, processor: typeof hoisted.processor, options: unknown) {
      hoisted.queueName = queueName;
      hoisted.processor = processor ?? undefined;
      hoisted.options = options;
    }
  },
}));
vi.mock("@modainteract/moda-interact-shared/observability/bullmq", () => ({
  createBullMQTelemetry: vi.fn(() => hoisted.telemetry),
}));
vi.mock("../../../src/lib/redis.js", () => ({ connectionRedis: { name: "redis" } }));
vi.mock("../../../src/observability/worker-metrics.js", () => ({
  observeWorkerJob: hoisted.observe,
}));

import { MERCHANT_KNOWLEDGE_PROCESS_JOB_NAME, MERCHANT_KNOWLEDGE_QUEUE_NAME } from "@modainteract/moda-interact-shared/merchant-knowledge";

import { createMerchantKnowledgeWorker, type MerchantKnowledgeJobProcessor } from "../../../src/workers/merchant-knowledge.worker.js";

const payload = {
  schemaVersion: 1,
  shopId: "shop-1",
  sourceRevisionId: "revision-1",
  generation: 4,
  requestedAt: "2026-09-30T10:00:00.000Z",
};

function createJob(overrides: Record<string, unknown> = {}) {
  return {
    name: MERCHANT_KNOWLEDGE_PROCESS_JOB_NAME,
    data: payload,
    attemptsMade: 0,
    opts: { attempts: 3 },
    id: "job-1",
    timestamp: Date.now(),
    processedOn: Date.now(),
    attemptsStarted: 1,
    ...overrides,
  } as any;
}

function createHarness(processor: MerchantKnowledgeJobProcessor) {
  createMerchantKnowledgeWorker(processor);
  return {
    run: (job = createJob()) => hoisted.processor?.(job),
  };
}

describe("Merchant Knowledge worker", () => {
  beforeEach(() => {
    hoisted.processor = undefined;
    hoisted.queueName = undefined;
    hoisted.options = undefined;
    hoisted.observe.mockClear();
  });

  it("uses the dedicated queue, shared Redis connection and BullMQ telemetry", async () => {
    const worker = createHarness({ processJob: vi.fn().mockResolvedValue(undefined) });
    await worker.run();

    expect(hoisted.queueName).toBe(MERCHANT_KNOWLEDGE_QUEUE_NAME);
    expect(hoisted.options).toEqual({
      connection: { name: "redis" },
      telemetry: hoisted.telemetry,
    });
    expect(hoisted.observe).toHaveBeenCalledWith(
      expect.objectContaining({
        workerName: "merchant-knowledge",
        queueName: MERCHANT_KNOWLEDGE_QUEUE_NAME,
        jobNames: [MERCHANT_KNOWLEDGE_PROCESS_JOB_NAME],
      }),
      expect.anything(),
      expect.any(Function),
    );
  });

  it("validates the shared job contract before calling the injected processor", async () => {
    const processJob = vi.fn().mockResolvedValue(undefined);
    const worker = createHarness({ processJob });

    await expect(worker.run()).resolves.toBeUndefined();
    expect(processJob).toHaveBeenCalledWith(payload);
    await expect(worker.run(createJob({ data: { shopId: "invalid" } }))).rejects.toThrow();
    expect(processJob).toHaveBeenCalledOnce();
  });

  it("rejects job names outside the dedicated contract", async () => {
    const processJob = vi.fn().mockResolvedValue(undefined);
    const worker = createHarness({ processJob });

    await expect(worker.run(createJob({ name: "other-job" }))).rejects.toThrow(
      "Unexpected Merchant Knowledge job name",
    );
    expect(processJob).not.toHaveBeenCalled();
  });

  it("marks a final-attempt failure using only a bounded error-name code", async () => {
    const failure = Object.assign(new Error("sensitive source content"), {
      name: "Acquisition Failure / secret",
    });
    const processJob = vi.fn().mockRejectedValue(failure);
    const markTerminalFailure = vi.fn().mockResolvedValue(undefined);
    const worker = createHarness({ processJob, markTerminalFailure });

    await expect(worker.run(createJob({ attemptsMade: 2, opts: { attempts: 3 } }))).rejects.toBe(failure);
    expect(markTerminalFailure).toHaveBeenCalledWith({
      job: payload,
      failureCode: "Acquisition_Failure___secret",
    });
    expect(JSON.stringify(markTerminalFailure.mock.calls)).not.toContain("sensitive source content");
  });

  it("does not mark a retryable failure as terminal", async () => {
    const processJob = vi.fn().mockRejectedValue(new TypeError("retry me"));
    const markTerminalFailure = vi.fn().mockResolvedValue(undefined);
    const worker = createHarness({ processJob, markTerminalFailure });

    await expect(worker.run(createJob({ attemptsMade: 1, opts: { attempts: 3 } }))).rejects.toThrow("retry me");
    expect(markTerminalFailure).not.toHaveBeenCalled();
  });
});