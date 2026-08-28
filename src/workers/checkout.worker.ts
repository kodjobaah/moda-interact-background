import {
  Job,
  Worker,
} from "bullmq";

import { connectionRedis } from "../lib/redis.js";
import {
  mapCheckoutCreatedContractInput,
  mapCheckoutUpdatedContractInput,
  parseRuntimeShopifyEvent,
} from "../events/shopify-contract-adapter.js";
import { checkoutRecoveryService } from "../services/checkout-recovery.service.js";

const checkoutWorker =
  new Worker<unknown>(
    "checkout-events",

    async (job) => {
      const parsedEvent = parseRuntimeShopifyEvent(job.data);

      switch (job.name) {
        case "checkout-created":
          await checkoutRecoveryService.handleCheckoutCreatedContract(
            mapCheckoutCreatedContractInput(parsedEvent),
          );
          return;

        case "checkout-updated":
          await checkoutRecoveryService.handleCheckoutUpdatedContract(
            mapCheckoutUpdatedContractInput(parsedEvent),
          );
          return;

        default:
          throw new Error(
            `Unknown checkout job: ${job.name}`,
          );
      }
    },

    {
      connection: connectionRedis,
      concurrency: 10,
    },
  );

  checkoutWorker.on("completed", (job) => {
    console.log(`Job ${job.id} completed successfully`);
  });
  
  checkoutWorker.on("failed", (job, error) => {
    console.error(`Job ${job?.id} failed`, error);
  });
  
  checkoutWorker.on("error", (error) => {
    console.error("Worker error", error);
  });
  
  async function shutdown(signal: NodeJS.Signals) {
    console.log(`${signal} received, shutting down worker`);
  
    await checkoutWorker.close();
    await connectionRedis.quit();
  
    process.exit(0);
  }
  
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  
  console.log("Checkout worker started");