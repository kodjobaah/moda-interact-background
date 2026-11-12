import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startShopifyBrandSourceSync } from "../../../../src/services/shop-brand-media-shopify/runner.js";
import { SHOPIFY_BRAND_SYNC_SCAN_INTERVAL_MS } from "../../../../src/services/shop-brand-media-shopify/contracts.js";
afterEach(() => vi.useRealTimers());
describe("recovery shop name lifecycle", () => {
 it("starts immediately, serializes sweeps, waits for in-flight work and stops future ticks", async () => {
  vi.useFakeTimers(); let finish!: () => void;
  const running = new Promise<{ inspected: number; claimed: number; failed: number }>(resolve => { finish = () => resolve({ inspected: 0, claimed: 0, failed: 0 }); });
  const reconcileOnce = vi.fn(() => running);
  const stop = await startShopifyBrandSourceSync({ reconcileOnce });
  expect(reconcileOnce).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(SHOPIFY_BRAND_SYNC_SCAN_INTERVAL_MS * 3);
  expect(reconcileOnce).toHaveBeenCalledOnce(); let stopped = false;
  const stopping = stop().then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false); finish(); await stopping;
  await vi.advanceTimersByTimeAsync(SHOPIFY_BRAND_SYNC_SCAN_INTERVAL_MS * 3); expect(reconcileOnce).toHaveBeenCalledOnce();
 });
 it("wires start and stop only in recovery entrypoint", () => {
  const source = readFileSync(new URL("../../../../src/entrypoints/recovery.ts", import.meta.url), "utf8");
  expect(source).toContain('await import("../services/shop-brand-media-shopify/runner.js")');
  expect(source).toContain("const stopShopifyBrandSourceSync = await startShopifyBrandSourceSync()");
  expect(source).toContain("          stopShopifyBrandSourceSync,");
 });
});
