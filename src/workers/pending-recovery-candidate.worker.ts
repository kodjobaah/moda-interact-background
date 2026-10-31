import { createHash } from "node:crypto";
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
import type { WooPendingCandidate } from "../services/woocommerce-recovery/contracts.js";
import type { WooRecoveryOrchestratorService } from "../services/woocommerce-recovery/woo-recovery-orchestrator.service.js";
import { wooCandidateJobId } from "../services/woocommerce-recovery/woo-candidate-queue.service.js";
import {
  WOO_INITIAL_DISPATCH_JOB, parseWooInitialDispatchJob,
  type WooInitialDispatchJob,
} from "../services/woocommerce-recovery/woo-initial-dispatch.queue.js";
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
  jobNames: [EVALUATE_PENDING_RECOVERY_JOB, WOO_INITIAL_DISPATCH_JOB],
} as const;
const logger = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});

type PendingRecoveryJob = PendingRecoveryCandidate | WooPendingCandidate | WooInitialDispatchJob;

function isWooCandidate(value: unknown): value is WooPendingCandidate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.source !== "woocommerce" ||
    typeof candidate.shopId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(candidate.shopId) ||
    typeof candidate.checkoutToken !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(candidate.checkoutToken) ||
    !Number.isSafeInteger(candidate.generation) || Number(candidate.generation) < 1 ||
    typeof candidate.lastEventId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(candidate.lastEventId) ||
    typeof candidate.lastActivityAt !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(candidate.lastActivityAt)) return false;
  const timestamp = Date.parse(candidate.lastActivityAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== candidate.lastActivityAt) return false;
  const basket = candidate.basket;
  return Boolean(basket && typeof basket === "object" &&
    ["nonempty", "empty", "unknown"].includes(String((basket as { kind?: unknown }).kind)));
}

function wooJobFields(job: { id?: string; attemptsMade: number }, stage: string) {
  return { queue: PENDING_RECOVERY_CANDIDATE_QUEUE, source: "woocommerce", stage,
    jobId: typeof job.id === "string" && /^woo-(?:candidate|initial)-[0-9a-f]{64}$/.test(job.id)
      ? job.id : null,
    attempt: job.attemptsMade + 1,
  };
}

/** Woo jobs never enter Shopify materialization or Shopify index cleanup. */
async function processWooJob(
  job: { name: string; id?: string; data: unknown; attemptsMade: number },
  orchestrator: Pick<WooRecoveryOrchestratorService, "onCandidateMatured" | "onInitialDispatch"> | undefined,
): Promise<void> {
  const stage = job.name === WOO_INITIAL_DISPATCH_JOB ? "initial-dispatch" : "candidate-maturity";
  const fields = wooJobFields(job, stage);
  let shopId: string | undefined;
  let eventId: string | undefined;
  try {
    if (!orchestrator) throw new Error("WOO_RECOVERY_ORCHESTRATOR_UNAVAILABLE");
    if (job.name === WOO_INITIAL_DISPATCH_JOB) {
      const initial = parseWooInitialDispatchJob(job);
      logger.info("woocommerce.recovery.job.started", fields);
      const outcome = await orchestrator.onInitialDispatch(initial.recoveryId, initial.attemptId);
      logger.info("woocommerce.recovery.job.completed", { ...fields, outcome: outcome.kind });
      return;
    }
    if (job.name !== EVALUATE_PENDING_RECOVERY_JOB || !job.id ||
      !job.data || typeof job.data !== "object" ||
      (job.data as { source?: unknown }).source !== "woocommerce") {
      throw new Error("WOO_CANDIDATE_SOURCE_INVALID");
    }
    if (!isWooCandidate(job.data)) throw new Error("WOO_CANDIDATE_IDENTITY_INVALID");
    const candidate = job.data;
    shopId = candidate.shopId;
    if (wooCandidateJobId(candidate, candidate.generation) !== job.id) {
      throw new Error("WOO_CANDIDATE_JOB_IDENTITY_INVALID");
    }
    eventId = typeof candidate.lastEventId === "string"
      ? createHash("sha256").update(candidate.lastEventId).digest("hex") : undefined;
    logger.info("woocommerce.recovery.job.started", { ...fields, shopId, ...(eventId ? { eventId } : {}) });
    const outcome = await orchestrator.onCandidateMatured(candidate, { jobId: job.id });
    logger.info("woocommerce.recovery.job.completed", {
      ...fields, shopId, ...(eventId ? { eventId } : {}), outcome: outcome.kind,
    });
  } catch (error) {
    logger.error("woocommerce.recovery.job.failed", {
      ...fields,
      ...(typeof shopId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(shopId) ? { shopId } : {}),
      ...(eventId ? { eventId } : {}),
      reason: "processing_failure",
      errorName: error instanceof Error ? error.name.slice(0, 64) : "UnknownError",
      errorMessage: error instanceof Error ? error.message : String(error),
      error: error,
    });
    throw error;
  }
}

export function createPendingRecoveryCandidateWorker(
  woo?: Pick<WooRecoveryOrchestratorService, "onCandidateMatured" | "onInitialDispatch">,
) {
  const worker = new Worker<PendingRecoveryJob>(
  PENDING_RECOVERY_CANDIDATE_QUEUE,
  async (job) =>
    observeWorkerJob(workerMetricDefinition, job, async () => {
      // An explicit Woo source marker is the *only* maturity discriminator.
      // The missing marker is legacy Shopify; an unknown marker is an error.
      if (job.name === WOO_INITIAL_DISPATCH_JOB) {
        await processWooJob(job, woo);
        return;
      }
      if (job.name === EVALUATE_PENDING_RECOVERY_JOB) {
        const source = job.data && typeof job.data === "object"
          ? (job.data as { source?: unknown }).source : undefined;
        if (source === "woocommerce") {
          await processWooJob(job, woo);
          return;
        }
        if (source !== undefined) {
          logger.error("woocommerce.recovery.job.failed", {
            ...wooJobFields(job, "candidate-routing"), reason: "unknown-source",
          });
          throw new Error("UNKNOWN_RECOVERY_CANDIDATE_SOURCE");
        }
      }
      switch (job.name) {
        case EVALUATE_PENDING_RECOVERY_JOB: {
          const shopifyCandidate = job.data as PendingRecoveryCandidate;
          let materializationFailed = false;
          let materializationError: unknown;
          try {
            // Materialize the matured candidate into durable recovery state using
            // current Shopify data (ARCH-001-BACKGROUND-004), never the webhook
            // payload embedded in the job.
            const result = await checkoutRecoveryService.materializeMaturedCandidate(shopifyCandidate, {
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

          let cleanupFailed = false;
          let cleanupError: unknown;
          try {
            // The candidate is no longer pending once it has matured: drop the
            // O(1) candidate lookup indexes regardless of the materialization
            // outcome (created, discarded, or provider error).
            await pendingRecoveryCandidateService.handleCandidateMatured(
              shopifyCandidate,
              job.id,
            );
          } catch (error) {
            cleanupFailed = true;
            cleanupError = error;
          }

          if (materializationFailed && cleanupFailed) {
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
          if (cleanupFailed) throw cleanupError;
          if (materializationFailed) throw materializationError;
          return;
        }
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

  worker.on("failed", (job, error) => {
    // Job-level failures were already logged inside the Woo processor; this
    // event covers the pre-existing Shopify path without printing job payloads.
    if (job?.name !== EVALUATE_PENDING_RECOVERY_JOB ||
      (job.data as { source?: unknown } | undefined)?.source !== "woocommerce") {
      logger.error("recovery.pending_candidate.job_failed", {
        jobId: job?.id ? createHash("sha256").update(job.id).digest("hex") : null,
        errorName: error.name.slice(0, 64),
        errorMessage: error instanceof Error ? error.message : String(error),
        error: error,
      });
    }
  });
  worker.on("error", (error) => logger.error("recovery.pending_candidate.worker_error", {
    errorName: error.name.slice(0, 64),
    errorMessage: error instanceof Error ? error.message : String(error),
    error: error,
}));
  return worker;
}

function isSuppressionResumeEnqueueFailure(failedReason: string): boolean {
  return isRetryMarker(failedReason, RECIPIENT_SUPPRESSION_RESUME_ENQUEUE_FAILED) ||
    isRetryMarker(failedReason, RECIPIENT_SUPPRESSION_ADMISSION_RETRY_REQUIRED);
}

function isRetryMarker(failedReason: string, marker: string): boolean {
  return failedReason === marker || failedReason.startsWith(`${marker}:`);
}
