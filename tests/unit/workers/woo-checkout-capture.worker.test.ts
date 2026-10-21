import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  worker: null as null | { queue: string; processor: (job: any) => Promise<void>; options: any },
  listeners: new Map<string, (...args: any[]) => void>(),
  info: vi.fn(), error: vi.fn(), metric: vi.fn(async (_definition, _job, fn) => fn()),
}));
vi.mock("bullmq", () => ({
  Worker: class {
    constructor(queue: string, processor: (job: any) => Promise<void>, options: any) {
      mocked.worker = { queue, processor, options };
    }
    on(name: string, listener: (...args: any[]) => void) { mocked.listeners.set(name, listener); return this; }
  },
}));
vi.mock("@modainteract/moda-interact-shared/logging", () => ({
  createLogger: () => ({ info: mocked.info, error: mocked.error }),
}));
vi.mock("@modainteract/moda-interact-shared/observability/bullmq", () => ({
  createBullMQTelemetry: () => ({}),
}));
vi.mock("../../../src/observability/worker-metrics.js", () => ({ observeWorkerJob: mocked.metric }));
vi.mock("../../../src/lib/redis.js", () => ({ connectionRedis: {} }));
vi.mock("../../../src/runtime/deployment-environment.js", () => ({
  resolveDeploymentEnvironmentName: () => "test",
}));

import { createWooCheckoutCaptureWorker } from "../../../src/workers/woo-checkout-capture.worker.js";
const source = {
  schemaVersion: "woo.activity.v1", eventId: "evt123", eventType: "CHECKOUT_UPDATED",
  checkoutKey: "cart1", occurredAt: "2026-10-20T12:00:00.000Z",
  checkout: { currency: "GBP", total: "12.00", contact: { email: "private@example.test" } },
};
const digest = (value: object) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const id = `woo-checkout-${createHash("sha256").update("shop-1").update("\0").update(source.eventId).digest("hex")}`;
const good = () => ({ id, name: "checkout-updated", data: { ...source, shopId: "shop-1", contentDigest: digest(source) }, attemptsMade: 0 });
async function execute(job: ReturnType<typeof good>) {
  if (!mocked.worker) throw new Error("not started");
  return mocked.worker.processor(job);
}

describe("ARCH-035 Woo capture-only background worker", () => {
  beforeEach(() => {
    mocked.worker = null; mocked.listeners.clear(); mocked.info.mockReset(); mocked.error.mockReset(); mocked.metric.mockClear();
    createWooCheckoutCaptureWorker();
  });

  it("subscribes only to the API-008 checkout queue, using existing operational telemetry", async () => {
    expect(mocked.worker).toMatchObject({ queue: "woo-checkout-capture-v1", options: { concurrency: 4 } });
    await expect(execute(good())).resolves.toBeUndefined();
    expect(mocked.metric).toHaveBeenCalledWith(expect.objectContaining({
      workerName: "woo-checkout-capture", queueName: "woo-checkout-capture-v1", jobNames: ["checkout-updated"],
    }), expect.anything(), expect.any(Function));
    expect(mocked.info).toHaveBeenCalledWith("woocommerce.checkout_capture.accepted", {
      shopId: "shop-1", eventId: "evt123", checkoutKey: "cart1", eventType: "CHECKOUT_UPDATED",
      jobId: id, attempt: 1,
    });
    expect(JSON.stringify(mocked.info.mock.calls)).not.toContain("private@example.test");
  });

  it("rejects poisoned jobs visibly, with no unvalidated identifiers or customer payloads in logs", async () => {
    const bad = { ...good(), data: { ...good().data, contentDigest: "0".repeat(64) } };
    await expect(execute(bad)).rejects.toThrow("Invalid Woo checkout capture job");
    await expect(execute({ ...good(), id: "private@example.test" })).rejects.toThrow();
    expect(mocked.error).toHaveBeenCalledWith("woocommerce.checkout_capture.failed", {
      jobId: id, attempt: 1, reason: "digest_mismatch",
    });
    expect(mocked.error).toHaveBeenCalledWith("woocommerce.checkout_capture.failed", {
      jobId: null, attempt: 1, reason: "job_identity_mismatch",
    });
    expect(JSON.stringify(mocked.error.mock.calls)).not.toContain("private@example.test");
    expect(mocked.info).not.toHaveBeenCalled();
  });

  it("contains no recovery, billing, database or customer messaging execution path", async () => {
    const source = await readFile("src/workers/woo-checkout-capture.worker.ts", "utf8");
    const parser = await readFile("src/events/woo-checkout-capture.ts", "utf8");
    for (const code of [source, parser]) {
      // Check executable source, not documentation explaining the absence of side effects.
      const executableSource = code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, "");
      expect(executableSource).not.toMatch(/checkoutRecoveryService|checkout-recovery|prisma|whatsapp|bullmq\/Queue|billing/);
    }
  });

  it("bounds the worker's infrastructure error log without leaking Redis messages", () => {
    mocked.listeners.get("ready")?.();
    mocked.listeners.get("error")?.(new Error("redis password=secret"));
    expect(mocked.info).toHaveBeenCalledWith("woocommerce.checkout_capture.worker_ready", {
      queueName: "woo-checkout-capture-v1",
    });
    expect(mocked.error).toHaveBeenCalledWith("woocommerce.checkout_capture.worker_error", {
      queueName: "woo-checkout-capture-v1", errorName: "Error",
    });
    expect(JSON.stringify(mocked.error.mock.calls)).not.toContain("password=secret");
  });
});
