import { beforeEach, describe, expect, it, vi } from "vitest";
import { SHOPIFY_WEBHOOK_QUEUE_CONTRACTS } from "@modainteract/moda-interact-shared/shopify";

const mock = vi.hoisted(() => ({
  processor: undefined as undefined | ((job: { name: string; data: unknown }) => Promise<unknown>),
  queueName: "",
  metrics: undefined as undefined | { jobNames: readonly string[] },
  createTelemetry: vi.fn(() => ({})),
  created: vi.fn(), updated: vi.fn(), cart: vi.fn(), sync: vi.fn(),
  bindConcurrency: vi.fn(), info: vi.fn(), warn: vi.fn(),
}));

vi.mock("bullmq", () => ({
  Worker: class {
    constructor(queue: string, processor: typeof mock.processor) {
      mock.queueName = queue;
      mock.processor = processor;
    }
    on() { return this; }
  },
}));
vi.mock("@modainteract/moda-interact-shared/observability/bullmq", () => ({
  createBullMQTelemetry: mock.createTelemetry,
}));
vi.mock("@modainteract/moda-interact-shared/logging", () => ({
  createLogger: () => ({ info: mock.info, warn: mock.warn }),
}));
vi.mock("../../../src/lib/redis.js", () => ({ connectionRedis: {} }));
vi.mock("../../../src/observability/worker-metrics.js", () => ({
  observeWorkerJob: (definition: { jobNames: readonly string[] }, _job: unknown, fn: () => Promise<unknown>) => {
    mock.metrics = definition;
    return fn();
  },
}));
vi.mock("../../../src/services/checkout-recovery.service.js", () => ({
  checkoutRecoveryService: {
    handleCheckoutCreatedContract: mock.created,
    handleCheckoutUpdatedContract: mock.updated,
    handleCartActivityContract: mock.cart,
  },
}));
vi.mock("../../../src/services/shopify-whatsapp-consent.service.js", () => ({
  ShopifyWhatsAppConsentService: class {
    syncCustomer = mock.sync;
  },
}));
vi.mock("../../../src/runtime/background-runtime-config.js", () => ({ backgroundRuntimeConfigService: {} }));
vi.mock("../../../src/runtime/queue-concurrency-controller.js", () => ({ bindWorkerConcurrency: mock.bindConcurrency }));
vi.mock("../../../src/runtime/deployment-environment.js", () => ({
  resolveDeploymentEnvironmentName: () => "test",
}));

import { createCheckoutWorker } from "../../../src/workers/checkout.worker.js";

const consent = { schemaVersion: 1, shopId: "shop-a", shopifyCustomerId: "12345",
  deliveryId: "delivery-1", triggeredAt: "2026-10-23T10:00:00.000Z" };

beforeEach(() => {
  mock.created.mockReset(); mock.updated.mockReset(); mock.cart.mockReset(); mock.sync.mockReset();
  mock.info.mockReset(); mock.warn.mockReset();
  mock.metrics = undefined;
  mock.bindConcurrency.mockClear();
  createCheckoutWorker();
});

describe("live checkout worker consent dispatch", () => {
  it("consumes the existing checkout-events queue and declares the Shared consent job metric name", () => {
    expect(mock.queueName).toBe(SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.WHATSAPP_CONSENT_SYNC.queueName);
    expect(mock.metrics).toBeUndefined();
    expect(mock.bindConcurrency).toHaveBeenCalled();
  });

  it("routes the validated consent job through native refresh and never checkout materialisation", async () => {
    mock.sync.mockResolvedValueOnce({ status: "UPDATED", customerPhoneId: "phone-a" });
    await expect(mock.processor?.({ name: SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.WHATSAPP_CONSENT_SYNC.jobName,
      data: consent })).resolves.toBeUndefined();
    expect(mock.metrics?.jobNames).toContain(SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.WHATSAPP_CONSENT_SYNC.jobName);
    expect(mock.sync).toHaveBeenCalledExactlyOnceWith({ shopId: "shop-a", shopifyCustomerId: "12345" });
    expect(mock.created).not.toHaveBeenCalled();
    expect(mock.updated).not.toHaveBeenCalled();
    expect(mock.cart).not.toHaveBeenCalled();
  });

  it("retains BullMQ retry behaviour for provider unavailability", async () => {
    mock.sync.mockResolvedValueOnce({ status: "UNAVAILABLE", reason: "SHOPIFY_TIMEOUT" });
    await expect(mock.processor?.({ name: SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.WHATSAPP_CONSENT_SYNC.jobName,
      data: consent })).rejects.toThrow("SHOPIFY_TIMEOUT");
    expect(mock.created).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed sync signal without invoking checkout parsers or recovery", async () => {
    await expect(mock.processor?.({ name: SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.WHATSAPP_CONSENT_SYNC.jobName,
      data: { ...consent, schemaVersion: 999 } })).rejects.toThrow("Invalid Shopify WhatsApp consent-sync job schema");
    expect(mock.sync).not.toHaveBeenCalled();
    expect(mock.created).not.toHaveBeenCalled();
  });
});
