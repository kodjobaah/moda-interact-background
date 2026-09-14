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

const MAX_RECOVERIES_PER_JOB = 25;
const bullMQTelemetry = createBullMQTelemetry({
  serviceName: "moda-recovery-worker",
  enableMetrics: false,
});

export const recoveryCapacityResumeWorker = new Worker<RecoveryCapacityResumeJob>(
  RECOVERY_CAPACITY_RESUME_QUEUE,
  async (job) => {
    if (job.name !== RESUME_CAPACITY_BLOCKED_RECOVERIES_JOB) {
      throw new Error(`Unknown capacity resume job: ${job.name}`);
    }

    const execution = await shopExecutionEligibilityService.evaluate(job.data.shopId);
    if (!execution.allowed) return { kind: "ignored", reason: execution.reason };

    const recoveries = await findBlockedRecoveries(job.data.shopId);
    let attempted = 0;
    let capacityExhausted = false;
    for (const recovery of recoveries) {
      attempted += 1;
      const result = await checkoutRecoveryService.resumeCapacityBlockedRecovery(recovery.id);
      if (result.kind === "capacity-exhausted") {
        capacityExhausted = true;
        break;
      }
    }

    if (!capacityExhausted && attempted === MAX_RECOVERIES_PER_JOB) {
      const lastRecovery = recoveries[attempted - 1];
      if (lastRecovery) {
        await recoveryCapacityResumeService.schedule(
          createRecoveryCapacityResumeContinuation(job.data, lastRecovery.id),
        );
      }
    }
    return { kind: "processed", count: attempted };
  },
  {
    connection: connectionRedis,
    concurrency: 10,
    telemetry: bullMQTelemetry,
  },
);

recoveryCapacityResumeWorker.on("failed", (job, error) => {
  console.error(`Recovery capacity resume job ${job?.id} failed`, error);
});

async function findBlockedRecoveries(shopId: string) {
  return prisma.checkoutRecovery.findMany({
    where: {
      shopId,
      status: "DETECTED",
      admissionBlockReason: "RECOVERY_CAPACITY_EXHAUSTED",
    },
    orderBy: [{ detectedAt: "asc" }, { id: "asc" }],
    take: MAX_RECOVERIES_PER_JOB,
    select: { id: true },
  });
}