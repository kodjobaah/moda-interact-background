import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import { SHOPIFY_WEBHOOK_QUEUE_CONTRACTS, type ShopifyDiscountSyncJob } from "@modainteract/moda-interact-shared/shopify";
import { createShopifyDiscountSyncJobId } from "@modainteract/moda-interact-shared/shopify/node";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";

import { shopifyDiscountCatalogueService } from "../shopify-discount-catalogue.service.js";

type DiscountQueue = Pick<Queue, "add">;
export type DiscountSyncReason = "SUBSCRIPTION_ACTIVATED" | "REINSTALL_RECONCILED";

export class DiscountSyncPublisherService {
  constructor(
    private readonly database: PrismaClient,
    private readonly discountQueue: DiscountQueue | undefined,
    private readonly logger: StructuredLogger,
    private readonly now: () => Date,
  ) {}

  async publishDiscountSync(shopId: string, reason: DiscountSyncReason): Promise<void> {
    if (!this.discountQueue) return;
    const shop = await this.database.shop.findUnique({ where: { id: shopId }, select: { domain: true } });
    if (!shop) return;
    const requestedAt = this.now();
    const job: ShopifyDiscountSyncJob = {
      schemaVersion: 1,
      shopId,
      shopDomain: shop.domain,
      reason,
      requestedAt: requestedAt.toISOString(),
      deliveryId: null,
      webhookTopic: null,
    };
    try {
      const requestResult = await shopifyDiscountCatalogueService.requestSync(shopId, requestedAt);
      if (requestResult === "unavailable") return;
      await this.discountQueue.add(SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.SHOPIFY_DISCOUNT_SYNC.jobName, job, {
        jobId: createShopifyDiscountSyncJobId({ shopId, reason, requestedAt: job.requestedAt }),
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: true,
        removeOnFail: false,
      });
    } catch (error) {
      this.logger.warn("shopify.discount_sync.enqueue_failed", { shopId, reason, errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure" });
    }
  }
}