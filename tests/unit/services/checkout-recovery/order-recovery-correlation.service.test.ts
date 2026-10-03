import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrderRecoveryCorrelationService } from "../../../../src/services/checkout-recovery/order-recovery-correlation.service.js";

const event = {
  shop: "shop.myshopify.com",
  orderId: "order-1",
  checkoutToken: "checkout-1",
  cartToken: "cart-1",
  customerId: "customer-1",
  totalPrice: "25.00",
  currency: "GBP",
  completedAt: "2026-10-03T09:15:00.000Z",
};

function buildCandidate(checkoutToken = "checkout-1") {
  return {
    jobId: "candidate-1",
    candidate: {
      shopId: "shop-1",
      checkoutToken,
      cartToken: "cart-1",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
    },
  };
}

function createHarness({
  shop = { id: "shop-1", status: "ACTIVE" },
  candidates = [] as Array<ReturnType<typeof buildCandidate> | null>,
  recovery = { id: "recovery-1", status: "ENGAGED", generation: 2 },
  updateCount = 1,
} = {}) {
  const order: string[] = [];
  const candidateResults = [...candidates];
  const checkoutRecovery = {
    findFirst: vi.fn(async () => {
      order.push("recovery-read");
      return recovery;
    }),
    updateMany: vi.fn(async () => {
      order.push("recovery-update");
      return { count: updateCount };
    }),
  };
  const statusHistory = {
    create: vi.fn(async () => {
      order.push("history-create");
      return {};
    }),
  };
  const transaction = { checkoutRecovery, checkoutRecoveryStatusHistory: statusHistory };
  const database = {
    shop: {
      findUnique: vi.fn(async () => {
        order.push("shop-read");
        return shop;
      }),
    },
    $transaction: vi.fn(async (callback: (transaction: typeof transaction) => unknown) => {
      order.push("transaction");
      return callback(transaction);
    }),
  };
  const pendingRecoveryCandidateService = {
    resolveCandidate: vi.fn(async () => {
      order.push("candidate-resolve");
      return candidateResults.shift() ?? null;
    }),
    withCheckoutLock: vi.fn(async (
      _shopId: string,
      _checkoutToken: string,
      callback: () => Promise<unknown>,
    ) => {
      order.push("lock");
      return callback();
    }),
    cancelCandidate: vi.fn(async () => {
      order.push("candidate-cancel");
      return { removed: true };
    }),
    markOrderProcessed: vi.fn(async () => {
      order.push("tombstone");
    }),
  };
  const service = new OrderRecoveryCorrelationService(
    database as never,
    pendingRecoveryCandidateService as never,
  );

  return {
    order,
    database,
    checkoutRecovery,
    statusHistory,
    pendingRecoveryCandidateService,
    service,
  };
}

describe("OrderRecoveryCorrelationService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects customer-only correlation before shop or candidate access", async () => {
    const harness = createHarness();

    await expect(harness.service.handleOrderCompleted({
      ...event,
      checkoutToken: null,
      cartToken: null,
    })).resolves.toEqual({ kind: "ignored", reason: "missing-correlation" });
    expect(harness.database.shop.findUnique).not.toHaveBeenCalled();
    expect(harness.pendingRecoveryCandidateService.resolveCandidate).not.toHaveBeenCalled();
  });

  it("uses cart correlation only to recover checkout scope before locking and cancelling", async () => {
    const matched = buildCandidate();
    const harness = createHarness({ candidates: [matched, matched] });

    await expect(harness.service.handleOrderCompleted({
      ...event,
      checkoutToken: null,
    })).resolves.toEqual({ kind: "cancelled-candidate", checkoutToken: "checkout-1" });

    expect(harness.pendingRecoveryCandidateService.resolveCandidate).toHaveBeenNthCalledWith(1, {
      shopId: "shop-1",
      checkoutToken: null,
      cartToken: "cart-1",
    });
    expect(harness.pendingRecoveryCandidateService.withCheckoutLock).toHaveBeenCalledWith(
      "shop-1",
      "checkout-1",
      expect.any(Function),
    );
    expect(harness.order).toEqual([
      "shop-read",
      "candidate-resolve",
      "lock",
      "candidate-resolve",
      "candidate-cancel",
      "tombstone",
    ]);
    expect(harness.database.$transaction).not.toHaveBeenCalled();
  });

  it("does not lock a cart-only order without an indexed checkout candidate", async () => {
    const harness = createHarness();

    await expect(harness.service.handleOrderCompleted({
      ...event,
      checkoutToken: null,
    })).resolves.toEqual({ kind: "discarded", reason: "no-checkout-token" });
    expect(harness.pendingRecoveryCandidateService.withCheckoutLock).not.toHaveBeenCalled();
    expect(harness.database.$transaction).not.toHaveBeenCalled();
  });

  it("tombstones before the transaction and atomically completes the latest eligible recovery", async () => {
    const harness = createHarness({
      shop: { id: "shop-1", status: "ACTIVE", subscription: { status: "FROZEN" } },
    });

    await expect(harness.service.handleOrderCompleted(event)).resolves.toEqual({
      kind: "completed",
      recoveryId: "recovery-1",
      fromStatus: "ENGAGED",
    });

    expect(harness.database.shop.findUnique).toHaveBeenCalledWith({
      where: { domain: event.shop },
      select: { id: true, status: true },
    });
    expect(harness.checkoutRecovery.findFirst).toHaveBeenCalledWith({
      where: { shopId: "shop-1", checkoutToken: "checkout-1" },
      orderBy: [{ generation: "desc" }, { id: "desc" }],
      select: { id: true, status: true, generation: true },
    });
    expect(harness.checkoutRecovery.updateMany).toHaveBeenCalledWith({
      where: {
        id: "recovery-1",
        status: { in: ["DETECTED", "MESSAGE_SENT", "ENGAGED"] },
      },
      data: {
        status: "COMPLETED",
        completedAt: new Date(event.completedAt),
        admissionBlockedAt: null,
        admissionBlockReason: null,
      },
    });
    expect(harness.statusHistory.create).toHaveBeenCalledWith({
      data: {
        checkoutRecoveryId: "recovery-1",
        fromStatus: "ENGAGED",
        toStatus: "COMPLETED",
        reason: "Order completed",
        source: "shopify.orders.create",
        metadata: { orderId: "order-1", customerId: "customer-1" },
        occurredAt: new Date(event.completedAt),
      },
    });
    expect(harness.order).toEqual([
      "shop-read",
      "lock",
      "candidate-resolve",
      "tombstone",
      "transaction",
      "recovery-read",
      "recovery-update",
      "history-create",
    ]);
  });

  it("keeps the tombstone when no recovery exists", async () => {
    const harness = createHarness({ recovery: null });

    await expect(harness.service.handleOrderCompleted(event)).resolves.toEqual({
      kind: "discarded",
      reason: "recovery-not-found",
    });
    expect(harness.order).toEqual([
      "shop-read",
      "lock",
      "candidate-resolve",
      "tombstone",
      "transaction",
      "recovery-read",
    ]);
    expect(harness.checkoutRecovery.updateMany).not.toHaveBeenCalled();
    expect(harness.statusHistory.create).not.toHaveBeenCalled();
  });

  it.each(["COMPLETED", "EXPIRED", "CANCELLED"])(
    "does not reopen terminal recovery %s",
    async (status) => {
      const harness = createHarness({ recovery: { id: "recovery-1", status, generation: 2 } });

      await expect(harness.service.handleOrderCompleted(event)).resolves.toEqual({
        kind: "ignored",
        reason: `terminal-${status.toLowerCase()}`,
      });
      expect(harness.checkoutRecovery.updateMany).not.toHaveBeenCalled();
      expect(harness.statusHistory.create).not.toHaveBeenCalled();
    },
  );

  it("does not write status history when the guarded completion update loses a race", async () => {
    const harness = createHarness({ updateCount: 0 });

    await expect(harness.service.handleOrderCompleted(event)).resolves.toEqual({
      kind: "ignored",
      reason: "already-transitioned",
    });
    expect(harness.statusHistory.create).not.toHaveBeenCalled();
  });
});