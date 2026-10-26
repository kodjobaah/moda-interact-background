import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  worker: null as null | { queue: string; processor: (job: any) => Promise<void>; options: any },
  listeners: new Map<string, (...args: any[]) => void>(),
  info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  reconcile: vi.fn(async () => ({ kind: "placed-suppressed" as const })),
  metric: vi.fn(async (_definition, _job, fn) => fn()),
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
  createLogger: () => ({ info: mocked.info, warn: mocked.warn, error: mocked.error }),
}));
vi.mock("@modainteract/moda-interact-shared/observability/bullmq", () => ({ createBullMQTelemetry: () => ({}) }));
vi.mock("../../../src/observability/worker-metrics.js", () => ({ observeWorkerJob: mocked.metric }));
vi.mock("../../../src/lib/redis.js", () => ({ connectionRedis: {} }));
vi.mock("../../../src/runtime/deployment-environment.js", () => ({ resolveDeploymentEnvironmentName: () => "test" }));

import { createWooOrderCaptureWorker } from "../../../src/workers/woo-order-capture.worker.js";
const event = (kind = "ORDER_PLACED") => ({
  schemaVersion: "woo.activity.v1", eventId: "woo-evt-1", eventType: kind,
  checkoutKey: "cart-key-1", occurredAt: "2026-10-20T12:00:00.000Z",
  order: { orderId: "ord-1", checkoutKey: "cart-key-1", status: "processing" },
});
const digest = (data: object) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
const id = `woo-order-${createHash("sha256").update("shop-1").update("\0").update("woo-evt-1").digest("hex")}`;
const good = () => ({
  id, name: "order-lifecycle", data: { ...event(), shopId: "shop-1", contentDigest: digest(event()) }, attemptsMade: 0,
});
async function process(job: ReturnType<typeof good>) {
  if (!mocked.worker) throw new Error("worker not started");
  return mocked.worker.processor(job);
}

describe("ARCH-048 Woo order worker reconciliation", () => {
  beforeEach(() => {
    mocked.worker = null;
    mocked.listeners.clear();
    for (const fn of [mocked.info, mocked.warn, mocked.error, mocked.metric, mocked.reconcile]) fn.mockClear();
    mocked.reconcile.mockResolvedValue({ kind: "placed-suppressed" });
    createWooOrderCaptureWorker({ onOrder: mocked.reconcile });
  });

  it("rejects the retired capture-only startup without an orchestrator", () => {
    mocked.worker = null;
    expect(() => createWooOrderCaptureWorker(undefined as never))
      .toThrow("WOO_RECOVERY_ORCHESTRATOR_UNAVAILABLE");
    expect(mocked.worker).toBeNull();
    expect(mocked.error).toHaveBeenCalledWith("woocommerce.recovery.worker.configuration_failed", {
      queue: "woo-order-capture-v1", stage: "bootstrap", reason: "orchestrator-unavailable",
    });
    expect(mocked.reconcile).not.toHaveBeenCalled();
  });

  it("delegates a verified order event to BG002 and logs only bounded metadata", async () => {
    await expect(process(good())).resolves.toBeUndefined();
    expect(mocked.reconcile).toHaveBeenCalledOnce();
    expect(mocked.reconcile.mock.calls[0]?.[0]).toMatchObject({ shopId: "shop-1", eventType: "ORDER_PLACED" });
    expect(mocked.info).toHaveBeenCalledWith("woocommerce.recovery.job.completed", expect.objectContaining({
      queue: "woo-order-capture-v1", shopId: "shop-1", outcome: "placed-suppressed",
    }));
    expect(JSON.stringify(mocked.info.mock.calls)).not.toContain("cart-key-1");
  });

  it("rejects tampered capture jobs without calling the reconciler", async () => {
    await expect(process({ ...good(), data: { ...good().data, contentDigest: "0".repeat(64) } })).rejects.toThrow();
    expect(mocked.reconcile).not.toHaveBeenCalled();
    expect(mocked.error).toHaveBeenCalledWith("woocommerce.recovery.job.failed", expect.objectContaining({
      stage: "validate", reason: "digest_mismatch",
    }));
  });

  it("propagates an order DB error through the awaited job callback", async () => {
    const failure = new Error("db connection password");
    mocked.reconcile.mockRejectedValueOnce(failure);
    await expect(process(good())).rejects.toBe(failure);
    expect(mocked.info).not.toHaveBeenCalledWith("woocommerce.recovery.job.completed", expect.anything());
    expect(JSON.stringify(mocked.error.mock.calls)).not.toContain("password");
  });

  it("keeps order and credit business logic outside the capture worker", async () => {
    const code = (await readFile("src/workers/woo-order-capture.worker.ts", "utf8"))
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, "");
    expect(code).not.toMatch(/\bprisma\b|checkoutRecoveryService|reserveRecoveryCredit|sendTemplate/);
  });

  it("logs worker infrastructure errors without their raw messages", () => {
    mocked.listeners.get("error")?.(new Error("secret Redis URL"));
    expect(mocked.error).toHaveBeenCalledWith("woocommerce.order_capture.worker_error", {
      queueName: "woo-order-capture-v1", errorName: "Error",
    });
    expect(JSON.stringify(mocked.error.mock.calls)).not.toContain("secret Redis URL");
  });
});
