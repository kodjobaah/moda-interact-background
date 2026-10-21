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

import { createWooOrderCaptureWorker } from "../../../src/workers/woo-order-capture.worker.js";
const event = (kind = "ORDER_PLACED") => ({
  schemaVersion: "woo.activity.v1", eventId: "woo-evt-1", eventType: kind,
  checkoutKey: "cart-key-1", occurredAt: "2026-10-20T12:00:00.000Z",
  order: { orderId: "ord-1", checkoutKey: "cart-key-1", status: "processing" },
});
const digest = (data: object) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
const id = `woo-order-${createHash("sha256").update("shop-1").update("\0").update("woo-evt-1").digest("hex")}`;
const good = () => ({
  id, name: "order-lifecycle", data: { ...event(), shopId: "shop-1", contentDigest: digest(event()) },
  attemptsMade: 0,
});
async function process(job: ReturnType<typeof good>) {
  if (!mocked.worker) throw new Error("worker not started");
  return mocked.worker.processor(job);
}

describe("ARCH-035 Woo order capture-only worker", () => {
  beforeEach(() => {
    mocked.worker = null; mocked.listeners.clear(); mocked.info.mockReset(); mocked.error.mockReset(); mocked.metric.mockClear();
    createWooOrderCaptureWorker();
  });

  it("subscribes only to the Woo order queue and logs bounded validated event metadata", async () => {
    expect(mocked.worker).toMatchObject({ queue: "woo-order-capture-v1", options: { concurrency: 4 } });
    await expect(process(good())).resolves.toBeUndefined();
    expect(mocked.metric).toHaveBeenCalledWith(expect.objectContaining({
      workerName: "woo-order-capture", queueName: "woo-order-capture-v1", jobNames: ["order-lifecycle"],
    }), expect.anything(), expect.any(Function));
    expect(mocked.info).toHaveBeenCalledWith("woocommerce.order_capture.accepted", {
      shopId: "shop-1", eventId: "woo-evt-1", eventType: "ORDER_PLACED",
      occurredAt: "2026-10-20T12:00:00.000Z", orderId: "ord-1", checkoutKey: "cart-key-1", status: "processing", jobId: id, attempt: 1,
    });
  });

  it("throws invalid jobs for BullMQ retry without logging raw event payload or error text", async () => {
    const tampered = { ...good(), data: { ...good().data, contentDigest: "0".repeat(64) } };
    await expect(process(tampered)).rejects.toThrow("Invalid Woo order capture job");
    await expect(process({ ...good(), id: "private@example.test" })).rejects.toThrow();
    expect(mocked.error).toHaveBeenCalledWith("woocommerce.order_capture.failed", {
      jobId: id, attempt: 1, reason: "digest_mismatch",
    });
    expect(mocked.error).toHaveBeenCalledWith("woocommerce.order_capture.failed", {
      jobId: null, attempt: 1, reason: "job_identity_mismatch",
    });
    expect(JSON.stringify(mocked.error.mock.calls)).not.toContain("private@example.test");
    expect(mocked.info).not.toHaveBeenCalled();
  });

  it("keeps business execution and Shopify order parser out of the order capture path", async () => {
    for (const path of ["src/workers/woo-order-capture.worker.ts", "src/events/woo-order-capture.ts"]) {
      const source = await readFile(path, "utf8");
      const executable = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, "");
      expect(executable).not.toMatch(/prisma|checkoutRecoveryService|handleOrderCompletedContract|billing|whatsapp|orders\.worker/i);
      expect(executable).not.toMatch(/(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']*shopify[^"']*event[^"']*)["']/i);
    }
  });

  it("bounds infrastructure errors without leaking Redis credentials", () => {
    mocked.listeners.get("ready")?.();
    mocked.listeners.get("error")?.(new Error("redis password=secret"));
    expect(mocked.info).toHaveBeenCalledWith("woocommerce.order_capture.worker_ready", {
      queueName: "woo-order-capture-v1",
    });
    expect(mocked.error).toHaveBeenCalledWith("woocommerce.order_capture.worker_error", {
      queueName: "woo-order-capture-v1", errorName: "Error",
    });
    expect(JSON.stringify(mocked.error.mock.calls)).not.toContain("password=secret");
  });
});
