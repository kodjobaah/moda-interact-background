import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/lib/redis.js", () => ({ connectionRedis: {} }));
const { WooCheckoutLeaseGuard } = await import(
  "../../../../src/services/pending-recovery-candidate/checkout-order-guard.service.js"
);

function redisHarness() {
  const owned = new Map<string, { token: string; expiresAt: number }>();
  const set = vi.fn(async (key: string, token: string, mode: string, ttl: number, guard: string) => {
    expect([mode, guard]).toEqual(["PX", "NX"]);
    const previous = owned.get(key);
    if (previous && previous.expiresAt > Date.now()) return null;
    owned.set(key, { token, expiresAt: Date.now() + ttl });
    return "OK";
  });
  const evalScript = vi.fn(async (script: string, count: number, key: string, token: string, ttl?: string) => {
    expect(count).toBe(1);
    const previous = owned.get(key);
    if (!previous || previous.expiresAt <= Date.now() || previous.token !== token) return 0;
    if (script.includes("PEXPIRE")) {
      previous.expiresAt = Date.now() + Number(ttl);
      return 1;
    }
    if (script.includes("DEL")) {
      owned.delete(key);
      return 1;
    }
    throw new Error("unexpected-script");
  });
  return { owned, redis: { set, eval: evalScript } };
}

describe("ARCH-048-BACKGROUND-002 renewable checkout-scoped lock", () => {
  afterEach(() => vi.useRealTimers());

  it("atomically releases only the current owner", async () => {
    const h = redisHarness();
    const guard = new WooCheckoutLeaseGuard(h.redis as never);
    await expect(guard.withCheckoutLock("shop-1", "private-token", async () => 42))
      .resolves.toBe(42);
    expect(h.owned.size).toBe(0);
    expect(h.redis.eval).toHaveBeenCalledWith(expect.stringContaining("DEL"), 1,
      expect.any(String), expect.any(String));
  });

  it("does not release a successor lease even if the previous owner finishes after expiry", async () => {
    const h = redisHarness();
    const guard = new WooCheckoutLeaseGuard(h.redis as never);
    await expect(guard.withCheckoutLock("shop-1", "private-token", async () => {
      const [key] = [...h.owned.keys()];
      h.owned.set(key!, { token: "second-owner", expiresAt: Date.now() + 10_000 });
    })).rejects.toThrow("woo-checkout-lock-lease-lost");
    expect([...h.owned.values()][0]?.token).toBe("second-owner");
  });

  it("renews a held lease for a callback longer than ten seconds", async () => {
    vi.useFakeTimers();
    const h = redisHarness();
    const guard = new WooCheckoutLeaseGuard(h.redis as never);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const run = guard.withCheckoutLock("shop-1", "private-token", async () => {
      await pending;
      return "done";
    });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(h.redis.eval.mock.calls.filter(call => call[0].includes("PEXPIRE")).length).toBeGreaterThanOrEqual(6);
    expect([...h.owned.values()][0]?.expiresAt).toBeGreaterThan(Date.now());
    finish();
    await expect(run).resolves.toBe("done");
    expect(h.owned.size).toBe(0);
  });

  it("propagates Redis renewal failures instead of acknowledging the guarded callback", async () => {
    vi.useFakeTimers();
    const h = redisHarness();
    const guard = new WooCheckoutLeaseGuard(h.redis as never);
    const failure = new Error("redis-renew-unavailable");
    h.redis.eval.mockRejectedValueOnce(failure);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const result = guard.withCheckoutLock("shop-1", "private-token", async () => {
      await pending;
      return true;
    });
    await vi.advanceTimersByTimeAsync(3_001);
    finish();
    await expect(result).rejects.toBe(failure);
  });

  it("retains both primary and cleanup errors when ownership release also fails", async () => {
    const h = redisHarness();
    const guard = new WooCheckoutLeaseGuard(h.redis as never);
    const primary = new Error("business-failure");
    const cleanup = new Error("redis-release-failure");
    h.redis.eval.mockRejectedValueOnce(cleanup);
    await expect(guard.withCheckoutLock("shop-1", "private-token", async () => {
      throw primary;
    })).rejects.toMatchObject({
      name: "AggregateError", cause: primary,
      errors: [primary, cleanup],
    });
  });

  it("propagates lock acquisition errors without running the callback", async () => {
    const h = redisHarness();
    const guard = new WooCheckoutLeaseGuard(h.redis as never);
    const failure = new Error("redis-set-unavailable");
    h.redis.set.mockRejectedValueOnce(failure);
    const run = vi.fn(async () => undefined);
    await expect(guard.withCheckoutLock("shop-1", "private-token", run)).rejects.toBe(failure);
    expect(run).not.toHaveBeenCalled();
  });

  it("uses the narrow (shop, checkout) key instead of one global or shop-only mutex", async () => {
    const h = redisHarness();
    const guard = new WooCheckoutLeaseGuard(h.redis as never);
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const first = guard.withCheckoutLock("shop-1", "checkout-a", async () => {
      markStarted();
      await wait;
    });
    await started;
    await expect(guard.withCheckoutLock("shop-1", "checkout-b", async () => "other-checkout"))
      .resolves.toBe("other-checkout");
    release();
    await first;
  });
});
