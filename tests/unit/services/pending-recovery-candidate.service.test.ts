import { beforeEach, describe, expect, it, vi } from "vitest";

type Candidate = {
  shopId: string;
  checkoutToken: string;
  cartToken: string | null;
  abandonedCheckoutUrl: string | null;
  checkoutCreatedAt: string | null;
};

class FakeJob {
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

const redisStore = new Map<string, string>();
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
    }
    return count;
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
    constructor() {
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
    redisMock.set.mockClear();
    redisMock.get.mockClear();
    redisMock.del.mockClear();
    prismaMock.shop.findUnique.mockClear();
    await serviceModule.resetPendingCandidateQueueForTests();
  });

  it("schedules a delayed candidate using recovery delay from shop settings", async () => {
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
    expect(result.candidate).toEqual({
      shopId: "shop_1",
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

    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_1",
      cartToken: "cart_2",
      abandonedCheckoutUrl: "https://shop.example/recover-2",
      checkoutCreatedAt: "2026-08-28T00:01:00Z",
      legacyV1Transition: null,
    });

    expect(result.outcome).toBe("refreshed");
    expect(queueInstance.addCalls).toHaveLength(1);

    const job = queueInstance.jobs.get(result.jobId);
    expect(job?.updatedData?.cartToken).toBe("cart_2");
    expect(job?.delayChanges).toEqual([45 * 60 * 1000]);
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
    );

    expect(
      await serviceModule.pendingRecoveryCandidateService.findCandidateJobIdByCheckout({
        shopId: "shop_1",
        checkoutToken: "checkout_1",
      }),
    ).toBeNull();
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
  });

  it("uses bounded TTL for redis indexes", async () => {
    const ttlMs = domainModule.pendingCandidateIndexTtlMs(45);
    expect(ttlMs).toBeGreaterThan(45 * 60 * 1000);
  });
});
