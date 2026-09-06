import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InternationalContext } from "@modainteract/moda-interact-shared/internationalization";

type Candidate = {
  shopId: string;
  shopDomain: string;
  checkoutToken: string;
  cartToken: string | null;
  abandonedCheckoutUrl: string | null;
  checkoutCreatedAt: string | null;
  internationalContext?: InternationalContext;
  lastActivityAt?: string;
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
    expect(result.candidate).toEqual(expect.objectContaining({
      shopId: "shop_1",
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_1",
      cartToken: "cart_1",
      abandonedCheckoutUrl: "https://shop.example/recover",
      checkoutCreatedAt: "2026-08-28T00:00:00Z",
      lastActivityAt: expect.any(String),
    }));
  });

  it("preserves known context when a checkout update supplies only nulls", async () => {
    const initialContext: InternationalContext = {
      languageTag: "en-GB",
      languageSource: "shopify",
      countryCode: "GB",
      currencyCode: "GBP",
      timeZone: "Europe/London",
    };
    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_context_nulls",
      cartToken: "cart_context_nulls",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: "2026-08-28T00:00:00Z",
      internationalContext: initialContext,
      legacyV1Transition: null,
    });

    const refreshed = await serviceModule.pendingRecoveryCandidateService.refreshCandidateActivity({
      shopId: "shop_1",
      checkoutToken: "checkout_context_nulls",
      cartToken: "cart_context_nulls",
      activityAt: "2026-09-06T00:01:00Z",
      isEmpty: false,
      internationalContext: {
        languageTag: null,
        languageSource: null,
        countryCode: null,
        currencyCode: null,
        timeZone: null,
      },
    });

    expect(refreshed).toMatchObject({ outcome: "rescheduled", jobId: result.jobId });
    expect(queueInstance.jobs.get(result.jobId)?.updatedData?.internationalContext).toEqual(
      initialContext,
    );
  });

  it("merges newer non-null context dimensions without erasing others", async () => {
    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_context_merge",
      cartToken: "cart_context_merge",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: "2026-09-06T00:00:00Z",
      internationalContext: {
        languageTag: "en-GB",
        languageSource: "shopify",
        countryCode: "GB",
        currencyCode: "GBP",
        timeZone: "Europe/London",
      },
      legacyV1Transition: null,
    });

    await serviceModule.pendingRecoveryCandidateService.refreshCandidateActivity({
      shopId: "shop_1",
      checkoutToken: "checkout_context_merge",
      cartToken: "cart_context_merge",
      activityAt: "2026-09-06T00:01:00Z",
      isEmpty: false,
      internationalContext: {
        languageTag: "fr-FR",
        languageSource: "shopify",
        countryCode: null,
        currencyCode: "EUR",
        timeZone: null,
      },
    });

    expect(queueInstance.jobs.get(result.jobId)?.updatedData?.internationalContext).toEqual({
      languageTag: "fr-FR",
      languageSource: "shopify",
      countryCode: "GB",
      currencyCode: "EUR",
      timeZone: "Europe/London",
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

  it("removes the old cart alias when checkout scheduling changes cart token", async () => {
    const first = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_cart_change",
      cartToken: "cart_old",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
      activityAt: "2026-08-28T00:00:00.000Z",
      legacyV1Transition: null,
    });

    const second = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_cart_change",
      cartToken: "cart_new",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
      activityAt: "2026-08-28T01:00:00.000Z",
      legacyV1Transition: null,
    });

    expect(second.jobId).toBe(first.jobId);
    expect(await serviceModule.pendingRecoveryCandidateService.findCandidateJobIdByCart({
      shopId: "shop_1",
      cartToken: "cart_old",
    })).toBeNull();
    expect(await serviceModule.pendingRecoveryCandidateService.findCandidateJobIdByCart({
      shopId: "shop_1",
      cartToken: "cart_new",
    })).toBe(first.jobId);
    expect(queueInstance.jobs.get(first.jobId)?.data.cartToken).toBe("cart_new");
  });

  it("does not move an existing candidate backwards on an older checkout event", async () => {
    const first = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_monotonic",
      cartToken: null,
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
      activityAt: "2026-08-28T02:00:00.000Z",
      legacyV1Transition: null,
    });
    const job = queueInstance.jobs.get(first.jobId)!;

    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_monotonic",
      cartToken: null,
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
      activityAt: "2026-08-28T01:00:00.000Z",
      legacyV1Transition: null,
    });

    expect(result.candidate.lastActivityAt).toBe("2026-08-28T02:00:00.000Z");
    expect(job.updatedData?.lastActivityAt).toBe("2026-08-28T02:00:00.000Z");
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

  it("reschedules from newer activity and leaves older activity stale", async () => {
    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_activity",
      cartToken: "cart_activity",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: "2026-08-28T00:00:00Z",
      activityAt: "2026-08-28T00:00:00.000Z",
      legacyV1Transition: null,
    });
    const job = queueInstance.jobs.get(result.jobId)!;
    const refreshed = await serviceModule.pendingRecoveryCandidateService.refreshCandidateActivity({
      shopId: "shop_1",
      checkoutToken: null,
      cartToken: "cart_activity",
      activityAt: "2026-08-28T01:00:00.000Z",
      isEmpty: false,
    });

    expect(refreshed.outcome).toBe("rescheduled");
    expect(job.updatedData?.lastActivityAt).toBe("2026-08-28T01:00:00.000Z");
    expect(job.delayChanges.at(-1)).toBe(0);
    expect(redisZsets.get(domainModule.pendingCandidateShopIndexKey("shop_1"))?.get(result.jobId)).toBe(
      Date.parse("2026-08-28T01:45:00.000Z"),
    );

    const stale = await serviceModule.pendingRecoveryCandidateService.refreshCandidateActivity({
      shopId: "shop_1",
      checkoutToken: "checkout_activity",
      cartToken: null,
      activityAt: "2026-08-28T00:30:00.000Z",
      isEmpty: null,
    });
    expect(stale).toMatchObject({ outcome: "stale", jobId: result.jobId });
    expect(job.delayChanges).toHaveLength(1);
  });

  it("does not let a stale empty-cart event cancel newer activity", async () => {
    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_stale_empty",
      cartToken: "cart_stale_empty",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
      activityAt: "2026-08-28T02:00:00.000Z",
      legacyV1Transition: null,
    });

    const stale = await serviceModule.pendingRecoveryCandidateService.refreshCandidateActivity({
      shopId: "shop_1",
      checkoutToken: null,
      cartToken: "cart_stale_empty",
      activityAt: "2026-08-28T01:00:00.000Z",
      isEmpty: true,
    });

    expect(stale).toMatchObject({ outcome: "stale", jobId: result.jobId });
    expect(queueInstance.jobs.get(result.jobId)?.removed).toBe(false);
    expect(await serviceModule.pendingRecoveryCandidateService.findCandidateJobIdByCart({
      shopId: "shop_1",
      cartToken: "cart_stale_empty",
    })).toBe(result.jobId);
    expect(redisZsets.get(domainModule.pendingCandidateShopIndexKey("shop_1"))?.has(result.jobId)).toBe(true);
  });

  it("locks activity mutation and re-resolves after lock acquisition", async () => {
    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_lock",
      cartToken: "cart_lock",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
      activityAt: "2026-08-28T00:00:00.000Z",
      legacyV1Transition: null,
    });
    const lockSpy = vi
      .spyOn(serviceModule.pendingRecoveryCandidateService, "withCheckoutLock")
      .mockImplementation(async (_shopId, _checkoutToken, callback) => {
        queueInstance.jobs.delete(result.jobId);
        return callback();
      });

    const refreshed = await serviceModule.pendingRecoveryCandidateService.refreshCandidateActivity({
      shopId: "shop_1",
      checkoutToken: "checkout_lock",
      cartToken: null,
      activityAt: "2026-08-28T01:00:00.000Z",
      isEmpty: false,
    });

    expect(lockSpy).toHaveBeenCalledWith("shop_1", "checkout_lock", expect.any(Function));
    expect(refreshed).toEqual({ outcome: "not-found" });
    lockSpy.mockRestore();
  });

  it.each(["delayed", "waiting", "active", "failed", "completed", "missing"] as const)(
    "returns the bounded refresh result for a %s candidate",
    async (state) => {
      const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
        shopDomain: "shop.myshopify.com",
        checkoutToken: `checkout-state-${state}`,
        cartToken: null,
        abandonedCheckoutUrl: null,
        checkoutCreatedAt: null,
        activityAt: "2026-08-28T00:00:00.000Z",
        legacyV1Transition: null,
      });
      const job = queueInstance.jobs.get(result.jobId)!;
      if (state === "missing") {
        queueInstance.jobs.delete(result.jobId);
      } else {
        job.state = state;
      }

      const refreshed = await serviceModule.pendingRecoveryCandidateService.refreshCandidateActivity({
        shopId: "shop_1",
        checkoutToken: `checkout-state-${state}`,
        cartToken: null,
        activityAt: "2026-08-28T01:00:00.000Z",
        isEmpty: false,
      });

      if (state === "delayed") {
        expect(refreshed.outcome).toBe("rescheduled");
      } else if (state === "missing") {
        expect(refreshed).toEqual({ outcome: "not-found" });
      } else {
        expect(refreshed).toEqual({ outcome: "not-reschedulable", state, jobId: result.jobId });
      }
    },
  );

  it("cancels a matched cart candidate and removes every alias", async () => {
    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_empty",
      cartToken: "cart_empty",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
      activityAt: "2026-08-28T00:00:00.000Z",
      legacyV1Transition: null,
    });

    const cancelled = await serviceModule.pendingRecoveryCandidateService.refreshCandidateActivity({
      shopId: "shop_1",
      checkoutToken: null,
      cartToken: "cart_empty",
      activityAt: "2026-08-28T00:01:00.000Z",
      isEmpty: true,
    });

    expect(cancelled).toEqual({ outcome: "cancelled", jobId: result.jobId });
    expect(queueInstance.jobs.get(result.jobId)?.removed).toBe(true);
    expect(await serviceModule.pendingRecoveryCandidateService.findCandidateJobIdByCheckout({
      shopId: "shop_1",
      checkoutToken: "checkout_empty",
    })).toBeNull();
    expect(await serviceModule.pendingRecoveryCandidateService.findCandidateJobIdByCart({
      shopId: "shop_1",
      cartToken: "cart_empty",
    })).toBeNull();
  });

  it.each(["delayed", "waiting"] as const)(
    "cancels a cart candidate in the supported %s state",
    async (state) => {
      const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
        shopDomain: "shop.myshopify.com",
        checkoutToken: `checkout-cancel-${state}`,
        cartToken: `cart-cancel-${state}`,
        abandonedCheckoutUrl: null,
        checkoutCreatedAt: null,
        activityAt: "2026-08-28T00:00:00.000Z",
        legacyV1Transition: null,
      });
      queueInstance.jobs.get(result.jobId)!.state = state;

      await expect(serviceModule.pendingRecoveryCandidateService.cancelCandidateByCart({
        shopId: "shop_1",
        cartToken: `cart-cancel-${state}`,
      })).resolves.toEqual({ outcome: "cancelled", jobId: result.jobId });
      expect(queueInstance.jobs.get(result.jobId)?.removed).toBe(true);
    },
  );

  it("does not mutate an unmatched cart or non-delayed candidate", async () => {
    expect(await serviceModule.pendingRecoveryCandidateService.refreshCandidateActivity({
      shopId: "shop_1",
      checkoutToken: null,
      cartToken: "missing-cart",
      activityAt: "2026-08-28T00:01:00.000Z",
      isEmpty: false,
    })).toEqual({ outcome: "not-found" });

    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_waiting",
      cartToken: "cart_waiting",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
      activityAt: "2026-08-28T00:00:00.000Z",
      legacyV1Transition: null,
    });
    const job = queueInstance.jobs.get(result.jobId)!;
    job.state = "active";

    expect(await serviceModule.pendingRecoveryCandidateService.refreshCandidateActivity({
      shopId: "shop_1",
      checkoutToken: "checkout_waiting",
      cartToken: null,
      activityAt: "2026-08-28T01:00:00.000Z",
      isEmpty: false,
    })).toEqual({ outcome: "not-reschedulable", state: "active", jobId: result.jobId });
    expect(job.updatedData).toBeNull();
  });
});

