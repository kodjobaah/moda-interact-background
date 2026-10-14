import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const entry = readFileSync(resolve(root, "src/entrypoints/recovery.ts"), "utf8");

describe("ARCH-036 recovery entrypoint Woo coupon wiring", () => {
  it("starts the worker before enabling globally leased shop discovery and dispatch", () => {
    expect(entry).toContain("createWooCouponSyncWorker()");
    expect(entry).toContain("new Queue(WOO_COUPON_SYNC_QUEUE_NAME");
    expect(entry).toContain("new WooCouponDispatcherService(prisma, wooCouponSyncQueue, wooCouponSyncSettings)");
    expect(entry).toContain('leaseName: "WOO_COUPON_SYNC_DISPATCH"');
    expect(entry).toContain("intervalMs: 60_000");
    expect(entry).toContain("await wooCouponDispatcher.dispatch(wooCouponSyncSettings.dispatchBatchSize)");
    expect(entry.indexOf("createWooCouponSyncWorker()")).toBeLessThan(entry.indexOf('leaseName: "WOO_COUPON_SYNC_DISPATCH"'));
    expect(entry).not.toContain("upsertJobScheduler");
    expect(entry).not.toContain("setInterval");
  });

  it("stops producers, closes queue and only then closes shared Redis", () => {
    const stop = entry.indexOf("stopWooCouponDispatcher,");
    const queue = entry.indexOf("wooCouponSyncQueue.close()");
    const connections = entry.indexOf("closeWorkerResources.map((close) => close())");
    expect(stop).toBeGreaterThan(0);
    expect(queue).toBeGreaterThan(stop);
    expect(connections).toBeGreaterThan(queue);
    expect(entry).toContain("WOO_COUPON_SYNC_QUEUE_NAME,");
    expect(entry).toContain("wooCouponSyncWorker,");
  });
});
