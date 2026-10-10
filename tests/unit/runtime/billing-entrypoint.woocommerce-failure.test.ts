import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const events: string[] = [];
  return {
    events,
    logger: {
      info: vi.fn((event: string) => events.push(event)),
      error: vi.fn((event: string) => events.push(event)),
    },
    reconcileBatch: vi.fn(),
  };
});

vi.mock("@modainteract/moda-interact-shared/logging", () => ({
  createLogger: () => mocks.logger,
}));
vi.mock("../../../src/runtime/deployment-environment.js", () => ({
  resolveDeploymentEnvironmentName: () => "test",
}));
vi.mock("../../../src/runtime/observability.js", () => ({ closeWorkerObservability: vi.fn() }));
vi.mock("../../../src/runtime/dynamic-leased-scheduler.js", () => ({ startDynamicLeasedScheduler: vi.fn() }));
vi.mock("../../../src/runtime/background-runtime-config.js", () => ({
  backgroundRuntimeConfigService: { start: vi.fn(), current: vi.fn(), close: vi.fn() },
}));
vi.mock("../../../src/runtime/background-runtime-lease.js", () => ({ backgroundRuntimeLeaseService: {} }));
vi.mock("../../../src/runtime/readiness.js", () => ({
  startReadyWorkerProcess: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../../src/lib/redis.js", () => ({ connectionRedis: {} }));
vi.mock("../../../src/observability/queue-performance.js", () => ({
  startQueuePerformanceTelemetry: vi.fn(),
}));
vi.mock("../../../src/runtime/queue-concurrency-controller.js", () => ({
  startQueueConcurrencyController: vi.fn(),
}));
vi.mock("../../../src/services/woocommerce-billing/subscription-receipt-reconciliation.service.js", () => ({
  wooSubscriptionReceiptReconciliationService: { reconcileBatch: mocks.reconcileBatch },
}));

import { reconcileWooReceiptsAndGlobalBillingScan } from "../../../src/entrypoints/billing.js";

describe("billing entrypoint Woo receipt failure boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
  });

  it("logs a rejected Woo batch and still invokes one global scan without a Woo success signal", async () => {
    const runtimeConfig = {
      version: 7,
      billingReconciliationShopBatchSize: 25,
    } as never;
    const leaseHandle = { generation: 12 };
    const failure = new Error("w".repeat(300));
    failure.name = "Woo".repeat(30);
    const globalScan = vi.fn(async () => {
      mocks.events.push("global-scan");
      return { subscriptionsScanned: 3 };
    });
    mocks.reconcileBatch.mockRejectedValueOnce(failure);

    await expect(reconcileWooReceiptsAndGlobalBillingScan(runtimeConfig, leaseHandle, globalScan))
      .resolves.toEqual({ subscriptionsScanned: 3 });

    expect(mocks.logger.error).toHaveBeenCalledWith("billing.woocommerce.subscription_receipts.failed", {
      leaseGeneration: 12,
      configVersion: 7,
      errorName: "Woo".repeat(30).slice(0, 64),
      errorMessage: "w".repeat(256),
    });
    expect(mocks.logger.info).not.toHaveBeenCalledWith(
      "billing.woocommerce.subscription_receipts.completed",
      expect.anything(),
    );
    expect(globalScan).toHaveBeenCalledOnce();
    expect(globalScan).toHaveBeenCalledWith(runtimeConfig);
    expect(mocks.events).toEqual(["billing.woocommerce.subscription_receipts.failed", "global-scan"]);
  });

  it("keeps the successful Woo completion signal before one global scan", async () => {
    const runtimeConfig = {
      version: 8,
      billingReconciliationShopBatchSize: 25,
    } as never;
    const leaseHandle = { generation: 13 };
    const wooResult = { claimed: 2, processed: 2, failed: 0 };
    const globalScan = vi.fn(async () => {
      mocks.events.push("global-scan");
      return { subscriptionsScanned: 4 };
    });
    mocks.reconcileBatch.mockResolvedValueOnce(wooResult);

    await expect(reconcileWooReceiptsAndGlobalBillingScan(runtimeConfig, leaseHandle, globalScan))
      .resolves.toEqual({ subscriptionsScanned: 4 });

    expect(mocks.logger.info).toHaveBeenCalledWith("billing.woocommerce.subscription_receipts.completed", {
      leaseGeneration: 13,
      ...wooResult,
    });
    expect(mocks.logger.error).not.toHaveBeenCalled();
    expect(globalScan).toHaveBeenCalledOnce();
    expect(mocks.events).toEqual(["billing.woocommerce.subscription_receipts.completed", "global-scan"]);
  });
});