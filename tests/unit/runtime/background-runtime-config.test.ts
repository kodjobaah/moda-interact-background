import { describe, expect, it, vi } from "vitest";

import { BackgroundRuntimeConfigService, type BackgroundRuntimeConfigSnapshot } from "../../../src/runtime/background-runtime-config.js";

const numericFields = [
  "billingReconciliationIntervalSeconds", "billingReconciliationShopBatchSize", "shopifyUsagePublishBatchSize",
  "recoveryRepairIntervalSeconds", "recoveryRepairShopBatchSize", "recoveryResumeBatchSize",
  "translationReconciliationIntervalSeconds", "translationBatchMaxRequests", "conversationQuietWindowMs",
  "conversationMaxSettleWindowMs", "billingFrozenRecheckSeconds", "billingProviderRetrySeconds",
  "shopifyUsageRetryBaseSeconds", "shopifyUsageRetryMaxSeconds", "translationReconciliationPageSize",
  "translationClaimTimeoutSeconds", "translationSubmitRetrySeconds", "translationInitialPollSeconds",
  "translationPollIntervalSeconds", "translationResultRetrySeconds", "translationSubmitMaxAttempts",
  "translationMaxAutoRetries", "rawSenderLimitPerMinute", "rawGlobalLimitPerMinute", "turnSenderLimitPerMinute",
  "turnSenderLimitPerTenMinutes", "turnConversationLimitPerMinute", "turnConversationLimitPerTenMinutes",
  "turnShopLimitPerMinute", "turnGlobalLimitPerMinute", "discoverySenderLimitPerMinute",
  "discoverySenderLimitPerTenMinutes", "discoveryConversationLimitPerMinute", "discoveryConversationLimitPerTenMinutes",
  "checkoutQueueGlobalConcurrency", "orderQueueGlobalConcurrency", "pendingRecoveryQueueGlobalConcurrency",
  "recoveryResumeQueueGlobalConcurrency", "whatsappQueueGlobalConcurrency", "merchantCommunicationsQueueGlobalConcurrency",
  "billingSubscriptionQueueGlobalConcurrency",
] as const;

function config(version = 1): BackgroundRuntimeConfigSnapshot {
  return Object.freeze({
    id: "default", version, createdAt: new Date(1), updatedAt: new Date(version),
    ...Object.fromEntries(numericFields.map((field) => [field, 1])),
  }) as BackgroundRuntimeConfigSnapshot;
}

function database(row: BackgroundRuntimeConfigSnapshot | null) {
  return { backgroundRuntimeConfig: { findUnique: vi.fn().mockResolvedValue(row) } } as any;
}

describe("BackgroundRuntimeConfigService", () => {
  it("rejects a usage retry maximum below its base", async () => {
    const invalid = { ...config(), shopifyUsageRetryBaseSeconds: 10, shopifyUsageRetryMaxSeconds: 5 };
    await expect(new BackgroundRuntimeConfigService(database(invalid)).start()).rejects.toThrow(
      "usage retry max must be at least the base",
    );
  });
  it("requires startup before current can be read and publishes immutable dates", async () => {
    const row = config();
    const service = new BackgroundRuntimeConfigService(database(row));
    expect(() => service.current()).toThrow("Background runtime configuration has not started.");

    await service.start();
    const snapshot = service.current();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.createdAt)).toBe(true);
    expect(Object.isFrozen(snapshot.updatedAt)).toBe(true);
    expect(() => snapshot.createdAt.setTime(2)).toThrow("Immutable runtime configuration date.");
    expect(() => snapshot.updatedAt.setUTCFullYear(2020)).toThrow("Immutable runtime configuration date.");
    expect(row.createdAt.getTime()).toBe(1);
    expect(row.updatedAt.getTime()).toBe(1);
  });

  it("loads the singleton initially and rejects a missing row", async () => {
    const service = new BackgroundRuntimeConfigService(database(config()));
    await service.start();
    expect(service.current().version).toBe(1);
    await expect(new BackgroundRuntimeConfigService(database(null)).start()).rejects.toThrow("Background runtime configuration is missing.");
  });

  it("accepts newer versions and ignores equal or older versions", async () => {
    const db = database(config(1));
    const service = new BackgroundRuntimeConfigService(db);
    await service.start();
    db.backgroundRuntimeConfig.findUnique.mockResolvedValueOnce(config(2)).mockResolvedValueOnce(config(1));
    await service.getFresh();
    await service.getFresh();
    expect(service.current().version).toBe(2);
  });

  it("retains the last known good row and isolates listener failures", async () => {
    const db = database(config(1));
    const log = { warn: vi.fn() } as any;
    const service = new BackgroundRuntimeConfigService(db, log);
    const first = vi.fn().mockRejectedValue(new Error("listener"));
    const second = vi.fn();
    service.subscribe(first);
    service.subscribe(second);
    await service.start();
    db.backgroundRuntimeConfig.findUnique.mockRejectedValueOnce(new Error("temporary"));
    expect((await service.getFresh()).version).toBe(1);
    db.backgroundRuntimeConfig.findUnique.mockResolvedValueOnce(config(2));
    await service.getFresh();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});