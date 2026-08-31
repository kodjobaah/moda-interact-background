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

const bullMQTelemetry = createBullMQTelemetry({
  serviceName: "moda-shopify-event-worker",
  enableMetrics: false,
});
const workerMetricDefinition = {
  workerName: "order",
  queueName: SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.ORDER_EVENTS.queueName,
  jobNames: [SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.ORDER_EVENTS.jobName],
} as const;

export const orderWorker = new Worker<unknown>(
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
    concurrency: 5,
    telemetry: bullMQTelemetry,
  },
);

orderWorker.on("completed", (job) => {
  console.log(`Job ${job.id} completed successfully`);
});

orderWorker.on("failed", (job, error) => {
  console.error(`Job ${job?.id} failed`, error);
});

orderWorker.on("error", (error) => {
  console.error("Worker error", error);
});

console.log("Order worker started");