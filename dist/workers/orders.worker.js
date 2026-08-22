import { Worker } from "bullmq";
import { Redis } from "ioredis";
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
    throw new Error("REDIS_URL environment variable is required");
}
const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
});
const worker = new Worker("order-events", async (job) => {
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
}, {
    connection,
    concurrency: 5,
});
async function handleOrderCompleted(data) {
    const { shop, orderId, checkoutToken, customerId, totalPrice, currency, } = data;
    console.log("Processing completed order", {
        shop,
        orderId,
        checkoutToken,
        customerId,
        totalPrice,
        currency,
    });
    // Later:
    //
    // 1. Find the corresponding abandoned checkout
    // 2. Mark it RECOVERED
    // 3. Cancel outstanding WhatsApp jobs
    // 4. Record recovered revenue
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
async function shutdown(signal) {
    console.log(`${signal} received, shutting down worker`);
    await worker.close();
    await connection.quit();
    process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
console.log("Order worker started");
//# sourceMappingURL=orders.worker.js.map