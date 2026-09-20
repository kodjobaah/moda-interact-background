import { Worker } from "bullmq";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { parseShopifyDiscountSyncJob, SHOPIFY_WEBHOOK_QUEUE_CONTRACTS } from "@modainteract/moda-interact-shared/shopify";
import { connectionRedis } from "../lib/redis.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import { shopifyDiscountCatalogueService } from "../services/shopify-discount-catalogue.service.js";

const logger = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});

export function createShopifyDiscountSyncWorker() {
  const worker = new Worker(
    SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.SHOPIFY_DISCOUNT_SYNC.queueName,
    async (job) => {
      const payload = parseShopifyDiscountSyncJob(job.data);
      const requestedAt = new Date(payload.requestedAt);
      if (Number.isNaN(requestedAt.getTime())) throw new Error("Invalid Shopify discount sync requestedAt");

      const fields = {
        jobId: typeof job.id === "string" ? job.id.slice(0, 192) : job.id ?? null,
        shopId: payload.shopId,
        reason: payload.reason,
        requestedAt: payload.requestedAt,
        webhookTopic: payload.webhookTopic,
      };

      logger.info("shopify.discount_sync.job_received", fields);

      try {
        const outcome = await shopifyDiscountCatalogueService.reconcile(payload.shopId, requestedAt);
        if (outcome === "current") {
          logger.info("shopify.discount_sync.completed", { ...fields, outcome });
        } else if (outcome === "unavailable") {
          logger.warn("shopify.discount_sync.unavailable", { ...fields, outcome });
        } else if (outcome === "superseded") {
          logger.info("shopify.discount_sync.superseded", { ...fields, outcome });
        } else {
          logger.error("shopify.discount_sync.failed", { ...fields, outcome });
        }
      } catch (error) {
        logger.error("shopify.discount_sync.failed", {
          ...fields,
          ...boundedError(error),
        });
        throw error;
      }
    },
    { connection: connectionRedis, concurrency: 4 },
  );

  worker.on("ready", () => {
    logger.info("shopify.discount_sync.worker_ready", {
      queueName: SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.SHOPIFY_DISCOUNT_SYNC.queueName,
      concurrency: 4,
    });
  });

  worker.on("error", (error) => {
    logger.error("shopify.discount_sync.worker_error", {
      queueName: SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.SHOPIFY_DISCOUNT_SYNC.queueName,
      ...boundedError(error),
    });
  });

  return worker;
}

function boundedError(error: unknown): { errorName: string; errorMessage: string } {
  if (error instanceof Error) {
    return {
      errorName: error.name.slice(0, 64),
      errorMessage: error.message.slice(0, 256),
    };
  }

  return {
    errorName: "UnknownError",
    errorMessage: String(error).slice(0, 256),
  };
}
