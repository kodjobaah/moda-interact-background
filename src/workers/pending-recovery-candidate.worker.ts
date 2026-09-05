import { Worker } from "bullmq";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";

import {
  EVALUATE_PENDING_RECOVERY_JOB,
  PENDING_RECOVERY_CANDIDATE_QUEUE,
  type PendingRecoveryCandidate,
} from "../domain/pending-recovery-candidate.js";
import { connectionRedis } from "../lib/redis.js";
import { observeWorkerJob } from "../observability/worker-metrics.js";
import { pendingRecoveryCandidateService } from "../services/pending-recovery-candidate.service.js";
import { checkoutRecoveryService } from "../services/checkout-recovery.service.js";

const bullMQTelemetry = createBullMQTelemetry({
  serviceName: "moda-recovery-worker",
  enableMetrics: false,
});
const workerMetricDefinition = {
  workerName: "pending-recovery-candidate",
  queueName: PENDING_RECOVERY_CANDIDATE_QUEUE,
  jobNames: [EVALUATE_PENDING_RECOVERY_JOB],
} as const;

export const pendingRecoveryCandidateWorker = new Worker<PendingRecoveryCandidate>(
  PENDING_RECOVERY_CANDIDATE_QUEUE,
  async (job) =>
    observeWorkerJob(workerMetricDefinition, job, async () => {
      switch (job.name) {
        case EVALUATE_PENDING_RECOVERY_JOB:
          try {
            // Materialize the matured candidate into durable recovery state using
            // current Shopify data (ARCH-001-BACKGROUND-004), never the webhook
            // payload embedded in the job.
            await checkoutRecoveryService.materializeMaturedCandidate(job.data);
          } finally {
            // The candidate is no longer pending once it has matured: drop the
            // O(1) candidate lookup indexes regardless of the materialization
            // outcome (created, discarded, or provider error).
            await pendingRecoveryCandidateService.handleCandidateMatured(
              job.data,
              job.id,
            );
          }
          return;
        default:
          throw new Error(`Unknown pending candidate job: ${job.name}`);
      }
    }),
  {
    connection: connectionRedis,
    concurrency: 10,
    telemetry: bullMQTelemetry,
  },
);

pendingRecoveryCandidateWorker.on("completed", (job) => {
  console.log(`Pending recovery candidate job ${job.id} completed`);
});

pendingRecoveryCandidateWorker.on("failed", (job, error) => {
  console.error(`Pending recovery candidate job ${job?.id} failed`, error);
});

pendingRecoveryCandidateWorker.on("error", (error) => {
  console.error("Pending recovery candidate worker error", error);
});
