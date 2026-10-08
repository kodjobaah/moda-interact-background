import { beforeEach, describe, expect, it, vi } from "vitest";

const redisStore = new Map<string, string>();
const redisZsets = new Map<string, Map<string, number>>();
const redisMock = {
  set: vi.fn(async (key: string, value: string) => {
    redisStore.set(key, value);
    return "OK";
  }),
  get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
  del: vi.fn(async (...keys: string[]) => {
    let count = 0;
    for (const key of keys) {
      if (redisStore.delete(key)) count += 1;
    }
    return count;
  }),
  zadd: vi.fn(async (key: string, score: number, member: string) => {
    const zset = redisZsets.get(key) ?? new Map<string, number>();
    zset.set(member, score);
    redisZsets.set(key, zset);
    return 1;
  }),
  zrem: vi.fn(async (key: string, member: string) => {
    const zset = redisZsets.get(key);
    if (!zset?.delete(member)) return 0;
    if (zset.size === 0) redisZsets.delete(key);
    return 1;
  }),
};

vi.mock("../../../../src/lib/redis.js", () => ({
  connectionRedis: redisMock,
}));

const { PendingRecoveryCandidateIndexStore } = await import(
  "../../../../src/services/pending-recovery-candidate/candidate-index.store.js"
);
const domain = await import(
  "../../../../src/domain/pending-recovery-candidate.js"
);

const candidate = {
  shopId: "shop-1",
  shopDomain: "shop.myshopify.com",
  checkoutToken: "checkout-1",
  cartToken: "cart-1",
  abandonedCheckoutUrl: null,
  checkoutCreatedAt: null,
  lastActivityAt: "2026-10-08T09:00:00.000Z",
};

describe("PendingRecoveryCandidateIndexStore", () => {
  beforeEach(() => {
    redisStore.clear();
    redisZsets.clear();
    for (const mock of Object.values(redisMock)) mock.mockClear();
  });

  it("writes checkout, cart and shop indexes with the bounded candidate TTL", async () => {
    const store = new PendingRecoveryCandidateIndexStore();
    const delayMinutes = 45;
    const dueAtMs = Date.parse("2026-10-08T10:00:00.000Z");

    await store.upsert({
      candidate,
      jobId: "job-1",
      delayMinutes,
      dueAtMs,
      shouldIndexShop: true,
    });

    await expect(store.findByCheckout({
      shopId: "shop-1",
      checkoutToken: "checkout-1",
    })).resolves.toBe("job-1");
    await expect(store.findByCart({
      shopId: "shop-1",
      cartToken: "cart-1",
    })).resolves.toBe("job-1");

    const ttlMs = domain.pendingCandidateIndexTtlMs(delayMinutes);
    expect(redisMock.set).toHaveBeenCalledWith(
      domain.pendingCandidateCheckoutIndexKey({
        shopId: "shop-1",
        checkoutToken: "checkout-1",
      }),
      "job-1",
      "PX",
      ttlMs,
    );
    expect(redisMock.set).toHaveBeenCalledWith(
      domain.pendingCandidateCartIndexKey({
        shopId: "shop-1",
        cartToken: "cart-1",
      }),
      "job-1",
      "PX",
      ttlMs,
    );
    expect(redisZsets.get(domain.pendingCandidateShopIndexKey("shop-1"))).toEqual(
      new Map([["job-1", dueAtMs]]),
    );
  });

  it("removes the shop member instead of re-indexing non-runnable work", async () => {
    const store = new PendingRecoveryCandidateIndexStore();
    redisZsets.set(
      domain.pendingCandidateShopIndexKey("shop-1"),
      new Map([["job-1", 1]]),
    );

    await store.upsert({
      candidate,
      jobId: "job-1",
      delayMinutes: 45,
      dueAtMs: 2,
      shouldIndexShop: false,
    });

    expect(redisZsets.has(domain.pendingCandidateShopIndexKey("shop-1"))).toBe(false);
  });

  it("removes checkout, cart and optional shop aliases idempotently", async () => {
    const store = new PendingRecoveryCandidateIndexStore();
    await store.upsert({
      candidate,
      jobId: "job-1",
      delayMinutes: 45,
      dueAtMs: 1,
      shouldIndexShop: true,
    });

    await expect(store.remove(candidate, "job-1")).resolves.toBeUndefined();
    await expect(store.remove(candidate, "job-1")).resolves.toBeUndefined();

    await expect(store.findByCheckout({
      shopId: "shop-1",
      checkoutToken: "checkout-1",
    })).resolves.toBeNull();
    await expect(store.findByCart({
      shopId: "shop-1",
      cartToken: "cart-1",
    })).resolves.toBeNull();
    expect(redisZsets.has(domain.pendingCandidateShopIndexKey("shop-1"))).toBe(false);
  });

  it("can remove only a stale cart alias when a checkout changes cart token", async () => {
    const store = new PendingRecoveryCandidateIndexStore();
    redisStore.set(
      domain.pendingCandidateCartIndexKey({ shopId: "shop-1", cartToken: "old-cart" }),
      "job-1",
    );

    await store.removeCartAlias("shop-1", "old-cart");

    await expect(store.findByCart({
      shopId: "shop-1",
      cartToken: "old-cart",
    })).resolves.toBeNull();
  });
});
