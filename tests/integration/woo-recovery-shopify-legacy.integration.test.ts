import "dotenv/config";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Queue } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionRedis } from "../../src/lib/redis.js";
import { checkoutRecoveryService } from "../../src/services/checkout-recovery.service.js";
import { pendingRecoveryCandidateService } from "../../src/services/pending-recovery-candidate.service.js";
import { createPendingRecoveryCandidateWorker } from "../../src/workers/pending-recovery-candidate.worker.js";
import { PENDING_RECOVERY_CANDIDATE_QUEUE } from "../../src/domain/pending-recovery-candidate.js";

vi.mock("../../src/runtime/background-runtime-config.js", () => ({
  backgroundRuntimeConfigService: {
    current: () => ({ version: 1, pendingRecoveryQueueGlobalConcurrency: 1 }),
    subscribe: () => () => undefined,
  },
}));
const integrated = process.env.TEST_REDIS_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe : describe.skip;

function awaitJob(worker: EventEmitter, id: string, state: "completed" | "failed") {
  return new Promise<Error | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Shopify legacy worker event timed out")), 20_000);
    worker.on(state, (job, error) => {
      if (job?.id !== id) return;
      clearTimeout(timer);
      resolve(state === "failed" ? error : null);
    });
  });
}

integrated("ARCH-048-BG005 legacy Shopify worker regression on shared queue", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("unmarked Shopify candidate, including Woo-looking checkout keys, keeps its original materialise/cleanup path", async () => {
    const materialize = vi.spyOn(checkoutRecoveryService, "materializeMaturedCandidate")
      .mockResolvedValue({ outcome: "discarded-shop-unavailable" } as never);
    const cleanup = vi.spyOn(pendingRecoveryCandidateService, "handleCandidateMatured")
      .mockImplementation(async (candidate) => candidate);
    const woo = { onCandidateMatured: vi.fn(), onInitialDispatch: vi.fn() };
    const worker = createPendingRecoveryCandidateWorker(woo as never);
    const queue = new Queue(PENDING_RECOVERY_CANDIDATE_QUEUE, { connection: connectionRedis });
    const candidate = { shopId: `shopify-${randomUUID()}`, shopDomain: "shopify.example.test",
      checkoutToken: `woo-checkout-${randomUUID()}` };
    const id = `legacy-${randomUUID()}`;
    try {
      await worker.waitUntilReady();
      const done = awaitJob(worker, id, "completed");
      await queue.add("evaluate-pending-recovery", candidate, { jobId: id, removeOnComplete: false });
      expect(await done).toBeNull();
      expect(materialize).toHaveBeenCalledExactlyOnceWith(candidate, expect.objectContaining({ jobId: id }));
      expect(cleanup).toHaveBeenCalledExactlyOnceWith(candidate, id);
      expect(woo.onCandidateMatured).not.toHaveBeenCalled();
      expect(woo.onInitialDispatch).not.toHaveBeenCalled();
    } finally { await worker.close(); await queue.close(); }
  }, 40_000);

  it("legacy materialiser/cleanup errors still fail the job and preserve both errors", async () => {
    const primary = new Error("Shopify provider lookup rejected");
    const cleanupError = new Error("candidate index cleanup failed");
    vi.spyOn(checkoutRecoveryService, "materializeMaturedCandidate").mockRejectedValue(primary);
    vi.spyOn(pendingRecoveryCandidateService, "handleCandidateMatured").mockRejectedValue(cleanupError);
    const woo = { onCandidateMatured: vi.fn(), onInitialDispatch: vi.fn() };
    const worker = createPendingRecoveryCandidateWorker(woo as never);
    const queue = new Queue(PENDING_RECOVERY_CANDIDATE_QUEUE, { connection: connectionRedis });
    const id = `legacy-${randomUUID()}`;
    try {
      await worker.waitUntilReady();
      const failed = awaitJob(worker, id, "failed");
      await queue.add("evaluate-pending-recovery", {
        shopId: "shopify-test", checkoutToken: "legacy-checkout", shopDomain: "shopify.example.test",
      }, { jobId: id, attempts: 1, removeOnFail: false });
      const error = await failed;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBeInstanceOf(AggregateError);
      expect(((error as Error).cause as AggregateError).errors).toEqual([primary, cleanupError]);
      expect(woo.onCandidateMatured).not.toHaveBeenCalled();
    } finally { await worker.close(); await queue.close(); }
  }, 40_000);
});
