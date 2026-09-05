import { beforeEach, describe, expect, it, vi } from "vitest";

type Candidate = {
  shopId: string;
  shopDomain: string;
  checkoutToken: string;
  cartToken: string | null;
  abandonedCheckoutUrl: string | null;
  checkoutCreatedAt: string | null;
};

class FakeJob {
  id: string | undefined;
  data: Candidate;
  state: string;
  updatedData: Candidate | null = null;
  delayChanges: number[] = [];
  removed = false;

  constructor(data: Candidate, state = "delayed") {
    this.data = data;
    this.state = state;
  }

  async updateData(data: Candidate) {
    this.data = data;
    this.updatedData = data;
  }

  async getState() {
    return this.state;
  }

  async changeDelay(delay: number) {
    this.delayChanges.push(delay);
  }

  async remove() {
    this.removed = true;
  }
}

class FakeQueue {
  jobs = new Map<string, FakeJob>();
  addCalls: Array<{ jobName: string; data: Candidate; opts: { jobId: string; delay: number } }> = [];

  async add(
    jobName: string,
    data: Candidate,
    opts: { jobId: string; delay: number },
  ) {
    this.addCalls.push({ jobName, data, opts });
    const job = new FakeJob(data, "delayed");
    job.id = opts.jobId;
    this.jobs.set(opts.jobId, job);
    return job;
  }

  async getJob(jobId: string) {
    return this.jobs.get(jobId) ?? null;
  }

  async close() {
    this.jobs.clear();
  }
}

const queueInstance = new FakeQueue();
let queueOptions: Record<string, unknown> | null = null;

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
      if (redisStore.delete(key)) {
        count += 1;
      }
      if (redisZsets.delete(key)) {
        count += 1;
      }
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

const prismaMock = {
  shop: {
    findUnique: vi.fn(async () => ({
      id: "shop_1",
      settings: { recoveryDelayMinutes: 45 },
    })),
  },
};

vi.mock("bullmq", () => ({
  Queue: class {
    constructor(_name: string, options: Record<string, unknown>) {
      queueOptions = options;
      return queueInstance;
    }
  },
}));

vi.mock("../../../src/lib/redis.js", () => ({
  connectionRedis: redisMock,
}));

vi.mock("../../../src/lib/db.js", () => ({
  default: prismaMock,
}));

const serviceModule = await import(
  "../../../src/services/pending-recovery-candidate.service.js"
);

const domainModule = await import(
  "../../../src/domain/pending-recovery-candidate.js"
);

describe("pending recovery candidate service", () => {
  beforeEach(async () => {
    queueInstance.jobs.clear();
    queueInstance.addCalls.length = 0;
    redisStore.clear();
    redisZsets.clear();
    redisMock.set.mockClear();
    redisMock.get.mockClear();
    redisMock.del.mockClear();
    redisMock.zadd.mockClear();
    redisMock.zrem.mockClear();
    prismaMock.shop.findUnique.mockClear();
    await serviceModule.resetPendingCandidateQueueForTests();
  });

  it("schedules a delayed candidate using recovery delay from shop settings", async () => {
    const before = Date.now();
    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_1",
      cartToken: "cart_1",
      abandonedCheckoutUrl: "https://shop.example/recover",
      checkoutCreatedAt: "2026-08-28T00:00:00Z",
      legacyV1Transition: null,
    });

    expect(result.outcome).toBe("enqueued");
    expect(result.delayMinutes).toBe(45);
    expect(queueInstance.addCalls).toHaveLength(1);
    expect(queueInstance.addCalls[0].opts.delay).toBe(45 * 60 * 1000);
    expect(queueInstance.addCalls[0].data).toBe(result.candidate);
    const shopIndex = redisZsets.get(
      domainModule.pendingCandidateShopIndexKey("shop_1"),
    );
    expect(shopIndex?.get(result.jobId)).toBeGreaterThanOrEqual(
      before + 45 * 60 * 1000,
    );
    expect(queueOptions).toMatchObject({
      telemetry: expect.any(Object),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 1_000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    });
    expect(result.candidate).toEqual({
      shopId: "shop_1",
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_1",
      cartToken: "cart_1",
      abandonedCheckoutUrl: "https://shop.example/recover",
      checkoutCreatedAt: "2026-08-28T00:00:00Z",
    });
  });

  it("refreshes an existing delayed candidate idempotently", async () => {
    await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_1",
      cartToken: "cart_1",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: "2026-08-28T00:00:00Z",
      legacyV1Transition: null,
    });

    const shopIndexKey = domainModule.pendingCandidateShopIndexKey("shop_1");
    const firstJobId = [...(redisZsets.get(shopIndexKey)?.keys() ?? [])][0] ?? null;
    const firstScore = redisZsets.get(shopIndexKey)?.get(firstJobId!);
    const refreshedAt = Date.now() + 60_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(refreshedAt);
    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_1",
      cartToken: "cart_2",
      abandonedCheckoutUrl: "https://shop.example/recover-2",
      checkoutCreatedAt: "2026-08-28T00:01:00Z",
      legacyV1Transition: null,
    });
    nowSpy.mockRestore();

    expect(result.outcome).toBe("refreshed");
    expect(queueInstance.addCalls).toHaveLength(1);
    expect(queueInstance.addCalls[0].opts.jobId).toMatch(/^shop_1--pending-recovery-/);

    const job = queueInstance.jobs.get(result.jobId);
    expect(job?.updatedData?.cartToken).toBe("cart_2");
    expect(job?.delayChanges).toEqual([45 * 60 * 1000]);
    expect(firstJobId).toBe(result.jobId);
    expect(redisZsets.get(shopIndexKey)?.get(result.jobId)).toBe(
      refreshedAt + 45 * 60 * 1000,
    );
    expect(redisZsets.get(shopIndexKey)?.get(result.jobId)).toBeGreaterThan(firstScore!);
  });

  it("reuses a legacy candidate ID during the rollout without duplicating work", async () => {
    const { createPendingRecoveryCandidateJobId } = await import(
      "@modainteract/moda-interact-shared/shopify/node"
    );
    const legacyJobId = createPendingRecoveryCandidateJobId("shop_1", "checkout_legacy");
    const legacyJob = new FakeJob({
      shopId: "shop_1",
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_legacy",
      cartToken: null,
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
    });
    queueInstance.jobs.set(legacyJobId, legacyJob);

    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "SHOP.MYSHOPIFY.COM",
      checkoutToken: "checkout_legacy",
      cartToken: null,
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
      legacyV1Transition: null,
    });

    expect(result.outcome).toBe("refreshed");
    expect(result.jobId).toBe(legacyJobId);
    expect(queueInstance.addCalls).toHaveLength(0);
    expect(legacyJob.updatedData?.shopDomain).toBe("shop.myshopify.com");
  });

  it.each(["delayed", "waiting", "active"])(
    "keeps a %s job in the shop index",
    async (state) => {
      const { createPendingRecoveryCandidateJobId } = await import(
        "@modainteract/moda-interact-shared/shopify/node"
      );
      const candidate = {
        shopId: "shop_1",
        shopDomain: "shop.myshopify.com",
        checkoutToken: `checkout-${state}`,
        cartToken: null,
        abandonedCheckoutUrl: null,
        checkoutCreatedAt: null,
      };
      const jobId = `shop_1--${createPendingRecoveryCandidateJobId("shop_1", candidate.checkoutToken)}`;
      const job = new FakeJob(candidate, state);
      job.id = jobId;
      queueInstance.jobs.set(jobId, job);

      const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
        shopDomain: candidate.shopDomain,
        checkoutToken: candidate.checkoutToken,
        cartToken: null,
        abandonedCheckoutUrl: null,
        checkoutCreatedAt: null,
        legacyV1Transition: null,
      });

      expect(result.jobId).toBe(jobId);
      expect(redisZsets.get(domainModule.pendingCandidateShopIndexKey("shop_1"))?.has(jobId)).toBe(true);
    },
  );

  it("removes a retained failed job from the shop index without re-adding it", async () => {
    const { createPendingRecoveryCandidateJobId } = await import(
      "@modainteract/moda-interact-shared/shopify/node"
    );
    const candidate = {
      shopId: "shop_1",
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout-failed",
      cartToken: null,
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
    };
    const jobId = `shop_1--${createPendingRecoveryCandidateJobId("shop_1", candidate.checkoutToken)}`;
    const job = new FakeJob(candidate, "failed");
    job.id = jobId;
    queueInstance.jobs.set(jobId, job);
    await redisMock.zadd(domainModule.pendingCandidateShopIndexKey("shop_1"), Date.now(), jobId);

    await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: candidate.shopDomain,
      checkoutToken: candidate.checkoutToken,
      cartToken: null,
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
      legacyV1Transition: null,
    });

    expect(redisZsets.get(domainModule.pendingCandidateShopIndexKey("shop_1"))?.has(jobId) ?? false).toBe(false);
    expect(redisMock.zadd).toHaveBeenCalledTimes(1);
  });

  it("does not delete the shop index after removing its final member", async () => {
    const shopIndexKey = domainModule.pendingCandidateShopIndexKey("shop_1");
    await redisMock.zadd(shopIndexKey, Date.now(), "job-1");

    await serviceModule.pendingRecoveryCandidateService.handleCandidateMatured(
      {
        shopId: "shop_1",
        shopDomain: "shop.myshopify.com",
        checkoutToken: "checkout-cleanup",
        cartToken: null,
        abandonedCheckoutUrl: null,
        checkoutCreatedAt: null,
      },
      "job-1",
    );

    expect(redisMock.zrem).toHaveBeenCalledWith(shopIndexKey, "job-1");
    expect(redisMock.del).not.toHaveBeenCalledWith(shopIndexKey);
  });

  it("removes the stale legacy member when both job IDs exist", async () => {
    const { createPendingRecoveryCandidateJobId } = await import(
      "@modainteract/moda-interact-shared/shopify/node"
    );
    const legacyJobId = createPendingRecoveryCandidateJobId("shop_1", "checkout_both");
    const activeJobId = `shop_1--${legacyJobId}`;
    const candidate = {
      shopId: "shop_1",
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_both",
      cartToken: null,
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
    };
    const legacyJob = new FakeJob(candidate);
    const activeJob = new FakeJob(candidate);
    activeJob.id = activeJobId;
    queueInstance.jobs.set(legacyJobId, legacyJob);
    queueInstance.jobs.set(activeJobId, activeJob);
    await redisMock.zadd(domainModule.pendingCandidateShopIndexKey("shop_1"), Date.now(), legacyJobId);
    await redisMock.zadd(domainModule.pendingCandidateShopIndexKey("shop_1"), Date.now(), activeJobId);

    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_both",
      cartToken: null,
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
      legacyV1Transition: null,
    });

    expect(result.jobId).toBe(activeJobId);
    expect(legacyJob.removed).toBe(true);
    expect(redisZsets.get(domainModule.pendingCandidateShopIndexKey("shop_1"))).toEqual(
      new Map([[activeJobId, expect.any(Number)]]),
    );
  });

  it("provides O(1) checkout/cart lookup and cleans indexes on maturation", async () => {
    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_1",
      cartToken: "cart_1",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: "2026-08-28T00:00:00Z",
      legacyV1Transition: null,
    });

    const checkoutJobId = await serviceModule.pendingRecoveryCandidateService.findCandidateJobIdByCheckout(
      {
        shopId: "shop_1",
        checkoutToken: "checkout_1",
      },
    );

    const cartJobId = await serviceModule.pendingRecoveryCandidateService.findCandidateJobIdByCart(
      {
        shopId: "shop_1",
        cartToken: "cart_1",
      },
    );

    expect(checkoutJobId).toBe(result.jobId);
    expect(cartJobId).toBe(result.jobId);

    await serviceModule.pendingRecoveryCandidateService.handleCandidateMatured(
      result.candidate,
      result.jobId,
    );

    expect(
      await serviceModule.pendingRecoveryCandidateService.findCandidateJobIdByCheckout({
        shopId: "shop_1",
        checkoutToken: "checkout_1",
      }),
    ).toBeNull();
    expect(redisZsets.has(domainModule.pendingCandidateShopIndexKey("shop_1"))).toBe(false);
  });

  it("cleans checkout index on cancellation", async () => {
    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_1",
      cartToken: null,
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: "2026-08-28T00:00:00Z",
      legacyV1Transition: null,
    });

    const removed =
      await serviceModule.pendingRecoveryCandidateService.cancelCandidateByCheckout({
        shopId: "shop_1",
        checkoutToken: "checkout_1",
      });

    expect(removed).toEqual({ removed: true });
    expect(queueInstance.jobs.get(result.jobId)?.removed).toBe(true);
    expect(redisZsets.has(domainModule.pendingCandidateShopIndexKey("shop_1"))).toBe(false);
  });

  it("keeps different shops in separate ordered indexes", async () => {
    prismaMock.shop.findUnique
      .mockResolvedValueOnce({ id: "shop_1", settings: { recoveryDelayMinutes: 45 } })
      .mockResolvedValueOnce({ id: "shop_2", settings: { recoveryDelayMinutes: 10 } });

    const first = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_1",
      cartToken: null,
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
      legacyV1Transition: null,
    });
    const second = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_2",
      cartToken: null,
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
      legacyV1Transition: null,
    });

    expect(redisZsets.get(domainModule.pendingCandidateShopIndexKey("shop_1"))?.has(first.jobId)).toBe(true);
    expect(redisZsets.get(domainModule.pendingCandidateShopIndexKey("shop_1"))?.has(second.jobId)).toBe(false);
    expect(redisZsets.get(domainModule.pendingCandidateShopIndexKey("shop_2"))?.has(second.jobId)).toBe(true);
  });

  it("keeps cleanup idempotent when the shop member is already absent", async () => {
    await expect(
      serviceModule.pendingRecoveryCandidateService.handleCandidateMatured(
        {
          shopId: "shop_1",
          shopDomain: "shop.myshopify.com",
          checkoutToken: "missing",
          cartToken: null,
          abandonedCheckoutUrl: null,
          checkoutCreatedAt: null,
        },
        "missing-job",
      ),
    ).resolves.toEqual(expect.objectContaining({ checkoutToken: "missing" }));
  });

  it("uses bounded TTL for redis indexes", async () => {
    const ttlMs = domainModule.pendingCandidateIndexTtlMs(45);
    expect(ttlMs).toBeGreaterThan(45 * 60 * 1000);
  });

  it("resolves a candidate by cart-token fallback without scanning the queue", async () => {
    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_1",
      cartToken: "cart_9",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: "2026-08-28T00:00:00Z",
      legacyV1Transition: null,
    });

    // No checkout token supplied: fall back to the indexed cart correlation.
    const matched = await serviceModule.pendingRecoveryCandidateService.resolveCandidate({
      shopId: "shop_1",
      checkoutToken: null,
      cartToken: "cart_9",
    });

    expect(matched).not.toBeNull();
    expect(matched?.jobId).toBe(result.jobId);
    expect(matched?.candidate.checkoutToken).toBe("checkout_1");
  });

  it("cancels a candidate and removes all its aliases (checkout and cart indexes)", async () => {
    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_1",
      cartToken: "cart_9",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: "2026-08-28T00:00:00Z",
      legacyV1Transition: null,
    });

    const matched = await serviceModule.pendingRecoveryCandidateService.resolveCandidate({
      shopId: "shop_1",
      checkoutToken: "checkout_1",
      cartToken: null,
    });

    expect(matched).not.toBeNull();

    await serviceModule.pendingRecoveryCandidateService.cancelCandidate(matched!);

    expect(
      await serviceModule.pendingRecoveryCandidateService.findCandidateJobIdByCheckout({
        shopId: "shop_1",
        checkoutToken: "checkout_1",
      }),
    ).toBeNull();
    expect(
      await serviceModule.pendingRecoveryCandidateService.findCandidateJobIdByCart({
        shopId: "shop_1",
        cartToken: "cart_9",
      }),
    ).toBeNull();
  });

  it("records and reads an order-completed tombstone scoped to the checkout", async () => {
    await serviceModule.pendingRecoveryCandidateService.markOrderProcessed("shop_1", "checkout_1");

    expect(
      await serviceModule.pendingRecoveryCandidateService.hasOrderProcessed("shop_1", "checkout_1"),
    ).toBe(true);
    expect(
      await serviceModule.pendingRecoveryCandidateService.hasOrderProcessed("shop_1", "checkout_2"),
    ).toBe(false);
  });
});

