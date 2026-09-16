import {
  Job,
  Worker,
} from "bullmq";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";

import { connectionRedis } from "../lib/redis.js";
import { observeWorkerJob } from "../observability/worker-metrics.js";
import {
  mapCheckoutCreatedContractInput,
  mapCheckoutUpdatedContractInput,
  mapCartActivityContractInput,
  parseRuntimeShopifyEvent,
} from "../events/shopify-contract-adapter.js";
import { checkoutRecoveryService } from "../services/checkout-recovery.service.js";
import { SHOPIFY_WEBHOOK_QUEUE_CONTRACTS } from "@modainteract/moda-interact-shared/shopify";
import { backgroundRuntimeConfigService } from "../runtime/background-runtime-config.js";
import { bindWorkerConcurrency } from "../runtime/queue-concurrency-controller.js";

const bullMQTelemetry = createBullMQTelemetry({
  serviceName: "moda-shopify-event-worker",
  enableMetrics: false,
});
const workerMetricDefinition = {
  workerName: "checkout",
  queueName: SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_EVENTS.queueName,
  jobNames: [
    SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_EVENTS.jobName,
    SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_UPDATED_EVENTS.jobName,
    SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CART_ACTIVITY_EVENTS.jobName,
  ],
} as const;

export function createCheckoutWorker() {
  const worker = new Worker<unknown>(
    SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_EVENTS.queueName,
    async (job) =>
      observeWorkerJob(workerMetricDefinition, job, async () => {
        const parsedEvent = parseRuntimeShopifyEvent(job.data);

        switch (job.name) {
          case SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_EVENTS.jobName:
            await checkoutRecoveryService.handleCheckoutCreatedContract(
              mapCheckoutCreatedContractInput(parsedEvent),
            );
            return;

          case SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_UPDATED_EVENTS.jobName:
            await checkoutRecoveryService.handleCheckoutUpdatedContract(
              mapCheckoutUpdatedContractInput(parsedEvent),
            );
            return;

          case SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CART_ACTIVITY_EVENTS.jobName:
            await checkoutRecoveryService.handleCartActivityContract(
              mapCartActivityContractInput(parsedEvent),
            );
            return;

          default:
            throw new Error(
              `Unknown checkout job: ${job.name}`,
            );
        }
      }),

    {
      connection: connectionRedis,
      telemetry: bullMQTelemetry,
    },
  );
  bindWorkerConcurrency(worker, backgroundRuntimeConfigService, "checkoutQueueGlobalConcurrency");
  worker.on("completed", (job) => {
    console.log(`Job ${job.id} completed successfully`);
  });
  
  worker.on("failed", (job, error) => {
    console.error(`Job ${job?.id} failed`, error);
  });
  
  worker.on("error", (error) => {
    console.error("Worker error", error);
  });
  
  console.log("Checkout worker started");
  return worker;
}