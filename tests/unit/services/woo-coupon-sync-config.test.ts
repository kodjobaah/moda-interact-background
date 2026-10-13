import { describe, expect, it } from "vitest";
import { loadWooCouponSyncConfig } from "../../../src/services/woo-coupon-sync-config.js";

describe("ARCH-036 validated synchronisation settings", () => {
  it("uses documented bounded defaults", () => {
    expect(loadWooCouponSyncConfig({})).toEqual({
      dispatchBatchSize: 500, refreshIntervalMinutes: 30,
      dispatchCooldownMinutes: 5, unavailableRecheckMinutes: 30,
      staleScanMinutes: 15, maxPages: 50,
      requestTimeoutMs: 8000, maxResponseBytes: 1048576,
      maxScanDurationMs: 120000,
    });
  });

  it("accepts explicit bounded overrides", () => {
    expect(loadWooCouponSyncConfig({
      WOO_COUPON_SYNC_DISPATCH_BATCH_SIZE: "2",
      WOO_COUPON_SYNC_MAX_PAGES: "3",
      WOO_COUPON_SYNC_MAX_SCAN_DURATION_MS: "30000",
    })).toMatchObject({ dispatchBatchSize: 2, maxPages: 3, maxScanDurationMs: 30000 });
  });

  it.each([
    ["WOO_COUPON_SYNC_DISPATCH_BATCH_SIZE", "501"],
    ["WOO_COUPON_SYNC_DISPATCH_BATCH_SIZE", "0"],
    ["WOO_COUPON_SYNC_REFRESH_MINUTES", "0"],
    ["WOO_COUPON_SYNC_DISPATCH_COOLDOWN_MINUTES", "bad"],
    ["WOO_COUPON_SYNC_UNAVAILABLE_RECHECK_MINUTES", "-1"],
    ["WOO_COUPON_SYNC_STALE_SCAN_MINUTES", "999"],
    ["WOO_COUPON_SYNC_MAX_PAGES", "201"],
    ["WOO_COUPON_SYNC_REQUEST_TIMEOUT_MS", "999"],
    ["WOO_COUPON_SYNC_MAX_RESPONSE_BYTES", "4194305"],
    ["WOO_COUPON_SYNC_MAX_SCAN_DURATION_MS", "NaN"],
  ])("rejects invalid %s", (name, value) => {
    expect(() => loadWooCouponSyncConfig({ [name]: value })).toThrow(RangeError);
  });
});
