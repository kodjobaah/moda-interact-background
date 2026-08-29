import { Worker } from "bullmq";
import { connectionRedis } from "../lib/redis.js";
import { checkoutRecoveryService } from "../services/checkout-recovery.service.js";
import {
  mapOrderCompletedContractInput,
  parseRuntimeShopifyEvent,
} from "../events/shopify-contract-adapter.js";
import { SHOPIFY_WEBHOOK_QUEUE_CONTRACTS } from "@modainteract/moda-interact-shared/shopify";

const worker = new Worker<unknown>(
  SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.ORDER_EVENTS.queueName,
  async (job) => {
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
  },

  {
    connection: connectionRedis,
    concurrency: 5,
  },
);

worker.on("completed", (job) => {
  console.log(`Job ${job.id} completed successfully`);
});

worker.on("failed", (job, error) => {
  console.error(`Job ${job?.id} failed`, error);
});

worker.on("error", (error) => {
  console.error("Worker error", error);
});

async function shutdown(signal: NodeJS.Signals) {
  console.log(`${signal} received, shutting down worker`);

  await worker.close();
  await connectionRedis.quit();

  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

console.log("Order worker started");