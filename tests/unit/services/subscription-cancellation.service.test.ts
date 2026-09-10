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

function database(row: ReturnType<typeof request>, actualStatus = row.status) {
  let claimWon = true;
  let currentStatus = actualStatus;
  const updateMany = vi.fn().mockImplementation(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    if (data.status === SubscriptionCancellationStatus.PROCESSING) {
      if (!claimWon || where.status !== currentStatus) return { count: 0 };
      claimWon = false;
      currentStatus = SubscriptionCancellationStatus.PROCESSING;
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
    expect(test.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ providerErrorCode: null }),
    }));
  });

  it("preserves approved identity and mode across a retryable provider failure", async () => {
    const test = database(request({
      status: SubscriptionCancellationStatus.RETRYABLE,
      nextAttemptAt: new Date("2026-09-10T11:00:00.000Z"),
      providerErrorCode: "http-503",
    }));
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(active()),
      cancelSubscription: vi.fn().mockRejectedValue(new Error("network unavailable")),
    };

    const result = await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

    expect(result.retryable).toBe(1);
    expect(provider.cancelSubscription).toHaveBeenCalledWith({
      shopifyShopId: "gid://shopify/Shop/1",
      mode: "END_OF_CYCLE",
    });
    expect(test.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: SubscriptionCancellationStatus.RETRYABLE,
        providerErrorCode: "unknown-provider-error",
      }),
    }));
  });

  it("includes the selected lifecycle status in the claim CAS", async () => {
    const test = database(request(), SubscriptionCancellationStatus.RETRYABLE);
    const provider = {
      getActiveSubscription: vi.fn(),
      cancelSubscription: vi.fn(),
    };

    const result = await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

    expect(result.claimed).toBe(0);
    expect(provider.getActiveSubscription).not.toHaveBeenCalled();
    expect(test.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "cancel-1",
        version: 2,
        status: SubscriptionCancellationStatus.APPROVED,
      }),
    }));
  });

  it("uses the default batch and deterministic due ordering query", async () => {
    const test = database(request());
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(active({ cancelAtPeriodEnd: true })),
      cancelSubscription: vi.fn(),
    };

    await new SubscriptionCancellationService(test.db, provider, () => now).processDue(100);

    expect(test.db.subscriptionCancellationRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 25,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          { status: SubscriptionCancellationStatus.APPROVED },
          { status: SubscriptionCancellationStatus.PROVIDER_ACCEPTED },
          expect.objectContaining({ status: SubscriptionCancellationStatus.RETRYABLE }),
        ]),
      }),
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

  it.each(["IMMEDIATE_NO_PRORATION", "IMMEDIATE_PRORATED", "IMMEDIATE_SKIP_FINAL_USAGE"] as const)(
    "completes immediate mode %s only after no active subscription",
    async (mode) => {
      const test = database(request({
        mode,
        status: SubscriptionCancellationStatus.PROVIDER_ACCEPTED,
        providerAcceptedAt: new Date("2026-09-10T11:00:00.000Z"),
      }));
      const provider = {
        getActiveSubscription: vi.fn().mockResolvedValue(active()),
        cancelSubscription: vi.fn(),
      };

      const result = await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

      expect(result.retryable).toBe(1);
      expect(provider.cancelSubscription).not.toHaveBeenCalled();
      expect(test.merchantSupportMessage.upsert).not.toHaveBeenCalled();
    },
  );

  it("does not falsely complete end-of-cycle cancellation when confirmation has no contract", async () => {
    const test = database(request({
      status: SubscriptionCancellationStatus.PROVIDER_ACCEPTED,
      providerAcceptedAt: new Date("2026-09-10T11:00:00.000Z"),
    }));
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(null),
      cancelSubscription: vi.fn(),
    };

    const result = await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

    expect(result.retryable).toBe(1);
    expect(test.merchantSupportMessage.upsert).not.toHaveBeenCalled();
  });

  it("recovers stale processing leases into retry and provider verification paths", async () => {
    const test = database(request({ status: SubscriptionCancellationStatus.PROCESSING }), SubscriptionCancellationStatus.PROCESSING);
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(active()),
      cancelSubscription: vi.fn(),
    };

    await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

    expect(test.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: SubscriptionCancellationStatus.PROCESSING,
        providerAcceptedAt: null,
      }),
      data: expect.objectContaining({ status: SubscriptionCancellationStatus.RETRYABLE }),
    }));
    expect(test.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: SubscriptionCancellationStatus.PROCESSING,
        providerAcceptedAt: { not: null },
      }),
      data: expect.objectContaining({ status: SubscriptionCancellationStatus.PROVIDER_ACCEPTED }),
    }));
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
    expect(test.merchantSupportMessage.upsert).not.toHaveBeenCalled();
  });

  it("emits one completion message when completion is replayed", async () => {
    const test = database(request());
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(active({ cancelAtPeriodEnd: true })),
      cancelSubscription: vi.fn(),
    };
    const service = new SubscriptionCancellationService(test.db, provider, () => now);

    await service.processDue();
    await service.processDue();

    expect(test.merchantSupportMessage.upsert).toHaveBeenCalledTimes(1);
  });
});