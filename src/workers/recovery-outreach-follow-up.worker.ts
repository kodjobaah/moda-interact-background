import { Worker } from "bullmq";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";
import { RECOVERY_OUTREACH_FOLLOW_UP_JOB, RECOVERY_OUTREACH_FOLLOW_UP_QUEUE, type RecoveryOutreachFollowUpJob } from "../domain/recovery-outreach-follow-up.js";
import { connectionRedis } from "../lib/redis.js";
import { checkoutRecoveryService } from "../services/checkout-recovery.service.js";
import { backgroundRuntimeConfigService } from "../runtime/background-runtime-config.js";
import { bindWorkerConcurrency } from "../runtime/queue-concurrency-controller.js";

const telemetry = createBullMQTelemetry({ serviceName: "moda-recovery-worker", enableMetrics: false });

export function createRecoveryOutreachFollowUpWorker() {
  const worker = new Worker<RecoveryOutreachFollowUpJob>(
    RECOVERY_OUTREACH_FOLLOW_UP_QUEUE,
    async (job) => {
      if (job.name !== RECOVERY_OUTREACH_FOLLOW_UP_JOB) throw new Error(`Unknown recovery follow-up job: ${job.name}`);
      return checkoutRecoveryService.processRecoveryOutreachFollowUp(job.data.checkoutRecoveryId);
    },
    { connection: connectionRedis, telemetry },
  );
  bindWorkerConcurrency(worker, backgroundRuntimeConfigService, "pendingRecoveryQueueGlobalConcurrency");
  worker.on("failed", (job, error) => console.error(`Recovery follow-up job ${job?.id} failed`, error));
  return worker;
}