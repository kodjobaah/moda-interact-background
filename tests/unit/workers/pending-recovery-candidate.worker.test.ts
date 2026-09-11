import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  processor: undefined as undefined | ((job: { name: string; data: unknown; id: string }) => Promise<unknown>),
  materialize: vi.fn(async () => ({
    outcome: "discarded-shop-unavailable",
    checkoutToken: "checkout_1",
  })),
  cleanup: vi.fn(async () => undefined),
}));

vi.mock("bullmq", () => ({
  Worker: class {
    constructor(_queue: string, processor: typeof hoisted.processor) {
      hoisted.processor = processor ?? undefined;
    }

    on() {
      return this;
    }
  },
}));
vi.mock("@modainteract/moda-interact-shared/observability/bullmq", () => ({
  createBullMQTelemetry: vi.fn(() => ({})),
}));
vi.mock("../../../src/lib/redis.js", () => ({ connectionRedis: {} }));
vi.mock("../../../src/observability/worker-metrics.js", () => ({
  observeWorkerJob: vi.fn(async (_definition, _job, callback) => callback()),
}));
vi.mock("../../../src/services/checkout-recovery.service.js", () => ({
  checkoutRecoveryService: {
    materializeMaturedCandidate: hoisted.materialize,
  },
}));
vi.mock("../../../src/services/pending-recovery-candidate.service.js", () => ({
  pendingRecoveryCandidateService: {
    handleCandidateMatured: hoisted.cleanup,
  },
}));

import {
  EVALUATE_PENDING_RECOVERY_JOB,
} from "../../../src/domain/pending-recovery-candidate.js";
import "../../../src/workers/pending-recovery-candidate.worker.js";

describe("pending recovery candidate worker", () => {
  it("cleans up an inactive matured candidate in finally", async () => {
    const job = {
      name: EVALUATE_PENDING_RECOVERY_JOB,
      id: "job-1",
      data: { shopId: "shop_1", checkoutToken: "checkout_1" },
    };

    await hoisted.processor?.(job);

    expect(hoisted.materialize).toHaveBeenCalledWith(job.data);
    expect(hoisted.cleanup).toHaveBeenCalledWith(job.data, job.id);
  });
});