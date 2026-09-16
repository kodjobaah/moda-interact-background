import { Worker } from "bullmq";
import { parseShopifyDiscountSyncJob, SHOPIFY_WEBHOOK_QUEUE_CONTRACTS } from "@modainteract/moda-interact-shared/shopify";
import { connectionRedis } from "../lib/redis.js";
import { shopifyDiscountCatalogueService } from "../services/shopify-discount-catalogue.service.js";

export function createShopifyDiscountSyncWorker() {
  return new Worker(
    SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.SHOPIFY_DISCOUNT_SYNC.queueName,
    async (job) => {
      const payload = parseShopifyDiscountSyncJob(job.data);
      await shopifyDiscountCatalogueService.reconcile(payload.shopId);
    },
    { connection: connectionRedis, concurrency: 4 },
  );
}