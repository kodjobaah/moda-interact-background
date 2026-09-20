import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  processor: undefined as undefined | ((job: { id?: string; data: unknown }) => Promise<unknown>),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  reconcile: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("bullmq", () => ({
  Worker: class {
    constructor(_queue: string, processor: typeof hoisted.processor) {
      hoisted.processor = processor ?? undefined;
    }

    on(event: string, listener: (...args: unknown[]) => void) {
      hoisted.listeners.set(event, listener);
      return this;
    }
  },
}));
vi.mock("@modainteract/moda-interact-shared/logging", () => ({
  createLogger: () => ({ info: hoisted.info, warn: hoisted.warn, error: hoisted.error }),
}));
vi.mock("@modainteract/moda-interact-shared/shopify", () => ({
  SHOPIFY_WEBHOOK_QUEUE_CONTRACTS: {
    SHOPIFY_DISCOUNT_SYNC: { queueName: "shopify-discount-sync" },
  },
  parseShopifyDiscountSyncJob: (data: unknown) => data,
}));
vi.mock("../../../src/lib/redis.js", () => ({ connectionRedis: {} }));
vi.mock("../../../src/runtime/deployment-environment.js", () => ({
  resolveDeploymentEnvironmentName: () => "test",
}));
vi.mock("../../../src/services/shopify-discount-catalogue.service.js", () => ({
  shopifyDiscountCatalogueService: { reconcile: hoisted.reconcile },
}));

import { createShopifyDiscountSyncWorker } from "../../../src/workers/shopify-discount-sync.worker.js";

createShopifyDiscountSyncWorker();

const job = {
  id: "discount-sync-job-1",
  data: {
    schemaVersion: 1,
    shopId: "shop-1",
    shopDomain: "example.myshopify.com",
    reason: "DISCOUNT_WEBHOOK",
    requestedAt: "2026-09-20T07:30:00.000Z",
    deliveryId: "delivery-1",
    webhookTopic: "discounts/update",
  },
};

describe("Shopify discount sync worker logging", () => {
  beforeEach(() => {
    hoisted.reconcile.mockReset();
    hoisted.info.mockReset();
    hoisted.warn.mockReset();
    hoisted.error.mockReset();
  });

  it("logs worker readiness", () => {
    const listener = hoisted.listeners.get("ready");

    expect(listener).toBeTypeOf("function");
    listener?.();

    expect(hoisted.info).toHaveBeenCalledWith("shopify.discount_sync.worker_ready", {
      queueName: "shopify-discount-sync",
      concurrency: 4,
    });
  });

  it("logs bounded worker-level errors", () => {
    const listener = hoisted.listeners.get("error");

    expect(listener).toBeTypeOf("function");
    listener?.(new Error("Redis connection failed"));

    expect(hoisted.error).toHaveBeenCalledWith("shopify.discount_sync.worker_error", {
      queueName: "shopify-discount-sync",
      errorName: "Error",
      errorMessage: "Redis connection failed",
    });
  });

  it("logs receipt and successful completion", async () => {
    hoisted.reconcile.mockResolvedValueOnce("current");

    await expect(hoisted.processor?.(job)).resolves.toBeUndefined();

    expect(hoisted.info).toHaveBeenNthCalledWith(1, "shopify.discount_sync.job_received", expect.objectContaining({
      jobId: "discount-sync-job-1",
      shopId: "shop-1",
      reason: "DISCOUNT_WEBHOOK",
      webhookTopic: "discounts/update",
    }));
    expect(hoisted.info).toHaveBeenNthCalledWith(2, "shopify.discount_sync.completed", expect.objectContaining({
      shopId: "shop-1",
      outcome: "current",
    }));
    expect(hoisted.warn).not.toHaveBeenCalled();
    expect(hoisted.error).not.toHaveBeenCalled();
  });

  it("logs unavailable catalogue outcomes as warnings", async () => {
    hoisted.reconcile.mockResolvedValueOnce("unavailable");

    await expect(hoisted.processor?.(job)).resolves.toBeUndefined();

    expect(hoisted.warn).toHaveBeenCalledWith("shopify.discount_sync.unavailable", expect.objectContaining({
      shopId: "shop-1",
      outcome: "unavailable",
    }));
  });

  it("logs bounded failure details and rethrows for BullMQ retry", async () => {
    const error = new Error("Shopify discount GraphQL returned an invalid response");
    hoisted.reconcile.mockRejectedValueOnce(error);

    await expect(hoisted.processor?.(job)).rejects.toBe(error);

    expect(hoisted.error).toHaveBeenCalledWith("shopify.discount_sync.failed", expect.objectContaining({
      shopId: "shop-1",
      errorName: "Error",
      errorMessage: "Shopify discount GraphQL returned an invalid response",
    }));
  });
});
