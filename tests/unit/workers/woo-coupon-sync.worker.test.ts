import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  run: vi.fn(),
  worker: null as null | {
    queueName: string;
    options: Record<string, unknown>;
    processor: (job: Record<string, unknown>) => Promise<unknown>;
  },
  listeners: new Map<string, (...args: unknown[]) => void>(),
  info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));

vi.mock("bullmq", () => ({
  Worker: class {
    constructor(queueName: string, processor: (job: Record<string, unknown>) => Promise<unknown>,
      options: Record<string, unknown>) {
      mock.worker = { queueName, options, processor };
    }
    on(event: string, listener: (...args: unknown[]) => void) {
      mock.listeners.set(event, listener);
      return this;
    }
  },
}));
vi.mock("@modainteract/moda-interact-shared/logging", () => ({
  createLogger: () => ({ info: mock.info, warn: mock.warn, error: mock.error }),
}));
vi.mock("../../../src/lib/redis.js", () => ({ connectionRedis: {} }));
vi.mock("../../../src/lib/db.js", () => ({ default: {} }));
vi.mock("../../../src/runtime/deployment-environment.js", () => ({
  resolveDeploymentEnvironmentName: () => "test",
}));

import {
  createWooCouponSyncWorker, wooCouponWorkerConcurrency,
} from "../../../src/workers/woo-coupon-sync.worker.js";
import {
  WOO_COUPON_SYNC_JOB_NAME, WOO_COUPON_SYNC_QUEUE_NAME, createWooCouponJobId,
} from "../../../src/services/woo-coupon-dispatcher.service.js";
import { WooCouponReadError } from "../../../src/providers/woo-coupon-transport.js";

const requestedAt = "2026-10-13T12:00:00.000Z";
const job = (shopId = "woo-shop-one") => ({
  id: createWooCouponJobId(shopId, requestedAt), name: WOO_COUPON_SYNC_JOB_NAME,
  data: { shopId, requestedAt }, attemptsMade: 0,
});

async function process(input: Record<string, unknown>): Promise<unknown> {
  if (!mock.worker) throw new Error("worker not started");
  return mock.worker.processor(input);
}

describe("ARCH-036 Woo coupon BullMQ consumer", () => {
  beforeEach(() => {
    mock.run.mockReset(); mock.info.mockReset(); mock.warn.mockReset(); mock.error.mockReset();
    mock.listeners.clear(); mock.worker = null;
    createWooCouponSyncWorker({ reconcile: mock.run } as any, 4);
  });

  it("consumes only the private hashed shop job and forwards its exact dispatch time", async () => {
    expect(mock.worker?.queueName).toBe(WOO_COUPON_SYNC_QUEUE_NAME);
    expect(mock.worker?.options).toMatchObject({ concurrency: 4 });
    mock.run.mockResolvedValueOnce("current");
    expect(await process(job())).toBe("current");
    expect(mock.run).toHaveBeenCalledWith("woo-shop-one", new Date(requestedAt));
    expect(mock.info).toHaveBeenCalledWith("woo.coupon_sync.completed", expect.objectContaining({ outcome: "current" }));
  });

  it("rejects forged/extra payloads, wrong job names, times and job identities before calling the service", async () => {
    const cases = [
      { ...job(), name: "other-job" },
      { ...job(), id: "wrong-id" },
      // A valid identity from an older reservation must not validate a newer payload.
      { ...job(), data: { shopId: "woo-shop-one", requestedAt: "2026-10-13T12:06:00.000Z" } },
      { ...job(), data: { shopId: "woo-shop-one", requestedAt, credential: "secret" } },
      { ...job(), data: { shopId: "woo-shop-one", requestedAt: "yesterday" } },
      { ...job(), data: { shopId: "woo-shop-one", requestedAt: "2026-10-13T12:00:00Z" } },
      { ...job(), data: { shopId: "bad:shop", requestedAt } },
      { ...job(), data: null },
    ];
    for (const invalid of cases) await expect(process(invalid)).rejects.toThrow("Invalid Woo coupon");
    expect(mock.run).not.toHaveBeenCalled();
  });

  it("treats unavailable, superseded and active duplicate outcomes as non-retryable", async () => {
    for (const outcome of ["unavailable", "superseded", "already-running"]) {
      mock.run.mockResolvedValueOnce(outcome);
      await expect(process(job())).resolves.toBe(outcome);
    }
    expect(mock.warn).toHaveBeenCalledWith("woo.coupon_sync.unavailable", expect.objectContaining({ outcome: "unavailable" }));
    expect(mock.info).toHaveBeenCalledWith("woo.coupon_sync.skipped", expect.objectContaining({ outcome: "already-running" }));
  });

  it("rethrows transient failures and logs the actual bounded error message", async () => {
    const error = new Error("unexpected query failure https://private.example/?password=secret");
    mock.run.mockRejectedValueOnce(error);
    await expect(process(job())).rejects.toBe(error);
    expect(mock.error).toHaveBeenCalledWith("woo.coupon_sync.failed", expect.objectContaining({
      shopId: "woo-shop-one", errorCode: "woo_coupon_sync_error",
      errorName: "Error",
      errorMessage: "unexpected query failure https://private.example/?password=secret",
    }));
    expect(JSON.stringify(mock.error.mock.calls)).toContain("password=secret");
    expect(JSON.stringify(mock.error.mock.calls)).toContain("private.example");
  });

  it("logs safe underlying transport cause details while preserving the read error code", async () => {
    const cause = Object.assign(new Error("connect ECONNRESET"), {
      code: "ECONNRESET", syscall: "connect",
    });
    const error = new WooCouponReadError("provider_unavailable", { cause, stage: "http" });
    mock.run.mockRejectedValueOnce(error);
    await expect(process(job())).rejects.toBe(error);
    expect(mock.error).toHaveBeenCalledWith("woo.coupon_sync.failed", expect.objectContaining({
      errorCode: "provider_unavailable",
      errorName: "WooCouponReadError",
      errorMessage: expect.stringContaining("connect ECONNRESET"),
      causeCode: "ECONNRESET",
      causeSyscall: "connect",
      errorStage: "http",
    }));
  });

  it("logs the actual WooCommerce response, provider status and message", async () => {
    const body = JSON.stringify({ code: "woocommerce_rest_cannot_view", message: "Coupon access denied" });
    const error = new WooCouponReadError("unauthorized", {
      stage: "http", httpStatus: 401, providerResponseBody: body,
      message: `WooCommerce coupon API returned HTTP 401; message: Coupon access denied; response: ${body}`,
    });
    mock.run.mockRejectedValueOnce(error);
    await expect(process(job())).rejects.toBe(error);
    expect(mock.error).toHaveBeenCalledWith("woo.coupon_sync.failed", expect.objectContaining({
      errorCode: "unauthorized", httpStatus: 401, errorStage: "http", providerResponseBody: body,
      errorMessage: expect.stringContaining("Coupon access denied"),
      error,
    }));
  });

  it("records readiness and logs the actual worker-level error message", () => {
    mock.listeners.get("ready")?.();
    mock.listeners.get("error")?.(new Error("redis error password=secret https://private.example/path"));
    expect(mock.info).toHaveBeenCalledWith("woo.coupon_sync.worker_ready", {
      queueName: WOO_COUPON_SYNC_QUEUE_NAME, concurrency: 4,
    });
    expect(mock.error).toHaveBeenCalledWith("woo.coupon_sync.worker_error", expect.objectContaining({
      errorName: "Error",
      errorMessage: "redis error password=secret https://private.example/path",
    }));
    expect(JSON.stringify(mock.error.mock.calls)).toContain("password=secret");
    expect(JSON.stringify(mock.error.mock.calls)).toContain("private.example");
  });

  it("bounds worker concurrency, including invalid environment overrides", () => {
    expect(wooCouponWorkerConcurrency({})).toBe(4);
    expect(wooCouponWorkerConcurrency({ WOO_COUPON_SYNC_WORKER_CONCURRENCY: "32" })).toBe(32);
    for (const invalid of ["0", "33", "-1", "1.5", "oops", "9999999999999999999999"]) {
      expect(() => wooCouponWorkerConcurrency({ WOO_COUPON_SYNC_WORKER_CONCURRENCY: invalid })).toThrow(RangeError);
    }
    expect(() => createWooCouponSyncWorker({ reconcile: mock.run } as any, 33)).toThrow(RangeError);
  });
});
