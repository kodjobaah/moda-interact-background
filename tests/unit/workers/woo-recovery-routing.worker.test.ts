import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  processor: null as null | ((job: any) => Promise<unknown>),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  shopify: vi.fn(async () => ({ outcome: "discarded-shop-unavailable" })),
  shopifyCleanup: vi.fn(async () => undefined),
  wooMature: vi.fn(async () => ({ kind: "created" as const, recoveryId: "recovery1" })),
  wooDispatch: vi.fn(async () => ({ kind: "sent" as const, attemptId: "attempt1" })),
}));
vi.mock("bullmq", () => ({
  Worker: class {
    constructor(_queue: string, processor: (job: any) => Promise<unknown>) { mocked.processor = processor; }
    on() { return this; }
  },
}));
vi.mock("@modainteract/moda-interact-shared/logging", () => ({
  createLogger: () => mocked.logger,
}));
vi.mock("@modainteract/moda-interact-shared/observability/bullmq", () => ({
  createBullMQTelemetry: () => ({}),
}));
vi.mock("../../../src/observability/worker-metrics.js", () => ({
  observeWorkerJob: vi.fn(async (_definition, _job, run) => run()),
}));
vi.mock("../../../src/lib/redis.js", () => ({ connectionRedis: {} }));
vi.mock("../../../src/services/pending-recovery-candidate.service.js", () => ({
  pendingRecoveryCandidateService: { handleCandidateMatured: mocked.shopifyCleanup },
}));
vi.mock("../../../src/services/checkout-recovery.service.js", () => ({
  checkoutRecoveryService: { materializeMaturedCandidate: mocked.shopify },
}));
vi.mock("../../../src/runtime/background-runtime-config.js", () => ({
  backgroundRuntimeConfigService: { current: () => ({ version: 1, pendingRecoveryQueueGlobalConcurrency: 1 }),
    subscribe: () => () => undefined },
}));
vi.mock("../../../src/runtime/queue-concurrency-controller.js", () => ({ bindWorkerConcurrency: vi.fn() }));
vi.mock("../../../src/runtime/deployment-environment.js", () => ({ resolveDeploymentEnvironmentName: () => "test" }));

import { createPendingRecoveryCandidateWorker } from "../../../src/workers/pending-recovery-candidate.worker.js";
import { wooCandidateJobId } from "../../../src/services/woocommerce-recovery/woo-candidate-queue.service.js";
import { wooInitialDispatchJobId, WOO_INITIAL_DISPATCH_JOB } from "../../../src/services/woocommerce-recovery/woo-initial-dispatch.queue.js";

const wooData = { source: "woocommerce", shopId: "woo-shop", checkoutToken: "wc1",
  lastEventId: "evt1", lastActivityAt: "2026-10-25T00:00:00.000Z", basket: { kind: "empty" } } as const;
const job = (data: unknown, name = "evaluate-pending-recovery", id = "shopify-job") => ({
  name, data, id, attemptsMade: 0, failedReason: "",
});
const run = async (data: ReturnType<typeof job>) => {
  if (!mocked.processor) throw new Error("missing worker");
  return mocked.processor(data);
};

describe("ARCH-048-BG005 shared maturity queue source routing", () => {
  beforeEach(() => {
    for (const fn of [mocked.logger.info, mocked.logger.warn, mocked.logger.error,
      mocked.shopify, mocked.shopifyCleanup, mocked.wooMature, mocked.wooDispatch]) fn.mockClear();
    createPendingRecoveryCandidateWorker({ onCandidateMatured: mocked.wooMature,
      onInitialDispatch: mocked.wooDispatch });
  });

  it("leaves unmarked Shopify jobs on the existing materialiser and cleanup", async () => {
    const candidate = { shopId: "shopify-shop", shopDomain: "shop.example", checkoutToken: "woo-looking-token" };
    await run(job(candidate));
    expect(mocked.shopify).toHaveBeenCalledOnce();
    expect(mocked.shopifyCleanup).toHaveBeenCalledOnce();
    expect(mocked.wooMature).not.toHaveBeenCalled();
  });

  it("routes only verified marked Woo jobs to admission, never Shopify", async () => {
    const id = wooCandidateJobId(wooData);
    await run(job(wooData, "evaluate-pending-recovery", id));
    expect(mocked.wooMature).toHaveBeenCalledExactlyOnceWith(wooData, { jobId: id });
    expect(mocked.shopify).not.toHaveBeenCalled();
    expect(mocked.shopifyCleanup).not.toHaveBeenCalled();
    expect(mocked.logger.info).toHaveBeenCalledWith("woocommerce.recovery.job.completed",
      expect.objectContaining({ source: "woocommerce", outcome: "created" }));
  });

  it("rejects unknown source, wrong Woo job identity and missing Woo wiring", async () => {
    await expect(run(job({ ...wooData, source: "shopify" }))).rejects.toThrow("UNKNOWN_RECOVERY_CANDIDATE_SOURCE");
    await expect(run(job(wooData, "evaluate-pending-recovery", "spoofed"))).rejects.toThrow();
    createPendingRecoveryCandidateWorker();
    await expect(run(job(wooData, "evaluate-pending-recovery", wooCandidateJobId(wooData))))
      .rejects.toThrow("WOO_RECOVERY_ORCHESTRATOR_UNAVAILABLE");
    expect(mocked.shopify).not.toHaveBeenCalled();
  });

  it("routes only a verifiable sequence-one initial job to the Woo sender", async () => {
    const data = { source: "woocommerce", recoveryId: "recovery1", attemptId: "attempt1" } as const;
    await run(job(data, WOO_INITIAL_DISPATCH_JOB, wooInitialDispatchJobId(data)));
    expect(mocked.wooDispatch).toHaveBeenCalledExactlyOnceWith("recovery1", "attempt1");
    expect(mocked.shopify).not.toHaveBeenCalled();
    await expect(run(job({ ...data, attemptId: "other" }, WOO_INITIAL_DISPATCH_JOB,
      wooInitialDispatchJobId(data)))).rejects.toThrow();
  });

  it("rethrows service failures without cleanup or a completed event", async () => {
    const failure = new Error("provider error private phone number");
    mocked.wooMature.mockRejectedValueOnce(failure);
    await expect(run(job(wooData, "evaluate-pending-recovery", wooCandidateJobId(wooData))))
      .rejects.toBe(failure);
    expect(mocked.shopifyCleanup).not.toHaveBeenCalled();
    expect(mocked.logger.info).not.toHaveBeenCalledWith("woocommerce.recovery.job.completed", expect.anything());
    expect(mocked.logger.error).toHaveBeenCalledWith("woocommerce.recovery.job.failed", expect.anything());
    expect(mocked.logger.error).toHaveBeenCalledWith("woocommerce.recovery.job.failed", expect.objectContaining({
      errorMessage: "provider error private phone number", error: failure,
    }));
  });
});
