import { Queue } from "bullmq";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";

import prisma from "../lib/db.js";
import { connectionRedis } from "../lib/redis.js";
import {
  createRecoveryCapacityResumeJobId,
  RECOVERY_CAPACITY_RESUME_QUEUE,
  RESUME_CAPACITY_BLOCKED_RECOVERIES_JOB,
  type RecoveryCapacityResumeJob,
} from "../domain/recovery-capacity-resume.js";
import { shopExecutionEligibilityService } from "./shop-execution-eligibility.service.js";
import type { BackgroundRuntimeConfigSnapshot } from "../runtime/background-runtime-config.js";

const bullMQTelemetry = createBullMQTelemetry({ serviceName: "moda-recovery-worker" });

let resumeQueue: Queue<RecoveryCapacityResumeJob> | null = null;

function getResumeQueue(): Queue<RecoveryCapacityResumeJob> {
  resumeQueue ??= new Queue(RECOVERY_CAPACITY_RESUME_QUEUE, {
    connection: connectionRedis,
    telemetry: bullMQTelemetry,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  });
  return resumeQueue;
}

export class RecoveryCapacityResumeService {
  async schedule(input: RecoveryCapacityResumeJob): Promise<string> {
    const jobId = createRecoveryCapacityResumeJobId(input);
    await getResumeQueue().add(
      RESUME_CAPACITY_BLOCKED_RECOVERIES_JOB,
      input,
      { jobId },
    );
    return jobId;
  }

  async repair(runtimeConfigOrLimit?: Pick<BackgroundRuntimeConfigSnapshot, "recoveryRepairShopBatchSize"> | number): Promise<number> {
    const limit = typeof runtimeConfigOrLimit === "number"
      ? runtimeConfigOrLimit
      : runtimeConfigOrLimit?.recoveryRepairShopBatchSize ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Recovery repair shop batch size is outside the database range.");
    }
    const shops = await prisma.checkoutRecovery.findMany({
      where: {
        status: "DETECTED",
        admissionBlockReason: "RECOVERY_CAPACITY_EXHAUSTED",
        shop: { status: "ACTIVE" },
      },
      orderBy: [{ shopId: "asc" }, { detectedAt: "asc" }, { id: "asc" }],
      distinct: ["shopId"],
      take: limit,
      select: { shopId: true },
    });

    let scheduled = 0;
    for (const shop of shops) {
      try {
        if (!(await shopExecutionEligibilityService.isShopExecutionActive(shop.shopId))) {
          continue;
        }
        await this.schedule({ shopId: shop.shopId, trigger: "repair" });
        scheduled += 1;
      } catch (error) {
        console.error(`Failed to schedule capacity resume for shop ${shop.shopId}`, error);
      }
    }
    return scheduled;
  }

  async close(): Promise<void> {
    await resumeQueue?.close();
    resumeQueue = null;
  }
}

export const recoveryCapacityResumeService = new RecoveryCapacityResumeService();