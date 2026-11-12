import { describe, expect, it, vi } from "vitest";
import { ShopifyBrandSourceSyncService } from "../../../../src/services/shop-brand-media-shopify/service.js";
import { ShopifyBrandSyncError } from "../../../../src/services/shop-brand-media-shopify/contracts.js";
const now = new Date("2026-11-12T00:00:00Z");
const snapshot = { logo: null, squareLogo: null, coverImage: null, observedAt: now.toISOString() };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
describe("bounded public brand asset scheduler", () => {
 it("fairly scans shops without a brand row and bounds concurrent public reads", async () => {
  const shops = Array.from({ length: 12 }, (_, i) => ({ id: `s${String(i).padStart(2, "0")}`, domain: `s${i}.myshopify.com`, installedAt: now }));
  const done = new Set<string>(); let active = 0; let peak = 0;
  const repository = { list: vi.fn(async (after: string | null, limit: number) => shops.filter(s => !after || s.id > after).slice(0, limit)),
   claim: vi.fn(async (shop: typeof shops[number]) => done.has(shop.id) ? { kind: "not_due" as const } : { kind: "claimed" as const, claim: { shopId: shop.id, shopDomain: shop.domain, installedAt: now.toISOString(), leaseOwner: "owner", leaseUntil: now.toISOString() } }),
   complete: vi.fn(async (claim: { shopId: string }) => { done.add(claim.shopId); return true; }), fail: vi.fn(async () => true) };
  const reader = { read: vi.fn(async () => { active++; peak = Math.max(peak, active); await Promise.resolve(); active--; return snapshot; }) };
  const service = new ShopifyBrandSourceSyncService({ repository, reader, logger, now: () => now, pageSize: 3, maxShopsPerTick: 5, maxSyncsPerTick: 2, concurrency: 2 });
  for (let i = 0; i < 6; i++) expect((await service.reconcileOnce()).claimed).toBeLessThanOrEqual(2);
  expect(done.size).toBe(12); expect(peak).toBeLessThanOrEqual(2); expect(repository.list.mock.calls.every(([, n]) => n <= 3)).toBe(true);
 });
 it("records CHANNEL_LOCKED without completing source observations and keeps persistence errors separate", async () => {
  const shop = { id: "s", domain: "s.myshopify.com", installedAt: now };
  const claim = { shopId: shop.id, shopDomain: shop.domain, installedAt: now.toISOString(), leaseOwner: "owner", leaseUntil: now.toISOString() };
  const repository = { list: vi.fn(async () => [shop]), claim: vi.fn(async () => ({ kind: "claimed" as const, claim })), complete: vi.fn(async () => true), fail: vi.fn(async () => true) };
  const reader = { read: vi.fn(async () => { throw new ShopifyBrandSyncError("CHANNEL_LOCKED", false); }) };
  const service = new ShopifyBrandSourceSyncService({ repository, reader, logger, now: () => now, maxSyncsPerTick: 1 });
  await service.reconcileOnce(); expect(repository.fail).toHaveBeenCalledWith(claim, "CHANNEL_LOCKED", false, null, now); expect(repository.complete).not.toHaveBeenCalled();
  reader.read.mockImplementation(async () => snapshot); repository.complete.mockRejectedValue(new Error("Persistence"));
  await expect(service.reconcileOnce()).rejects.toBeInstanceOf(AggregateError); expect(repository.fail).toHaveBeenCalledOnce();
 });
});
