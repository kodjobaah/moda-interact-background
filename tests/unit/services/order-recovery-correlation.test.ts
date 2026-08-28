import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  return {
    redisMock: {
      set: vi.fn(async () => "OK"),
      get: vi.fn(async () => null),
      del: vi.fn(async () => 1),
    },
    prismaMock: {
      shop: {
        findUnique: vi.fn(),
      },
      checkoutRecovery: {
        findUnique: vi.fn(),
      },
    },
    pendingCandidateServiceMock: {
      withCheckoutLock: vi.fn(),
      resolveCandidate: vi.fn(),
      cancelCandidate: vi.fn(),
      markOrderProcessed: vi.fn(),
      hasOrderProcessed: vi.fn(),
    },
  };
});

const { redisMock } = hoisted;
const { prismaMock } = hoisted;
const { pendingCandidateServiceMock } = hoisted;

vi.mock("../../../src/lib/redis.js", () => ({
  connectionRedis: hoisted.redisMock,
}));

vi.mock("../../../src/lib/db.js", () => ({
  default: hoisted.prismaMock,
}));

// The order path calls the pending-candidate service for indexed correlation,
// cancellation, the checkout-scoped lock and the order tombstone. We stub the
// singleton to control each correlation outcome instead of exercising a real
// BullMQ queue or Redis instance here.
vi.mock("../../../src/services/pending-recovery-candidate.service.js", () => ({
  pendingRecoveryCandidateService: hoisted.pendingCandidateServiceMock,
  resetPendingCandidateQueueForTests: vi.fn(async () => undefined),
}));

import { CheckoutRecoveryService } from "../../../src/services/checkout-recovery.service.js";

const service = new CheckoutRecoveryService();

function installPrismaTransaction() {
  const txFake = {
          updateMany: vi.fn(async () => ({ count: 1 })),
    statusHistoryCreate: vi.fn(async () => ({})),
      };

    prismaMock.$transaction = vi.fn(async (fn) => {
      const tx = {
        checkoutRecovery: {
          findUnique: prismaMock.checkoutRecovery.findUnique,
        updateMany: txFake.updateMany,
        },
      checkoutRecoveryStatusHistory: {
        create: txFake.statusHistoryCreate,
      },
    };
    return fn(tx);
  });

  return txFake;
}

function buildInput(overrides: Record<string, unknown> = {}) {
  return {
    shop: "shop.myshopify.com",
    orderId: "order_1",
    checkoutToken: "checkout_1",
    cartToken: "cart_1",
    customerId: null,
    totalPrice: null,
    currency: null,
    completedAt: "2026-08-28T12:45:00Z",
    ...overrides,
  };
}

describe("CheckoutRecoveryService.handleOrderCompleted (ARCH-001-BACKGROUND-005)", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    redisMock.set.mockResolvedValue("OK");
    redisMock.get.mockResolvedValue(null);
    redisMock.del.mockResolvedValue(1);

    prismaMock.shop.findUnique.mockResolvedValue({ id: "shop_1" });
    prismaMock.checkoutRecovery.findUnique.mockResolvedValue({
      id: "recovery-1",
      status: "MESSAGE_SENT",
    });
    pendingCandidateServiceMock.resolveCandidate.mockResolvedValue(null);
    pendingCandidateServiceMock.cancelCandidate.mockResolvedValue({ removed: true });
    pendingCandidateServiceMock.markOrderProcessed.mockResolvedValue(undefined);
    pendingCandidateServiceMock.hasOrderProcessed.mockResolvedValue(false);
    pendingCandidateServiceMock.withCheckoutLock.mockImplementation(
      async (_s: string, _t: string, fn: () => Promise<unknown>) => fn(),
    );
  });

  it("cancels a pending candidate matched by checkout token and discards the order (no durable recovery write)", async () => {
    pendingCandidateServiceMock.resolveCandidate.mockResolvedValue({
      jobId: "job-1",
      candidate: {
        shopId: "shop_1",
        checkoutToken: "checkout_1",
        cartToken: "cart_1",
        abandonedCheckoutUrl: null,
        checkoutCreatedAt: null,
      },
    });

    const result = await service.handleOrderCompleted(buildInput());

    expect(result).toEqual({
      kind: "cancelled-candidate",
      checkoutToken: "checkout_1",
    });
    expect(pendingCandidateServiceMock.cancelCandidate).toHaveBeenCalledTimes(1);
    expect(pendingCandidateServiceMock.markOrderProcessed).toHaveBeenCalledWith(
      "shop_1",
      "checkout_1",
    );
    // The order must not complete an existing recovery.
  });

  it("completes an eligible existing recovery and transitions it once to COMPLETED", async () => {
    const txFake = installPrismaTransaction();

    const result = await service.handleOrderCompleted(buildInput());

    expect(result).toEqual({
      kind: "completed",
      recoveryId: "recovery-1",
      fromStatus: "MESSAGE_SENT",
});
    expect(txFake.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "COMPLETED" }),
      }),
    );
    expect(txFake.statusHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          toStatus: "COMPLETED",
          reason: "Order completed",
          source: "shopify.orders.create",
          metadata: { orderId: "order_1" },
        }),
      }),
    );
  });

  it("completes an eligible recovery using the event completion timestamp", async () => {
    const txFake = installPrismaTransaction();

    await service.handleOrderCompleted(buildInput({ completedAt: "2026-08-28T09:15:00Z" }));

    const updateManyArgs = txFake.updateMany.mock.calls[0][0];
    expect(updateManyArgs.data.completedAt).toEqual(new Date("2026-08-28T09:15:00Z"));
  });

  it("does not reopen a terminal recovery", async () => {
    prismaMock.checkoutRecovery.findUnique.mockResolvedValue({
      id: "recovery-1",
      status: "COMPLETED",
    });
    const txFake = installPrismaTransaction();

    const result = await service.handleOrderCompleted(buildInput());

    expect(result).toEqual({ kind: "ignored", reason: "terminal-completed" });
    expect(txFake.updateMany).not.toHaveBeenCalled();
    expect(txFake.statusHistoryCreate).not.toHaveBeenCalled();
  });

  it("discards an unrelated order without durable order persistence or candidate cancellation", async () => {
    prismaMock.checkoutRecovery.findUnique.mockResolvedValue(null);
    const txFake = installPrismaTransaction();

    const result = await service.handleOrderCompleted(buildInput());

    expect(result).toEqual({ kind: "discarded", reason: "recovery-not-found" });
    expect(pendingCandidateServiceMock.cancelCandidate).not.toHaveBeenCalled();
    expect(txFake.updateMany).not.toHaveBeenCalled();
    expect(txFake.statusHistoryCreate).not.toHaveBeenCalled();
  });

  it("rejects customer-only correlation (no checkout or cart token)", async () => {
    const result = await service.handleOrderCompleted(
      buildInput({ checkoutToken: null, cartToken: null }),
    );

    expect(result).toEqual({ kind: "ignored", reason: "missing-correlation" });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(pendingCandidateServiceMock.resolveCandidate).not.toHaveBeenCalled();
  });

  it("is idempotent under duplicate order delivery", async () => {
    let call = 0;
    prismaMock.checkoutRecovery.findUnique.mockImplementation(async () => {
      call += 1;
      return call === 1
        ? { id: "recovery-1", status: "ENGAGED" }
        : { id: "recovery-1", status: "COMPLETED" };
    });
    installPrismaTransaction();

    const first = await service.handleOrderCompleted(buildInput());
    const second = await service.handleOrderCompleted(buildInput());

    expect(first).toEqual({
      kind: "completed",
      recoveryId: "recovery-1",
      fromStatus: "ENGAGED",
    });
    expect(second).toEqual({ kind: "ignored", reason: "terminal-completed" });
  });

  it("marks an order as processed (tombstone) even when no candidate or recovery is found, suppressing a recovery message", async () => {
    prismaMock.checkoutRecovery.findUnique.mockResolvedValue(null);
    installPrismaTransaction();

    await service.handleOrderCompleted(buildInput());

    expect(pendingCandidateServiceMock.markOrderProcessed).toHaveBeenCalledWith(
      "shop_1",
      "checkout_1",
    );
  });
});



