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
    reconcileChargeBatch: vi.fn(),
    reconcileChargeRefundBatch: vi.fn(),
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
vi.mock("../../../src/services/woocommerce-billing/charge-receipt-reconciliation.service.js", () => ({
  wooChargeReceiptReconciliationService: { reconcileBatch: mocks.reconcileChargeBatch },
}));
vi.mock("../../../src/services/woocommerce-billing/charge-refund-reconciliation.service.js", () => ({
  wooChargeRefundReceiptReconciliationService: { reconcileBatch: mocks.reconcileChargeRefundBatch },
}));

import {
  reconcileWooPaidEntitlementsAndContinue,
  reconcileWooReceiptsAndGlobalBillingScan,
} from "../../../src/entrypoints/billing.js";

describe("billing entrypoint Woo receipt failure boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
    mocks.reconcileChargeBatch.mockResolvedValue({ claimed: 0, processed: 0, activated: 0, canceled: 0, retryable: 0 });
    mocks.reconcileChargeRefundBatch.mockResolvedValue({ claimed: 0, processed: 0, retryable: 0 });
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
    expect(mocks.reconcileChargeBatch).toHaveBeenCalledOnce();
    expect(mocks.events).toEqual([
      "billing.woocommerce.subscription_receipts.failed",
      "billing.woocommerce.charge_receipts.completed",
      "billing.woocommerce.charge_refund_receipts.completed",
      "global-scan",
    ]);
  });

  it("keeps the successful Woo completion signal before one global scan", async () => {
    const runtimeConfig = {
      version: 8,
      billingReconciliationShopBatchSize: 25,
    } as never;
    const leaseHandle = { generation: 13 };
    const wooResult = { claimed: 2, processed: 2, failed: 0 };
    const chargeResult = { claimed: 1, processed: 1, activated: 1, canceled: 0, retryable: 0 };
    const refundResult = { claimed: 2, processed: 2, retryable: 0 };
    const globalScan = vi.fn(async () => {
      mocks.events.push("global-scan");
      return { subscriptionsScanned: 4 };
    });
    mocks.reconcileBatch.mockResolvedValueOnce(wooResult);
    mocks.reconcileChargeBatch.mockImplementationOnce(async () => {
      mocks.events.push("charge-receipts");
      return chargeResult;
    });
    mocks.reconcileChargeRefundBatch.mockImplementationOnce(async () => {
      mocks.events.push("refund-receipts");
      return refundResult;
    });

    await expect(reconcileWooReceiptsAndGlobalBillingScan(runtimeConfig, leaseHandle, globalScan))
      .resolves.toEqual({ subscriptionsScanned: 4 });

    expect(mocks.logger.info).toHaveBeenCalledWith("billing.woocommerce.subscription_receipts.completed", {
      leaseGeneration: 13,
      ...wooResult,
    });
    expect(mocks.logger.error).not.toHaveBeenCalled();
    expect(mocks.logger.info).toHaveBeenCalledWith("billing.woocommerce.charge_receipts.completed", {
      leaseGeneration: 13,
      ...chargeResult,
    });
    expect(mocks.logger.info).toHaveBeenCalledWith("billing.woocommerce.charge_refund_receipts.completed", {
      leaseGeneration: 13,
      ...refundResult,
    });
    expect(globalScan).toHaveBeenCalledOnce();
    expect(mocks.events).toEqual([
      "billing.woocommerce.subscription_receipts.completed",
      "charge-receipts",
      "billing.woocommerce.charge_receipts.completed",
      "refund-receipts",
      "billing.woocommerce.charge_refund_receipts.completed",
      "global-scan",
    ]);
  });

  it("logs a rejected charge batch and still invokes one global scan", async () => {
    const runtimeConfig = {
      version: 9,
      billingReconciliationShopBatchSize: 25,
    } as never;
    const leaseHandle = { generation: 14 };
    const globalScan = vi.fn(async () => {
      mocks.events.push("global-scan");
      return { subscriptionsScanned: 5 };
    });
    mocks.reconcileBatch.mockResolvedValueOnce({ claimed: 0, processed: 0, failed: 0 });
    mocks.reconcileChargeBatch.mockRejectedValueOnce(new Error("database unavailable"));
    mocks.reconcileChargeRefundBatch.mockRejectedValueOnce(new Error("refund database unavailable"));

    await expect(reconcileWooReceiptsAndGlobalBillingScan(runtimeConfig, leaseHandle, globalScan))
      .resolves.toEqual({ subscriptionsScanned: 5 });

    expect(mocks.logger.error).toHaveBeenCalledWith("billing.woocommerce.charge_receipts.failed", {
      leaseGeneration: 14,
      configVersion: 9,
      outcome: "failed",
    });
    expect(mocks.logger.info).not.toHaveBeenCalledWith(
      "billing.woocommerce.charge_receipts.completed",
      expect.anything(),
    );
    expect(globalScan).toHaveBeenCalledOnce();
    expect(mocks.events).toEqual([
      "billing.woocommerce.subscription_receipts.completed",
      "billing.woocommerce.charge_receipts.failed",
      "billing.woocommerce.charge_refund_receipts.failed",
      "global-scan",
    ]);
  });

  it("logs a rejected paid-entitlement scan and still runs later billing phases", async () => {
    const runtimeConfig = { version: 9 } as never;
    const leaseHandle = { generation: 14 };
    const failure = new Error("e".repeat(300));
    failure.name = "Entitlement".repeat(10);
    const reconcileEntitlements = vi.fn().mockRejectedValueOnce(failure);
    const laterPhases = vi.fn(async () => {
      mocks.events.push("promotion-expiry", "refund-correction", "reconstruction", "cycle-completed");
      return "completed";
    });

    await expect(reconcileWooPaidEntitlementsAndContinue(
      runtimeConfig,
      leaseHandle,
      reconcileEntitlements,
      laterPhases,
    )).resolves.toBe("completed");

    expect(mocks.logger.error).toHaveBeenCalledWith("billing.woocommerce.paid_entitlement.reconciliation_failed", {
      leaseGeneration: 14,
      configVersion: 9,
      errorName: "Entitlement".repeat(10).slice(0, 64),
      errorMessage: "e".repeat(256),
    });
    expect(mocks.logger.info).not.toHaveBeenCalledWith(
      "billing.woocommerce.paid_entitlement.reconciliation_completed",
      expect.anything(),
    );
    expect(mocks.events).toEqual([
      "billing.woocommerce.paid_entitlement.reconciliation_failed",
      "promotion-expiry",
      "refund-correction",
      "reconstruction",
      "cycle-completed",
    ]);
    expect(laterPhases).toHaveBeenCalledOnce();
  });

  it("reports paid-entitlement success before continuing the billing cycle", async () => {
    const runtimeConfig = { version: 10 } as never;
    const leaseHandle = { generation: 15 };
    const result = { selected: 2, reconciled: 2, failed: 0 };
    const continueBillingCycle = vi.fn(async () => "completed");

    await expect(reconcileWooPaidEntitlementsAndContinue(
      runtimeConfig,
      leaseHandle,
      async () => result,
      continueBillingCycle,
    )).resolves.toBe("completed");

    expect(mocks.logger.info).toHaveBeenCalledWith(
      "billing.woocommerce.paid_entitlement.reconciliation_completed",
      { leaseGeneration: 15, ...result },
    );
    expect(mocks.logger.error).not.toHaveBeenCalled();
    expect(mocks.events).toEqual(["billing.woocommerce.paid_entitlement.reconciliation_completed"]);
    expect(continueBillingCycle).toHaveBeenCalledOnce();
  });
});