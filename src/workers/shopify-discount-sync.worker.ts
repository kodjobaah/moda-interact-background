import { Worker } from "bullmq";
import { parseShopifyDiscountSyncJob, SHOPIFY_WEBHOOK_QUEUE_CONTRACTS } from "@modainteract/moda-interact-shared/shopify";
import { connectionRedis } from "../lib/redis.js";
import { shopifyDiscountCatalogueService } from "../services/shopify-discount-catalogue.service.js";

export function createShopifyDiscountSyncWorker() {
  return new Worker(
    SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.SHOPIFY_DISCOUNT_SYNC.queueName,
    async (job) => {
      const payload = parseShopifyDiscountSyncJob(job.data);
      const requestedAt = new Date(payload.requestedAt);
      if (Number.isNaN(requestedAt.getTime())) throw new Error("Invalid Shopify discount sync requestedAt");
      await shopifyDiscountCatalogueService.reconcile(payload.shopId, requestedAt);
    },
    { connection: connectionRedis, concurrency: 4 },
  );
}