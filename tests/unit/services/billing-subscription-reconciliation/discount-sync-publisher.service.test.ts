import { afterEach, describe, expect, it, vi } from "vitest";
import { createShopifyDiscountSyncJobId } from "@modainteract/moda-interact-shared/shopify/node";

import { DiscountSyncPublisherService } from "../../../../src/services/billing-subscription-reconciliation/discount-sync-publisher.service.js";
import { shopifyDiscountCatalogueService } from "../../../../src/services/shopify-discount-catalogue.service.js";

const requestedAt = new Date("2026-10-03T12:00:00.000Z");

afterEach(() => vi.restoreAllMocks());

function harness({ queue = true, shop = { domain: "merchant.example" } } = {}) {
  const database = { shop: { findUnique: vi.fn().mockResolvedValue(shop) } };
  const discountQueue = queue ? { add: vi.fn().mockResolvedValue({}) } : undefined;
  const logger = { warn: vi.fn() };
  const service = new DiscountSyncPublisherService(
    database as never,
    discountQueue as never,
    logger as never,
    () => requestedAt,
  );
  return { database, discountQueue, logger, service };
}

describe("DiscountSyncPublisherService", () => {
  it("does no lookup or clock read when no discount queue is configured", async () => {
    const test = harness({ queue: false });

    await test.service.publishDiscountSync("shop-1", "SUBSCRIPTION_ACTIVATED");

    expect(test.database.shop.findUnique).not.toHaveBeenCalled();
  });

  it("publishes the canonical deterministic discount-sync job after requesting sync", async () => {
    const test = harness();
    const requestSync = vi.spyOn(shopifyDiscountCatalogueService, "requestSync").mockResolvedValue("requested");

    await test.service.publishDiscountSync("shop-1", "SUBSCRIPTION_ACTIVATED");

    expect(test.database.shop.findUnique).toHaveBeenCalledWith({ where: { id: "shop-1" }, select: { domain: true } });
    expect(requestSync).toHaveBeenCalledWith("shop-1", requestedAt);
    expect(test.discountQueue?.add).toHaveBeenCalledWith(
      expect.any(String),
      {
        schemaVersion: 1,
        shopId: "shop-1",
        shopDomain: "merchant.example",
        reason: "SUBSCRIPTION_ACTIVATED",
        requestedAt: requestedAt.toISOString(),
        deliveryId: null,
        webhookTopic: null,
      },
      {
        jobId: createShopifyDiscountSyncJobId({
          shopId: "shop-1",
          reason: "SUBSCRIPTION_ACTIVATED",
          requestedAt: requestedAt.toISOString(),
        }),
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  });

  it("skips queue publication when catalogue sync is unavailable", async () => {
    const test = harness();
    vi.spyOn(shopifyDiscountCatalogueService, "requestSync").mockResolvedValue("unavailable");

    await test.service.publishDiscountSync("shop-1", "REINSTALL_RECONCILED");

    expect(test.discountQueue?.add).not.toHaveBeenCalled();
  });

  it("isolates catalogue and queue failures with the existing warning", async () => {
    const test = harness();
    vi.spyOn(shopifyDiscountCatalogueService, "requestSync").mockRejectedValue(new Error("catalogue unavailable"));

    await expect(test.service.publishDiscountSync("shop-1", "SUBSCRIPTION_ACTIVATED")).resolves.toBeUndefined();

    expect(test.discountQueue?.add).not.toHaveBeenCalled();
    expect(test.logger.warn).toHaveBeenCalledWith("shopify.discount_sync.enqueue_failed", {
      shopId: "shop-1",
      reason: "SUBSCRIPTION_ACTIVATED",
      errorMessage: "catalogue unavailable",
    });
  });
});