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
  it("repairs only active blocked shops and caps the scan at 100", async () => {
    findMany.mockResolvedValue(
      Array.from({ length: 100 }, (_, index) => ({ shopId: `shop-${index}` })),
    );
    const service = new RecoveryCapacityResumeService();
    const schedule = vi.spyOn(service, "schedule").mockResolvedValue("job-id");

    await expect(service.repair(500)).resolves.toBe(100);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: "DETECTED",
        admissionBlockReason: "RECOVERY_CAPACITY_EXHAUSTED",
        shop: { status: "ACTIVE" },
      },
      orderBy: [{ shopId: "asc" }, { detectedAt: "asc" }, { id: "asc" }],
      distinct: ["shopId"],
      take: 100,
      select: { shopId: true },
    });
    expect(schedule).toHaveBeenCalledTimes(100);
    expect(schedule).toHaveBeenCalledWith({
      shopId: "shop-0",
      trigger: "repair",
    });
    expect(schedule).toHaveBeenCalledWith({
      shopId: "shop-99",
      trigger: "repair",
    });
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
