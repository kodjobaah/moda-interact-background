import { describe, expect, it, vi } from "vitest";

vi.mock("bullmq", () => ({ Queue: class {} }));
vi.mock("@modainteract/moda-interact-shared/observability/bullmq", () => ({
  createBullMQTelemetry: vi.fn(() => ({})),
}));
vi.mock("../../../src/lib/redis.js", () => ({ connectionRedis: {} }));

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("../../../src/lib/db.js", () => ({
  default: { checkoutRecovery: { findMany } },
}));

import { RecoveryCapacityResumeService } from "../../../src/services/recovery-capacity-resume.service.js";

describe("RecoveryCapacityResumeService", () => {
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

    await expect(service.repair(500)).rejects.toThrow(
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
});
