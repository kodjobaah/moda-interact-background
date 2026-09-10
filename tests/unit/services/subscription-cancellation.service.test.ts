import { describe, expect, it, vi } from "vitest";

import { SubscriptionCancellationStatus } from "@prisma/client";

import { SubscriptionCancellationService } from "../../../src/services/subscription-cancellation.service.js";

const now = new Date("2026-09-10T12:00:00.000Z");

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: "cancel-1",
    shopId: "shop-1",
    providerSubscriptionIdSnapshot: "sub-1",
    planHandleSnapshot: "growth-plan",
    mode: "END_OF_CYCLE",
    status: SubscriptionCancellationStatus.APPROVED,
    version: 2,
    attemptCount: 0,
    providerAcceptedAt: null,
    shop: { shopifyShopId: "gid://shopify/Shop/1" },
    ...overrides,
  } as never;
}

function database(row: ReturnType<typeof request>) {
  let claimWon = true;
  const updateMany = vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    if (data.status === SubscriptionCancellationStatus.PROCESSING) {
      if (!claimWon) return { count: 0 };
      claimWon = false;
      return { count: 1 };
    }
    return { count: 1 };
  });
  const merchantSupportMessage = { upsert: vi.fn().mockResolvedValue({}) };
  const merchantSupportThread = { upsert: vi.fn().mockResolvedValue({ id: "thread-1" }) };
  const db = {
    subscriptionCancellationRequest: {
      updateMany,
      findMany: vi.fn().mockResolvedValue([row]),
    },
    merchantSupportMessage,
    merchantSupportThread,
    $transaction: vi.fn(async (callback: (transaction: unknown) => unknown) => callback(db)),
  };
  return { db: db as never, updateMany, merchantSupportMessage, merchantSupportThread };
}

function active(overrides: Record<string, unknown> = {}) {
  return {
    providerSubscriptionId: "sub-1",
    planHandle: "growth-plan",
    cancelAtPeriodEnd: false,
    ...overrides,
  } as never;
}

describe("SubscriptionCancellationService", () => {
  it("does not call the provider mutation when the approved identity changed", async () => {
    const test = database(request());
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(active({ providerSubscriptionId: "sub-2" })),
      cancelSubscription: vi.fn(),
    };

    await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

    expect(provider.cancelSubscription).not.toHaveBeenCalled();
    expect(test.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: SubscriptionCancellationStatus.NEEDS_ATTENTION }),
    }));
  });

  it("completes an already deferred end-of-cycle cancellation without a duplicate call", async () => {
    const test = database(request());
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(active({ cancelAtPeriodEnd: true })),
      cancelSubscription: vi.fn(),
    };

    const result = await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

    expect(result.completed).toBe(1);
    expect(provider.cancelSubscription).not.toHaveBeenCalled();
    expect(test.merchantSupportMessage.upsert).toHaveBeenCalledTimes(1);
  });

  it("completes an immediate cancellation when Partner reports no contract", async () => {
    const test = database(request({ mode: "IMMEDIATE_NO_PRORATION" }));
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(null),
      cancelSubscription: vi.fn(),
    };

    await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

    expect(provider.cancelSubscription).not.toHaveBeenCalled();
    expect(test.merchantSupportMessage.upsert).toHaveBeenCalledTimes(1);
  });

  it("records provider acceptance without prematurely completing", async () => {
    const test = database(request());
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(active()),
      cancelSubscription: vi.fn().mockResolvedValue({ summary: "accepted" }),
    };

    const result = await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

    expect(result.accepted).toBe(1);
    expect(test.merchantSupportMessage.upsert).not.toHaveBeenCalled();
    expect(test.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: SubscriptionCancellationStatus.PROVIDER_ACCEPTED }),
    }));
  });

  it("confirms immediate cancellation only when no active subscription remains", async () => {
    const test = database(request({
      status: SubscriptionCancellationStatus.PROVIDER_ACCEPTED,
      providerAcceptedAt: new Date("2026-09-10T11:00:00.000Z"),
      mode: "IMMEDIATE_PRORATED",
    }));
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(null),
      cancelSubscription: vi.fn(),
    };

    await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

    expect(provider.cancelSubscription).not.toHaveBeenCalled();
    expect(test.merchantSupportMessage.upsert).toHaveBeenCalledTimes(1);
  });

  it("allows only one concurrent CAS claimant", async () => {
    const test = database(request());
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(active()),
      cancelSubscription: vi.fn().mockResolvedValue({ summary: "accepted" }),
    };
    const service = new SubscriptionCancellationService(test.db, provider, () => now);

    await service.processDue();
    await service.processDue();

    expect(provider.cancelSubscription).toHaveBeenCalledTimes(1);
  });
});