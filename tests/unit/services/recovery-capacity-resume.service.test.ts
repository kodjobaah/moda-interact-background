import { beforeEach, describe, expect, it, vi } from "vitest";

const { add, findMany } = vi.hoisted(() => ({ add: vi.fn(), findMany: vi.fn() }));
vi.mock("bullmq", () => ({
  Queue: class {
    add = add;
  },
}));
vi.mock("@modainteract/moda-interact-shared/observability/bullmq", () => ({
  createBullMQTelemetry: vi.fn(() => ({})),
}));
vi.mock("../../../src/lib/redis.js", () => ({ connectionRedis: {} }));

vi.mock("../../../src/lib/db.js", () => ({
  default: { checkoutRecovery: { findMany } },
}));

import { RecoveryCapacityResumeService } from "../../../src/services/recovery-capacity-resume.service.js";

describe("RecoveryCapacityResumeService", () => {
  beforeEach(() => {
    findMany.mockReset();
    add.mockReset();
  });

  it("uses the configured repair shop batch", async () => {
    findMany.mockResolvedValue([{ shopId: "shop-1" }, { shopId: "shop-2" }]);
    const service = new RecoveryCapacityResumeService();
    vi.spyOn(service, "schedule").mockResolvedValue("job-id");

    await service.repair({ recoveryRepairShopBatchSize: 2 });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
  });

  it("rejects an out-of-range repair batch before scanning", async () => {
    findMany.mockResolvedValue(
      Array.from({ length: 100 }, (_, index) => ({ shopId: `shop-${index}` })),
    );
    const service = new RecoveryCapacityResumeService();
    const schedule = vi.spyOn(service, "schedule").mockResolvedValue("job-id");

    await expect(service.repair(501)).rejects.toThrow(
      "Recovery repair shop batch size is outside the database range.",
    );
    expect(findMany).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("continues repairing after one deterministic schedule failure", async () => {
    findMany.mockResolvedValue([{ shopId: "shop-1" }, { shopId: "shop-2" }]);
    const service = new RecoveryCapacityResumeService();
    const schedule = vi
      .spyOn(service, "schedule")
      .mockRejectedValueOnce(new Error("redis unavailable"))
      .mockResolvedValueOnce("job-id");

    await expect(service.repair()).resolves.toBe(1);
    expect(schedule).toHaveBeenCalledTimes(2);
    expect(schedule).toHaveBeenNthCalledWith(1, {
      shopId: "shop-1",
      trigger: "repair",
    });
    expect(schedule).toHaveBeenNthCalledWith(2, {
      shopId: "shop-2",
      trigger: "repair",
    });
  });

  it("schedules a recovery-targeted expiry resume with a bounded delay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
    add.mockResolvedValue(undefined);
    const service = new RecoveryCapacityResumeService();
    const dueAt = new Date("2026-10-11T00:05:00Z");

    try {
      await service.schedule({
        shopId: "shop-1",
        recoveryId: "recovery-1",
        trigger: `recipient-suppression-recovery-1-${dueAt.getTime()}`,
      }, dueAt);
    } finally {
      vi.useRealTimers();
    }

    expect(add).toHaveBeenCalledWith(
      "resume-capacity-blocked-recoveries",
      {
        shopId: "shop-1",
        recoveryId: "recovery-1",
        trigger: `recipient-suppression-recovery-1-${dueAt.getTime()}`,
      },
      {
        jobId: `recovery-capacity-resume--shop-1--recipient-suppression-recovery-1-${dueAt.getTime()}`,
        delay: 301_000,
      },
    );
  });
});
