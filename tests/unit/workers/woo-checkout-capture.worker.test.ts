import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  worker: null as null | { queue: string; processor: (job: any) => Promise<void>; options: any },
  listeners: new Map<string, (...args: any[]) => void>(),
  info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  checkout: vi.fn(async () => ({ kind: "scheduled" as const, dueAt: "2026-10-25T00:30:00.000Z" })),
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
vi.mock("@modainteract/moda-interact-shared/observability/bullmq", () => ({
  createBullMQTelemetry: () => ({}),
}));
vi.mock("../../../src/observability/worker-metrics.js", () => ({ observeWorkerJob: mocked.metric }));
vi.mock("../../../src/lib/redis.js", () => ({ connectionRedis: {} }));
vi.mock("../../../src/runtime/deployment-environment.js", () => ({ resolveDeploymentEnvironmentName: () => "test" }));

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

describe("ARCH-048 Woo checkout worker orchestration", () => {
  beforeEach(() => {
    mocked.worker = null;
    mocked.listeners.clear();
    for (const mock of [mocked.info, mocked.warn, mocked.error, mocked.metric, mocked.checkout]) mock.mockClear();
    mocked.checkout.mockResolvedValue({ kind: "scheduled", dueAt: "2026-10-25T00:30:00.000Z" });
    createWooCheckoutCaptureWorker({ onCheckout: mocked.checkout });
  });

  it("rejects the retired capture-only startup without an orchestrator", () => {
    mocked.worker = null;
    expect(() => createWooCheckoutCaptureWorker(undefined as never))
      .toThrow("WOO_RECOVERY_ORCHESTRATOR_UNAVAILABLE");
    expect(mocked.worker).toBeNull();
    expect(mocked.error).toHaveBeenCalledWith("woocommerce.recovery.worker.configuration_failed", {
      queue: "woo-checkout-capture-v1", stage: "bootstrap", reason: "orchestrator-unavailable",
    });
    expect(mocked.checkout).not.toHaveBeenCalled();
  });

  it("validates then awaits BG001 via the orchestrator on the existing queue", async () => {
    await expect(execute(good())).resolves.toBeUndefined();
    expect(mocked.checkout).toHaveBeenCalledOnce();
    expect(mocked.checkout.mock.calls[0]?.[0]).toMatchObject({ shopId: "shop-1", eventId: "evt123" });
    expect(mocked.info).toHaveBeenCalledWith("woocommerce.recovery.job.completed", expect.objectContaining({
      queue: "woo-checkout-capture-v1", shopId: "shop-1", outcome: "scheduled", attempt: 1,
    }));
    expect(mocked.metric).toHaveBeenCalledWith(expect.objectContaining({
      workerName: "woo-checkout-capture", queueName: "woo-checkout-capture-v1",
    }), expect.anything(), expect.any(Function));
    expect(JSON.stringify(mocked.info.mock.calls)).not.toMatch(/cart1|private@example.test/);
  });

  it("rejects bad digest and identity before invoking any business adapter", async () => {
    await expect(execute({ ...good(), data: { ...good().data, contentDigest: "0".repeat(64) } })).rejects.toThrow();
    await expect(execute({ ...good(), id: "private@example.test" })).rejects.toThrow();
    expect(mocked.checkout).not.toHaveBeenCalled();
    expect(mocked.error).toHaveBeenCalledWith("woocommerce.recovery.job.failed", expect.objectContaining({
      stage: "validate", reason: "digest_mismatch",
    }));
    expect(JSON.stringify(mocked.error.mock.calls)).not.toContain("private@example.test");
  });

  it("does not swallow an orchestrator error, and never logs success", async () => {
    const error = new Error("checkout DB: private@example.test");
    mocked.checkout.mockRejectedValueOnce(error);
    await expect(execute(good())).rejects.toBe(error);
    expect(mocked.info).not.toHaveBeenCalledWith("woocommerce.recovery.job.completed", expect.anything());
    expect(mocked.error).toHaveBeenCalledWith("woocommerce.recovery.job.failed", expect.objectContaining({
      errorMessage: "checkout DB: private@example.test", error,
    }));
  });

  it("does not implement billing or recovery rules inside the capture worker", async () => {
    const code = (await readFile("src/workers/woo-checkout-capture.worker.ts", "utf8"))
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, "");
    expect(code).not.toMatch(/checkoutRecoveryService|\bprisma\b|reserveRecoveryCredit|sendTemplate/);
  });

  it("reports worker infrastructure errors with the original Redis message", () => {
    mocked.listeners.get("ready")?.();
    const error = new Error("redis secret");
    mocked.listeners.get("error")?.(error);
    expect(mocked.error).toHaveBeenCalledWith("woocommerce.checkout_capture.worker_error", {
      queueName: "woo-checkout-capture-v1", errorName: "Error",
      errorMessage: "redis secret", error,
    });
  });
});
