import { beforeEach, describe, vi } from "vitest";
import type { InternationalContext } from "@modainteract/moda-interact-shared/internationalization";
import { registerSchedulingCases } from "./pending-recovery-candidate/facade-scheduling.cases.js";
import { registerCompatibilityCases } from "./pending-recovery-candidate/facade-compatibility.cases.js";
import { registerActivityCases } from "./pending-recovery-candidate/facade-activity.cases.js";

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
      status: "ACTIVE",
      settings: { recoveryDelayMinutes: 45 },
    })),
  },
};

const recoveryPolicyMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

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

vi.mock("../../../src/services/recovery-policy.service.js", () => ({
  recoveryPolicyService: {
    resolve: recoveryPolicyMocks.resolve,
  },
}));

const serviceModule = await import(
  "../../../src/services/pending-recovery-candidate.service.js"
);

const domainModule = await import(
  "../../../src/domain/pending-recovery-candidate.js"
);

const facadeContext = {
  FakeJob,
  queueInstance,
  getQueueOptions: () => queueOptions,
  redisZsets,
  redisMock,
  prismaMock,
  recoveryPolicyMocks,
  serviceModule,
  domainModule,
};

// Type-only import by the cases modules. No runtime circular dependency.
export type CandidateFacadeContext = typeof facadeContext;

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
    recoveryPolicyMocks.resolve.mockReset();
    recoveryPolicyMocks.resolve.mockResolvedValue({
      recoveryDelayMinutes: 45,
      recoveryOfferMode: "NONE",
      fixedShopifyDiscountId: null,
      followUpEnabled: false,
      followUpDelayMinutes: null,
      source: "MERCHANT",
      offerSnapshot: null,
    });
    await serviceModule.resetPendingCandidateQueueForTests();
  });

  registerSchedulingCases(facadeContext);
  registerCompatibilityCases(facadeContext);
  registerActivityCases(facadeContext);
});
