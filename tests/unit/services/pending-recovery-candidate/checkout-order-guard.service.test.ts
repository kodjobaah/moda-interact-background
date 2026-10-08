import { beforeEach, describe, expect, it, vi } from "vitest";

let lockValue: string | null = null;
const redisStore = new Map<string, string>();
const redisMock = {
  set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
    if (args.includes("NX")) {
      if (lockValue !== null) return null;
      lockValue = value;
      return "OK";
    }
    redisStore.set(key, value);
    return "OK";
  }),
  get: vi.fn(async (key: string) => {
    if (key.includes("lock")) return lockValue;
    return redisStore.get(key) ?? null;
  }),
  del: vi.fn(async (key: string) => {
    if (key.includes("lock")) {
      lockValue = null;
      return 1;
    }
    return redisStore.delete(key) ? 1 : 0;
  }),
};

vi.mock("../../../../src/lib/redis.js", () => ({
  connectionRedis: redisMock,
}));

const { CheckoutOrderGuardService } = await import(
  "../../../../src/services/pending-recovery-candidate/checkout-order-guard.service.js"
);
const domain = await import(
  "../../../../src/domain/pending-recovery-candidate.js"
);

describe("CheckoutOrderGuardService", () => {
  beforeEach(() => {
    lockValue = null;
    redisStore.clear();
    redisMock.set.mockClear();
    redisMock.get.mockClear();
    redisMock.del.mockClear();
  });

  it("runs the callback under the checkout lock and releases its own lock", async () => {
    const service = new CheckoutOrderGuardService();

    await expect(service.withCheckoutLock(
      "shop-1",
      "checkout-1",
      async () => "done",
    )).resolves.toBe("done");

    expect(redisMock.set).toHaveBeenCalledWith(
      domain.checkoutOrderLockKey({ shopId: "shop-1", checkoutToken: "checkout-1" }),
      expect.any(String),
      "PX",
      10_000,
      "NX",
    );
    expect(lockValue).toBeNull();
  });

  it("does not delete a lock after ownership has changed", async () => {
    const service = new CheckoutOrderGuardService();

    await service.withCheckoutLock("shop-1", "checkout-1", async () => {
      lockValue = "later-owner";
    });

    expect(lockValue).toBe("later-owner");
    expect(redisMock.del).not.toHaveBeenCalled();
  });

  it("records and reads an order-completed tombstone scoped to one checkout", async () => {
    const service = new CheckoutOrderGuardService();

    await service.markOrderProcessed("shop-1", "checkout-1");

    expect(redisMock.set).toHaveBeenCalledWith(
      domain.checkoutOrderCompletedKey({ shopId: "shop-1", checkoutToken: "checkout-1" }),
      "1",
      "PX",
      60 * 60 * 1000,
    );
    await expect(service.hasOrderProcessed("shop-1", "checkout-1")).resolves.toBe(true);
    await expect(service.hasOrderProcessed("shop-1", "checkout-2")).resolves.toBe(false);
  });
});
