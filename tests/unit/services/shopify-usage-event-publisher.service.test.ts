import { describe, expect, it, vi } from "vitest";
import { ShopifyAppEventsError } from "../../../src/providers/shopify-app-events.provider.js";
import { ShopifyUsageEventPublisherService } from "../../../src/services/shopify-usage-event-publisher.service.js";

const now = new Date("2026-09-08T09:00:00.000Z");

function usageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "usage-1",
    shopId: "shop-1",
    quantity: 1,
    occurredAt: new Date("2026-09-08T08:00:00.000Z"),
    shopifyEventHandle: "recovery-conversation",
    shopifyIdempotencyKey: "shopify:shop-1:usage-1",
    shopifyReportState: "PENDING",
    reportAttemptCount: 0,
    nextReportAt: null,
    lastReportAttemptAt: null,
    shop: { shopifyShopId: "gid://shopify/Shop/1" },
    ...overrides,
  };
}

function harness(
  rows = [usageRow()],
  getNow: () => Date = () => now,
  recoveryCreditPurchaseActivator = { activateForUsageEvent: vi.fn().mockResolvedValue({ kind: "activated", creditsGranted: 1 }) },
) {
  const records = rows.map((row) => ({ ...row }));
  const states = new Map(records.map((row) => [row.id as string, row.shopifyReportState as string]));
  const updates: Array<{ where: unknown; data: unknown }> = [];
  const database = {
    usageEvent: {
      findMany: vi.fn().mockImplementation(async () =>
        records.filter((row) =>
          ["PENDING", "RETRYABLE"].includes(String(row.shopifyReportState)) &&
          (row.nextReportAt === null || (row.nextReportAt as Date) <= getNow()),
        ).map((row) => ({ ...row, shop: { ...(row.shop as object) } })),
      ),
      updateMany: vi.fn().mockImplementation(async ({ where, data }: { where: { id: string; shopifyReportState?: { in: string[] } | string }; data: unknown }) => {
        const update = data as Record<string, unknown>;
        const matchingRecords = records.filter((candidate) => {
          const current = states.get(candidate.id as string);
          if (where.id && where.id !== candidate.id) return false;
          if (typeof where.shopifyReportState === "string") {
            return where.shopifyReportState === current;
          }
          return !where.shopifyReportState || where.shopifyReportState.in.includes(current ?? "");
        });
        if (matchingRecords.length === 0) return { count: 0 };
        for (const record of matchingRecords as Array<Record<string, unknown>>) {
          if (update.reportAttemptCount && typeof update.reportAttemptCount === "object") {
            record.reportAttemptCount = Number(record.reportAttemptCount) + Number(
              (update.reportAttemptCount as { increment: number }).increment,
            );
          }
          for (const [key, value] of Object.entries(update)) {
            if (key !== "reportAttemptCount") record[key] = value;
          }
          states.set(record.id as string, String(record.shopifyReportState ?? ""));
        }
        updates.push({ where, data });
        return { count: matchingRecords.length };
      }),
    },
  };
  const provider = { createBillingEvent: vi.fn().mockResolvedValue(undefined) };
  const service = new ShopifyUsageEventPublisherService(
    database as never,
    provider,
    () => now,
    50,
    undefined,
    recoveryCreditPurchaseActivator,
  );
  return { database, provider, service, states, updates, recoveryCreditPurchaseActivator };
}

describe("ShopifyUsageEventPublisherService", () => {
  it("claims and reports positive and negative usage with persisted identity", async () => {
    const test = harness([
      usageRow(),
      usageRow({ id: "usage-2", quantity: -1, shopifyIdempotencyKey: "shopify:shop-1:usage-2" }),
    ]);

    await expect(test.service.publishDue()).resolves.toMatchObject({
      selected: 2,
      claimed: 2,
      reported: 2,
    });
    expect(test.provider.createBillingEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      value: 1,
      idempotencyKey: "shopify:shop-1:usage-1",
    }));
    expect(test.provider.createBillingEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      value: -1,
      idempotencyKey: "shopify:shop-1:usage-2",
    }));
    expect(test.states.get("usage-1")).toBe("REPORTED");
    expect(test.states.get("usage-2")).toBe("REPORTED");
  });

  it("fails closed before the provider when reportable mapping is incomplete", async () => {
    const test = harness([usageRow({ shop: { shopifyShopId: null } })]);

    await expect(test.service.publishDue()).resolves.toMatchObject({
      claimed: 1,
      needsAttention: 1,
    });
    expect(test.provider.createBillingEvent).not.toHaveBeenCalled();
    expect(test.states.get("usage-1")).toBe("NEEDS_ATTENTION");
  });

  it("schedules transient failures with bounded retry state", async () => {
    const test = harness();
    test.provider.createBillingEvent.mockRejectedValue(
      new ShopifyAppEventsError("throttled", "throttled"),
    );

    await expect(test.service.publishDue()).resolves.toMatchObject({ retryable: 1 });
    expect(test.states.get("usage-1")).toBe("RETRYABLE");
    expect(test.updates.at(-1)?.data).toMatchObject({
      shopifyReportState: "RETRYABLE",
      providerErrorCode: "throttled",
      nextReportAt: expect.any(Date),
    });
  });

  it("creates the default provider once and reuses it across scans", async () => {
    const test = harness();
    const provider = { createBillingEvent: vi.fn().mockResolvedValue(undefined) };
    const createProvider = vi.fn().mockReturnValue(provider);
    const service = new ShopifyUsageEventPublisherService(
      test.database as never,
      undefined,
      () => now,
      50,
      createProvider,
    );

    await Promise.all([service.publishDue(), service.publishDue()]);

    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(provider.createBillingEvent).toHaveBeenCalledTimes(1);
  });

  it("does not create the default provider when there are no due events", async () => {
    const test = harness([]);
    const createProvider = vi.fn(() => {
      throw new ShopifyAppEventsError("configuration", "credentials missing");
    });
    const service = new ShopifyUsageEventPublisherService(
      test.database as never,
      undefined,
      () => now,
      50,
      createProvider,
    );

    await expect(service.publishDue()).resolves.toMatchObject({ selected: 0 });
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("marks a valid event needs attention when default provider configuration is invalid", async () => {
    const test = harness();
    const createProvider = vi.fn(() => {
      throw new ShopifyAppEventsError("configuration", "credentials missing");
    });
    const service = new ShopifyUsageEventPublisherService(
      test.database as never,
      undefined,
      () => now,
      50,
      createProvider,
    );

    await expect(service.publishDue()).resolves.toMatchObject({
      selected: 1,
      claimed: 1,
      needsAttention: 1,
    });
    expect(test.states.get("usage-1")).toBe("NEEDS_ATTENTION");
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(test.updates.at(-1)?.data).toMatchObject({
      shopifyReportState: "NEEDS_ATTENTION",
      providerErrorCode: "configuration",
    });
  });

  it("uses claimed attempts for exponential retry delays and preserves the key", async () => {
    let currentNow = new Date(now);
    const test = harness([usageRow()], () => currentNow);
    const provider = test.provider;
    provider.createBillingEvent.mockRejectedValue(
      new ShopifyAppEventsError("throttled", "throttled"),
    );
    const service = new ShopifyUsageEventPublisherService(
      test.database as never,
      provider,
      () => currentNow,
    );

    await service.publishDue();
    const firstRetryAt = (test.updates.at(-1)?.data as { nextReportAt: Date }).nextReportAt;
    expect(firstRetryAt.getTime() - now.getTime()).toBe(60_000);

    currentNow = firstRetryAt;
    await service.publishDue();
    const secondRetryAt = (test.updates.at(-1)?.data as { nextReportAt: Date }).nextReportAt;
    expect(secondRetryAt.getTime() - firstRetryAt.getTime()).toBe(120_000);

    currentNow = secondRetryAt;
    for (let attempt = 3; attempt <= 7; attempt += 1) {
      await service.publishDue();
      const retryAt = (test.updates.at(-1)?.data as { nextReportAt: Date }).nextReportAt;
      if (attempt === 7) {
        expect(retryAt.getTime() - currentNow.getTime()).toBe(60 * 60_000);
      }
      currentNow = retryAt;
    }

    expect(test.provider.createBillingEvent).toHaveBeenCalledTimes(7);
    expect(new Set(
      test.provider.createBillingEvent.mock.calls.map(([event]) => event.idempotencyKey),
    )).toEqual(new Set(["shopify:shop-1:usage-1"]));
  });

  it("marks permanent provider failures for attention without retrying", async () => {
    const test = harness();
    test.provider.createBillingEvent.mockRejectedValue(
      new ShopifyAppEventsError("meter", "meter rejected"),
    );

    await expect(test.service.publishDue()).resolves.toMatchObject({ needsAttention: 1 });
    expect(test.states.get("usage-1")).toBe("NEEDS_ATTENTION");
    expect(test.updates.at(-1)?.data).toMatchObject({
      shopifyReportState: "NEEDS_ATTENTION",
      providerErrorCode: "meter",
      nextReportAt: null,
    });
  });

  it("allows only one of two workers to claim a row", async () => {
    const test = harness();
    const second = new ShopifyUsageEventPublisherService(
      test.database as never,
      test.provider,
      () => now,
    );

    const [first, other] = await Promise.all([
      test.service.publishDue(),
      second.publishDue(),
    ]);

    expect(first.claimed + other.claimed).toBe(1);
    expect(test.provider.createBillingEvent).toHaveBeenCalledTimes(1);
  });

  it("replays an accepted event with the same key after a durable update failure", async () => {
    let currentNow = new Date(now);
    const test = harness([usageRow()], () => currentNow);
    let reportUpdateAttempts = 0;
    const originalUpdate = test.database.usageEvent.updateMany;
    test.database.usageEvent.updateMany = vi.fn().mockImplementation(async (args) => {
      if (args.data.shopifyReportState === "REPORTED" && reportUpdateAttempts++ === 0) {
        throw new Error("database connection lost");
      }
      return originalUpdate(args);
    });

    const service = new ShopifyUsageEventPublisherService(
      test.database as never,
      test.provider,
      () => currentNow,
    );
    await expect(service.publishDue()).resolves.toMatchObject({ retryable: 1 });
    currentNow = new Date(now.getTime() + 16 * 60_000);
    await expect(service.publishDue()).resolves.toMatchObject({ reported: 1 });
    expect(test.provider.createBillingEvent).toHaveBeenCalledTimes(2);
    expect(test.provider.createBillingEvent.mock.calls[0]?.[0].idempotencyKey)
      .toBe(test.provider.createBillingEvent.mock.calls[1]?.[0].idempotencyKey);
  });

  it("activates a reported recovery-credit purchase exactly once", async () => {
    const activator = { activateForUsageEvent: vi.fn().mockResolvedValue({ kind: "activated", creditsGranted: 5 }) };
    const test = harness([
      usageRow({ metric: "RECOVERY_CREDIT_PACK_PURCHASE" }),
    ], () => now, activator);

    await test.service.publishDue();

    expect(test.states.get("usage-1")).toBe("REPORTED");
    expect(activator.activateForUsageEvent).toHaveBeenCalledTimes(1);
    expect(activator.activateForUsageEvent).toHaveBeenCalledWith("usage-1");
  });

  it("does not activate a purchase for an ordinary recovery metric", async () => {
    const activator = { activateForUsageEvent: vi.fn() };
    const test = harness([usageRow({ metric: "RECOVERY_CONVERSATION" })], () => now, activator);

    await test.service.publishDue();

    expect(test.states.get("usage-1")).toBe("REPORTED");
    expect(activator.activateForUsageEvent).not.toHaveBeenCalled();
  });

  it("keeps a successfully reported event reported when activation fails", async () => {
    const activator = {
      activateForUsageEvent: vi.fn().mockRejectedValue(new Error("activation unavailable")),
    };
    const test = harness([
      usageRow({ metric: "RECOVERY_CREDIT_PACK_PURCHASE" }),
    ], () => now, activator);

    await expect(test.service.publishDue()).resolves.toMatchObject({
      reported: 1,
      retryable: 0,
      needsAttention: 0,
    });
    expect(test.states.get("usage-1")).toBe("REPORTED");
    expect(test.updates.map((update) => (update.data as { shopifyReportState?: string }).shopifyReportState))
      .not.toContain("RETRYABLE");
    expect(test.updates.map((update) => (update.data as { shopifyReportState?: string }).shopifyReportState))
      .not.toContain("NEEDS_ATTENTION");
  });
});