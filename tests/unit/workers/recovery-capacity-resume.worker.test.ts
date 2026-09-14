import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  processor: undefined as undefined | ((job: { name: string; data: { shopId: string; trigger: string } }) => Promise<unknown>),
  active: true,
  recoveries: [] as Array<{ id: string }>,
  findMany: vi.fn(async () => hoisted.recoveries),
  resume: vi.fn(async () => ({ kind: "initiated" as const })),
  schedule: vi.fn(async () => "job-id"),
  evaluate: vi.fn(async () => ({ allowed: true as const, shopId: "shop-1" })),
}));

vi.mock("bullmq", () => ({
  Worker: class {
    constructor(_queue: string, processor: typeof hoisted.processor) {
      hoisted.processor = processor ?? undefined;
    }

    on() {
      return this;
    }
  },
}));
vi.mock("@modainteract/moda-interact-shared/observability/bullmq", () => ({
  createBullMQTelemetry: vi.fn(() => ({})),
}));
vi.mock("../../../src/lib/redis.js", () => ({ connectionRedis: {} }));
vi.mock("../../../src/lib/db.js", () => ({
  default: {
    shop: { findUnique: vi.fn(async () => ({ status: hoisted.active ? "ACTIVE" : "INACTIVE" })) },
    checkoutRecovery: { findMany: hoisted.findMany },
  },
}));
vi.mock("../../../src/services/checkout-recovery.service.js", () => ({
  checkoutRecoveryService: { resumeCapacityBlockedRecovery: hoisted.resume },
}));
vi.mock("../../../src/services/recovery-capacity-resume.service.js", () => ({
  recoveryCapacityResumeService: { schedule: hoisted.schedule },
}));
vi.mock("../../../src/services/shop-execution-eligibility.service.js", () => ({
  shopExecutionEligibilityService: { evaluate: hoisted.evaluate },
}));

import { RESUME_CAPACITY_BLOCKED_RECOVERIES_JOB } from "../../../src/domain/recovery-capacity-resume.js";
import "../../../src/workers/recovery-capacity-resume.worker.js";

describe("recovery capacity resume worker", () => {
  it.each([
    ["NO_CONTRACT", "CONTRACT_REQUIRED"],
    ["FROZEN", "SUBSCRIPTION_FROZEN"],
  ])("terminates a queued capacity-resume job before recovery lookup when execution is %s", async (_status, reason) => {
    hoisted.evaluate.mockResolvedValueOnce({ allowed: false, shopId: "shop-1", reason });
    hoisted.findMany.mockClear();
    hoisted.resume.mockClear();
    hoisted.schedule.mockClear();

    await expect(hoisted.processor?.({
      name: RESUME_CAPACITY_BLOCKED_RECOVERIES_JOB,
      data: { shopId: "shop-1", trigger: "repair" },
    })).resolves.toEqual({ kind: "ignored", reason });

    expect(hoisted.findMany).not.toHaveBeenCalled();
    expect(hoisted.resume).not.toHaveBeenCalled();
    expect(hoisted.schedule).not.toHaveBeenCalled();
  });

  it("queries the durable blocked FIFO without an id-range cursor", async () => {
    hoisted.recoveries = [{ id: "recovery-1" }];
    hoisted.findMany.mockClear();
    hoisted.resume.mockReset().mockResolvedValue({ kind: "initiated" });

    await hoisted.processor?.({
      name: RESUME_CAPACITY_BLOCKED_RECOVERIES_JOB,
      data: { shopId: "shop-1", trigger: "continuation-recovery-previous" },
    });

    expect(hoisted.findMany).toHaveBeenCalledWith({
      where: {
        shopId: "shop-1",
        status: "DETECTED",
        admissionBlockReason: "RECOVERY_CAPACITY_EXHAUSTED",
      },
      orderBy: [{ detectedAt: "asc" }, { id: "asc" }],
      take: 25,
      select: { id: true },
    });
  });

  it("processes a bounded FIFO batch and schedules a distinct continuation", async () => {
    hoisted.recoveries = Array.from({ length: 25 }, (_, index) => ({ id: `recovery-${index}` }));
    hoisted.resume.mockClear();
    hoisted.schedule.mockClear();
    hoisted.resume.mockResolvedValue({ kind: "initiated" });

    await hoisted.processor?.({
      name: RESUME_CAPACITY_BLOCKED_RECOVERIES_JOB,
      data: { shopId: "shop-1", trigger: "repair" },
    });

    expect(hoisted.resume).toHaveBeenCalledTimes(25);
    expect(hoisted.schedule).toHaveBeenCalledWith({
      shopId: "shop-1",
      trigger: "continuation-recovery-24",
    });
  });

  it("stops immediately when capacity is exhausted and does not continue", async () => {
    hoisted.recoveries = Array.from({ length: 25 }, (_, index) => ({ id: `recovery-${index}` }));
    hoisted.resume.mockReset();
    hoisted.resume
      .mockResolvedValueOnce({ kind: "initiated" })
      .mockResolvedValueOnce({ kind: "capacity-exhausted" });
    hoisted.schedule.mockClear();

    await hoisted.processor?.({
      name: RESUME_CAPACITY_BLOCKED_RECOVERIES_JOB,
      data: { shopId: "shop-1", trigger: "repair" },
    });

    expect(hoisted.resume).toHaveBeenCalledTimes(2);
    expect(hoisted.schedule).not.toHaveBeenCalled();
  });

  it("does not schedule a continuation for a short batch", async () => {
    hoisted.recoveries = [{ id: "recovery-1" }];
    hoisted.resume.mockReset().mockResolvedValue({ kind: "initiated" });
    hoisted.schedule.mockClear();

    await hoisted.processor?.({
      name: RESUME_CAPACITY_BLOCKED_RECOVERIES_JOB,
      data: { shopId: "shop-1", trigger: "repair" },
    });

    expect(hoisted.resume).toHaveBeenCalledOnce();
    expect(hoisted.schedule).not.toHaveBeenCalled();
  });
});
