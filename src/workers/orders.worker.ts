import { Worker } from "bullmq";
import { connectionRedis } from "../lib/redis.js";


interface OrderCompletedData {
  shop: string;
  orderId: string;
  checkoutToken: string | null;
  customerId: string | null;
  totalPrice: string | null;
  currency: string | null;
}
const worker = new Worker<OrderCompletedData>(
  "order-events",

  async (job) => {
    console.log("Received job", {
      id: job.id,
      name: job.name,
    });

    switch (job.name) {
      case "order-completed":
        await handleOrderCompleted(job.data);
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


async function handleOrderCompleted(data: OrderCompletedData) {
  const {
    shop,
    orderId,
    checkoutToken,
    customerId,
    totalPrice,
    currency,
  } = data;

  console.log("Processing completed order", {
    shop,
    orderId,
    checkoutToken,
    customerId,
    totalPrice,
    currency,
  });

}

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