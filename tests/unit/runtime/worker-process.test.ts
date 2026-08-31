import { afterEach, describe, expect, it, vi } from "vitest";

import { startWorkerProcess } from "../../../src/runtime/worker-process.js";

describe("worker process lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("closes every owned worker before shared resources and only shuts down once", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const firstWorkerClose = vi.fn().mockResolvedValue(undefined);
    const secondWorkerClose = vi.fn().mockResolvedValue(undefined);
    const resourceClose = vi.fn().mockResolvedValue(undefined);
    const shutdown = startWorkerProcess({
      serviceName: "test-worker",
      workers: [
        { close: firstWorkerClose },
        { close: secondWorkerClose },
      ],
      closeResources: [resourceClose],
    });

    await Promise.all([shutdown(), shutdown()]);

    expect(firstWorkerClose).toHaveBeenCalledOnce();
    expect(secondWorkerClose).toHaveBeenCalledOnce();
    expect(resourceClose).toHaveBeenCalledOnce();
    expect(resourceClose.mock.invocationCallOrder[0]).toBeGreaterThan(
      firstWorkerClose.mock.invocationCallOrder[0]!,
    );
    expect(resourceClose.mock.invocationCallOrder[0]).toBeGreaterThan(
      secondWorkerClose.mock.invocationCallOrder[0]!,
    );
  });

  it("still closes resources when an owned worker fails to close", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const resourceClose = vi.fn().mockResolvedValue(undefined);
    const shutdown = startWorkerProcess({
      serviceName: "test-worker",
      workers: [
        {
          close: vi.fn().mockRejectedValue(new Error("worker close failed")),
        },
      ],
      closeResources: [resourceClose],
    });

    await expect(shutdown()).rejects.toThrow("test-worker shutdown failed");
    expect(resourceClose).toHaveBeenCalledOnce();
  });

  it("gracefully shuts down when the process receives SIGTERM", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const workerClose = vi.fn().mockResolvedValue(undefined);
    const resourceClose = vi.fn().mockResolvedValue(undefined);
    const initialListenerCount = process.listenerCount("SIGTERM");
    startWorkerProcess({
      serviceName: "test-worker",
      workers: [{ close: workerClose }],
      closeResources: [resourceClose],
    });

    process.emit("SIGTERM", "SIGTERM");

    await vi.waitFor(() => {
      expect(workerClose).toHaveBeenCalledOnce();
      expect(resourceClose).toHaveBeenCalledOnce();
    });
    expect(process.listenerCount("SIGTERM")).toBe(initialListenerCount);
  });
});