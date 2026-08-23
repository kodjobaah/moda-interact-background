import {
  Job,
  Worker,
} from "bullmq";

import { connectionRedis } from "../lib/redis.js";
import type { CheckoutCreatedEvent } from "../events/checkout-events.js";
import { checkoutRecoveryService } from "../services/checkout-recovery.service.js";

const checkoutWorker =
  new Worker<CheckoutCreatedEvent>(
    "checkout-events",

    async (job) => {
      switch (job.name) {
        case "checkout-created":
          await checkoutRecoveryService.handleCheckoutCreated(
            job.data,
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
  
  console.log("Order worker started");