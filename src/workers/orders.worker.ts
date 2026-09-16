import { Worker } from "bullmq";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";
import { connectionRedis } from "../lib/redis.js";
import { observeWorkerJob } from "../observability/worker-metrics.js";
import { checkoutRecoveryService } from "../services/checkout-recovery.service.js";
import {
  mapOrderCompletedContractInput,
  parseRuntimeShopifyEvent,
} from "../events/shopify-contract-adapter.js";
import { SHOPIFY_WEBHOOK_QUEUE_CONTRACTS } from "@modainteract/moda-interact-shared/shopify";
import { backgroundRuntimeConfigService } from "../runtime/background-runtime-config.js";
import { bindWorkerConcurrency } from "../runtime/queue-concurrency-controller.js";

const bullMQTelemetry = createBullMQTelemetry({
  serviceName: "moda-shopify-event-worker",
  enableMetrics: false,
});
const workerMetricDefinition = {
  workerName: "order",
  queueName: SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.ORDER_EVENTS.queueName,
  jobNames: [SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.ORDER_EVENTS.jobName],
} as const;

export function createOrderWorker() {
  const worker = new Worker<unknown>(
  SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.ORDER_EVENTS.queueName,
  async (job) =>
    observeWorkerJob(workerMetricDefinition, job, async () => {
      console.log("Received job", {
        id: job.id,
        name: job.name,
      });

      switch (job.name) {
        case SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.ORDER_EVENTS.jobName:
          await checkoutRecoveryService.handleOrderCompletedContract(
            mapOrderCompletedContractInput(parseRuntimeShopifyEvent(job.data)),
          );
          break;

        default:
          throw new Error(`Unknown job type: ${job.name}`);
      }
    }),

  {
    connection: connectionRedis,
    telemetry: bullMQTelemetry,
  },
);
  bindWorkerConcurrency(worker, backgroundRuntimeConfigService, "orderQueueGlobalConcurrency");

  worker.on("completed", (job) => {
  console.log(`Job ${job.id} completed successfully`);
});

  worker.on("failed", (job, error) => {
  console.error(`Job ${job?.id} failed`, error);
});

  worker.on("error", (error) => {
  console.error("Worker error", error);
});

  return worker;
}