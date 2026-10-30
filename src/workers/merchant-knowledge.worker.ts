import { Worker, type Job } from "bullmq";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";
import {
  MERCHANT_KNOWLEDGE_PROCESS_JOB_NAME,
  MERCHANT_KNOWLEDGE_QUEUE_NAME,
  MerchantKnowledgeProcessSourceRevisionJobSchema,
  type MerchantKnowledgeProcessSourceRevisionJob,
} from "@modainteract/moda-interact-shared/merchant-knowledge";

import { connectionRedis } from "../lib/redis.js";
import { observeWorkerJob } from "../observability/worker-metrics.js";

const logger = createLogger({
  serviceName: "moda-merchant-knowledge-worker", environment: resolveDeploymentEnvironmentName(),
});
const bullMQTelemetry = createBullMQTelemetry({
  serviceName: "moda-merchant-knowledge-worker",
  enableMetrics: false,
});

const workerMetricDefinition = {
  workerName: "merchant-knowledge",
  queueName: MERCHANT_KNOWLEDGE_QUEUE_NAME,
  jobNames: [MERCHANT_KNOWLEDGE_PROCESS_JOB_NAME],
} as const;

export interface MerchantKnowledgeJobProcessor {
  processJob(input: MerchantKnowledgeProcessSourceRevisionJob): Promise<void>;
  markTerminalFailure?(input: {
    job: MerchantKnowledgeProcessSourceRevisionJob;
    failureCode: string;
  }): Promise<void>;
}

function failureCodeFrom(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  const bounded = name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 128);
  return bounded || "UnknownError";
}

export function createMerchantKnowledgeWorker(
  processor: MerchantKnowledgeJobProcessor,
): Worker<
  MerchantKnowledgeProcessSourceRevisionJob,
  void,
  typeof MERCHANT_KNOWLEDGE_PROCESS_JOB_NAME
> {
  const worker = new Worker<
    MerchantKnowledgeProcessSourceRevisionJob,
    void,
    typeof MERCHANT_KNOWLEDGE_PROCESS_JOB_NAME
  >(
    MERCHANT_KNOWLEDGE_QUEUE_NAME,
    async (job: Job<MerchantKnowledgeProcessSourceRevisionJob>) =>
      observeWorkerJob(workerMetricDefinition, job, async () => {
        if (job.name !== MERCHANT_KNOWLEDGE_PROCESS_JOB_NAME) {
          throw new Error("Unexpected Merchant Knowledge job name");
        }
        const parsed = MerchantKnowledgeProcessSourceRevisionJobSchema.parse(
          job.data,
        );

        try {
          await processor.processJob(parsed);
        } catch (error) {
          const maxAttempts = job.opts.attempts ?? 1;
          if (
            processor.markTerminalFailure
            && job.attemptsMade + 1 >= maxAttempts
          ) {
            await processor.markTerminalFailure({
              job: parsed,
              failureCode: failureCodeFrom(error),
            });
          }
          throw error;
        }
      }),
    {
      connection: connectionRedis,
      telemetry: bullMQTelemetry,
    },
  );
  worker.on("failed", (job, error) => {
    logger.error("merchant_knowledge.job.failed", {
      jobId: job?.id ?? null,
      shopId: job?.data?.shopId ?? null,
      sourceRevisionId: job?.data?.sourceRevisionId ?? null,
      attempt: job ? job.attemptsMade + 1 : null,
      errorMessage: error instanceof Error ? error.message : String(error),
      error,
    });
  });
  worker.on("error", (error) => {
    logger.error("merchant_knowledge.worker.error", {
      errorMessage: error.message, error,
    });
  });
  return worker;
}