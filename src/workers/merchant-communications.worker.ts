import { Worker, type Job } from "bullmq";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";

import {
  MERCHANT_COMMUNICATIONS_JOB_NAMES,
  MERCHANT_COMMUNICATIONS_QUEUE_NAME,
} from "../domain/translation-batch.js";
import { connectionRedis } from "../lib/redis.js";
import { observeWorkerJob } from "../observability/worker-metrics.js";
import { handleTranslationDispatch } from "./translation-dispatch.worker.js";
import { handleTranslationBatchSubmit } from "./translation-batch-submit.worker.js";
import { handleTranslationBatchPoll } from "./translation-batch-poll.worker.js";
import { handleTranslationBatchResults } from "./translation-batch-results.worker.js";
import { handleTranslationReconcile } from "./translation-reconcile.worker.js";

const jobNames = Object.values(MERCHANT_COMMUNICATIONS_JOB_NAMES);
const bullMQTelemetry = createBullMQTelemetry({
  serviceName: "moda-merchant-communications-worker",
  enableMetrics: false,
});

export const merchantCommunicationsWorker = new Worker(
  MERCHANT_COMMUNICATIONS_QUEUE_NAME,
  async (job: Job) => observeWorkerJob(
    {
      workerName: "merchant-communications",
      queueName: MERCHANT_COMMUNICATIONS_QUEUE_NAME,
      jobNames,
    },
    job,
    async () => {
      switch (job.name) {
        case MERCHANT_COMMUNICATIONS_JOB_NAMES.TRANSLATION_DISPATCH:
          return handleTranslationDispatch(job.data);
        case MERCHANT_COMMUNICATIONS_JOB_NAMES.TRANSLATION_BATCH_SUBMIT:
          return handleTranslationBatchSubmit(job.data);
        case MERCHANT_COMMUNICATIONS_JOB_NAMES.TRANSLATION_BATCH_POLL:
          return handleTranslationBatchPoll(job.data);
        case MERCHANT_COMMUNICATIONS_JOB_NAMES.TRANSLATION_BATCH_RESULTS:
          return handleTranslationBatchResults(job.data);
        case MERCHANT_COMMUNICATIONS_JOB_NAMES.TRANSLATION_RECONCILE:
          return handleTranslationReconcile(job.data);
        default:
          throw new Error(`Unknown merchant communications job: ${job.name}`);
      }
    },
  ),
  {
    connection: connectionRedis,
    concurrency: 10,
    telemetry: bullMQTelemetry,
  },
);

merchantCommunicationsWorker.on("failed", (job, error) => {
  console.error(`Merchant communications job ${job?.id} failed`, error);
});

merchantCommunicationsWorker.on("error", (error) => {
  console.error("Merchant communications worker error", error);
});