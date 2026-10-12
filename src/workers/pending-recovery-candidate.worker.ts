import { Worker } from "bullmq";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";
import { createLogger } from "@modainteract/moda-interact-shared/logging";

import {
  EVALUATE_PENDING_RECOVERY_JOB,
  PENDING_RECOVERY_CANDIDATE_QUEUE,
  type PendingRecoveryCandidate,
} from "../domain/pending-recovery-candidate.js";
import { connectionRedis } from "../lib/redis.js";
import { observeWorkerJob } from "../observability/worker-metrics.js";
import { pendingRecoveryCandidateService } from "../services/pending-recovery-candidate.service.js";
import { checkoutRecoveryService } from "../services/checkout-recovery.service.js";
import { backgroundRuntimeConfigService } from "../runtime/background-runtime-config.js";
import { bindWorkerConcurrency } from "../runtime/queue-concurrency-controller.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import {
  RECIPIENT_SUPPRESSION_ADMISSION_RETRY_REQUIRED,
  RECIPIENT_SUPPRESSION_RESUME_ENQUEUE_FAILED,
} from "../services/checkout-recovery/recovery-recipient-suppression-admission.service.js";

const bullMQTelemetry = createBullMQTelemetry({
  serviceName: "moda-recovery-worker",
  enableMetrics: false,
});
const workerMetricDefinition = {
  workerName: "pending-recovery-candidate",
  queueName: PENDING_RECOVERY_CANDIDATE_QUEUE,
  jobNames: [EVALUATE_PENDING_RECOVERY_JOB],
} as const;
const logger = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});

export function createPendingRecoveryCandidateWorker() {
  const worker = new Worker<PendingRecoveryCandidate>(
  PENDING_RECOVERY_CANDIDATE_QUEUE,
  async (job) =>
    observeWorkerJob(workerMetricDefinition, job, async () => {
      switch (job.name) {
        case EVALUATE_PENDING_RECOVERY_JOB:
          let materializationFailed = false;
          let materializationError: unknown;
          try {
            // Materialize the matured candidate into durable recovery state using
            // current Shopify data (ARCH-001-BACKGROUND-004), never the webhook
            // payload embedded in the job.
            const result = await checkoutRecoveryService.materializeMaturedCandidate(job.data, {
              ...(typeof job.id === "string" ? { jobId: job.id } : {}),
              retrySuppressionAdmission:
                job.attemptsMade > 0 &&
                isSuppressionResumeEnqueueFailure(job.failedReason),
            });
            if (result.outcome === "deferred-lookup-unavailable") {
              logger.warn("recovery.pending_candidate.lookup_unavailable", {
                jobId: typeof job.id === "string" ? job.id.slice(0, 192) : job.id ?? null,
                outcome: result.outcome,
              });
            }
          } catch (error) {
            materializationFailed = true;
            materializationError = error;
          }
          try {
            // The candidate is no longer pending once it has matured: drop the
            // O(1) candidate lookup indexes regardless of the materialization
            // outcome (created, discarded, or provider error).
            await pendingRecoveryCandidateService.handleCandidateMatured(
              job.data,
              job.id,
            );
          } catch (cleanupError) {
            if (!materializationFailed) throw cleanupError;
            const primaryMessage = materializationError instanceof Error
              ? materializationError.message
              : String(materializationError);
            const cleanupMessage = cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError);
            throw new Error(
              `${primaryMessage}: candidate index cleanup failed: ${cleanupMessage}`,
              { cause: new AggregateError([materializationError, cleanupError], "Materialization and candidate cleanup failed") },
            );
          }
          if (materializationFailed) throw materializationError;
          return;
        default:
          throw new Error(`Unknown pending candidate job: ${job.name}`);
      }
    }),
  {
    connection: connectionRedis,
    telemetry: bullMQTelemetry,
  },
);
  bindWorkerConcurrency(worker, backgroundRuntimeConfigService, "pendingRecoveryQueueGlobalConcurrency");

  worker.on("completed", (job) => {
  console.log(`Pending recovery candidate job ${job.id} completed`);
});

  worker.on("failed", (job, error) => {
  console.error(`Pending recovery candidate job ${job?.id} failed`, error);
});

  worker.on("error", (error) => {
  console.error("Pending recovery candidate worker error", error);
  });
  return worker;
}

function isSuppressionResumeEnqueueFailure(failedReason: string): boolean {
  return isRetryMarker(failedReason, RECIPIENT_SUPPRESSION_RESUME_ENQUEUE_FAILED) ||
    isRetryMarker(failedReason, RECIPIENT_SUPPRESSION_ADMISSION_RETRY_REQUIRED);
}

function isRetryMarker(failedReason: string, marker: string): boolean {
  return failedReason === marker || failedReason.startsWith(`${marker}:`);
}
