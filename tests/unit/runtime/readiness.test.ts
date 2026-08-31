import { describe, expect, it, vi } from "vitest";

import {
  assertWorkerReady,
  createDependencyProbes,
  startReadyWorkerProcess,
  type ReadinessProbe,
} from "../../../src/runtime/readiness.js";

describe("worker readiness", () => {
  it("checks only the dependencies declared for the worker", async () => {
    const redisCheck = vi.fn().mockResolvedValue(undefined);
    const postgresqlCheck = vi.fn().mockResolvedValue(undefined);
    const probes: ReadinessProbe[] = [
      { name: "redis", check: redisCheck },
      { name: "postgresql", check: postgresqlCheck },
    ];

    await assertWorkerReady("moda-shopify-event-worker", probes);

    expect(redisCheck).toHaveBeenCalledOnce();
    expect(postgresqlCheck).toHaveBeenCalledOnce();
  });

  it("reports a predictable sanitized dependency failure", async () => {
    const secret = "postgresql://user:password@database.internal/moda";
    const probes: ReadinessProbe[] = [
      { name: "redis", check: vi.fn().mockResolvedValue(undefined) },
      {
        name: "postgresql",
        check: vi.fn().mockRejectedValue(new Error(secret)),
      },
    ];

    await expect(
      assertWorkerReady("moda-recovery-worker", probes),
    ).rejects.toThrow(
      "moda-recovery-worker readiness failed: postgresql unavailable",
    );

    try {
      await assertWorkerReady("moda-recovery-worker", probes);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it.each(["redis", "postgresql"] as const)(
    "does not load consumers when %s readiness fails",
    async (failedDependency) => {
      const loadWorkerProcess = vi.fn();
      const probes: ReadinessProbe[] = [
        {
          name: "redis",
          check:
            failedDependency === "redis"
              ? vi.fn().mockRejectedValue(new Error("redis secret"))
              : vi.fn().mockResolvedValue(undefined),
        },
        {
          name: "postgresql",
          check:
            failedDependency === "postgresql"
              ? vi.fn().mockRejectedValue(new Error("database secret"))
              : vi.fn().mockResolvedValue(undefined),
        },
      ];

      await expect(
        startReadyWorkerProcess({
          serviceName: "moda-messaging-worker",
          loadWorkerProcess,
          probes,
        }),
      ).rejects.toThrow(`${failedDependency} unavailable`);
      expect(loadWorkerProcess).not.toHaveBeenCalled();
    },
  );

  it("loads consumers only after every required probe succeeds", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const workerClose = vi.fn().mockResolvedValue(undefined);
    const resourceClose = vi.fn().mockResolvedValue(undefined);
    const loadWorkerProcess = vi.fn().mockResolvedValue({
      workers: [{ close: workerClose }],
      closeResources: [resourceClose],
    });
    const probes: ReadinessProbe[] = [
      { name: "redis", check: vi.fn().mockResolvedValue(undefined) },
      { name: "postgresql", check: vi.fn().mockResolvedValue(undefined) },
    ];

    const shutdown = await startReadyWorkerProcess({
      serviceName: "moda-shopify-event-worker",
      loadWorkerProcess,
      probes,
    });

    expect(loadWorkerProcess).toHaveBeenCalledOnce();
    await shutdown();
    expect(workerClose).toHaveBeenCalledOnce();
    expect(resourceClose).toHaveBeenCalledOnce();
  });

  it.each(["redis", "postgresql"] as const)(
    "fails the concrete %s probe when required configuration is absent",
    async (dependency) => {
      const probe = createDependencyProbes({}, 10).find(
        (candidate) => candidate.name === dependency,
      );

      expect(probe).toBeDefined();
      await expect(probe!.check()).rejects.toThrow(
        dependency === "redis"
          ? "missing Redis configuration"
          : "missing PostgreSQL configuration",
      );
    },
  );
});