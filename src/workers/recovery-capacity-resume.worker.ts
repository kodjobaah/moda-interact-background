import { Worker } from "bullmq";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";

import {
  RECOVERY_CAPACITY_RESUME_QUEUE,
  RESUME_CAPACITY_BLOCKED_RECOVERIES_JOB,
  createRecoveryCapacityResumeContinuation,
  type RecoveryCapacityResumeJob,
} from "../domain/recovery-capacity-resume.js";
import { connectionRedis } from "../lib/redis.js";
import prisma from "../lib/db.js";
import { checkoutRecoveryService } from "../services/checkout-recovery.service.js";
import { recoveryCapacityResumeService } from "../services/recovery-capacity-resume.service.js";
import { shopExecutionEligibilityService } from "../services/shop-execution-eligibility.service.js";
import { backgroundRuntimeConfigService } from "../runtime/background-runtime-config.js";
import { bindWorkerConcurrency } from "../runtime/queue-concurrency-controller.js";

const bullMQTelemetry = createBullMQTelemetry({
  serviceName: "moda-recovery-worker",
  enableMetrics: false,
});

export function createRecoveryCapacityResumeWorker() {
  const worker = new Worker<RecoveryCapacityResumeJob>(
  RECOVERY_CAPACITY_RESUME_QUEUE,
  async (job) => {
    if (job.name !== RESUME_CAPACITY_BLOCKED_RECOVERIES_JOB) {
      throw new Error(`Unknown capacity resume job: ${job.name}`);
    }

    const execution = await shopExecutionEligibilityService.evaluate(job.data.shopId);
    if (!execution.allowed) return { kind: "ignored", reason: execution.reason };

    const batchSize = backgroundRuntimeConfigService.current().recoveryResumeBatchSize;
    const recoveries = await findBlockedRecoveries(job.data.shopId, batchSize);
    let attempted = 0;
    let capacityExhausted = false;
    for (const recovery of recoveries) {
      attempted += 1;
      const result = await checkoutRecoveryService.resumeCapacityBlockedRecovery(recovery.id);
      if (result.kind === "capacity-exhausted") {
        capacityExhausted = true;
        break;
      }
      if (result.kind === "ignored" && isLifecycleDenialReason(result.reason)) {
        return { kind: "ignored", reason: result.reason };
      }
    }

    if (!capacityExhausted && attempted === batchSize) {
      const lastRecovery = recoveries[attempted - 1];
      if (lastRecovery) {
        const finalExecution = await shopExecutionEligibilityService.evaluate(job.data.shopId);
        if (!finalExecution.allowed) {
          return { kind: "ignored", reason: finalExecution.reason };
        }
        await recoveryCapacityResumeService.schedule(
          createRecoveryCapacityResumeContinuation(job.data, lastRecovery.id),
        );
      }
    }
    return { kind: "processed", count: attempted };
  },
  {
    connection: connectionRedis,
    telemetry: bullMQTelemetry,
  },
);
  bindWorkerConcurrency(worker, backgroundRuntimeConfigService, "recoveryResumeQueueGlobalConcurrency");

  worker.on("failed", (job, error) => {
  console.error(`Recovery capacity resume job ${job?.id} failed`, error);
  });
  return worker;
}

async function findBlockedRecoveries(shopId: string, batchSize: number) {
  return prisma.checkoutRecovery.findMany({
    where: {
      shopId,
      status: "DETECTED",
      admissionBlockReason: "RECOVERY_CAPACITY_EXHAUSTED",
    },
    orderBy: [{ detectedAt: "asc" }, { id: "asc" }],
    take: batchSize,
    select: { id: true },
  });
}

function isLifecycleDenialReason(reason: string) {
  return [
    "CONTRACT_REQUIRED",
    "SUBSCRIPTION_FROZEN",
    "UNMAPPED_PLAN",
    "SYNC_ERROR",
    "SHOP_UNAVAILABLE",
    "shop-unavailable",
  ].includes(reason);
}
