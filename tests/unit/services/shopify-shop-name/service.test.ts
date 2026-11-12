import { describe, expect, it, vi } from "vitest";
import { ShopNameSyncService } from "../../../../src/services/shopify-shop-name/service.js";
import { ShopNameReadError } from "../../../../src/services/shopify-shop-name/contracts.js";
import { parseBrandDocument, updateObservedSource, claimRole } from "../../../../src/services/shop-brand-media-orchestration/state.js";
const now = new Date("2026-11-12T00:00:00Z");
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
describe("bounded shop name sync", () => {
  it("cycles keyset pages fairly with bounded claims/reads and no grant requirement", async () => {
    const shops = Array.from({ length: 12 }, (_, i) => ({ id: `s${String(i).padStart(2, "0")}`, domain: `s${i}.myshopify.com`, installedAt: now }));
    const completed = new Set<string>();
    const repository = {
      list: vi.fn(async (after: string | null, limit: number) => shops.filter(s => !after || s.id > after).slice(0, limit)),
      claim: vi.fn(async (shop: typeof shops[number]) => completed.has(shop.id) ? null : { shopId: shop.id, domain: shop.domain, installedAt: now.toISOString(), leaseOwner: "owner", leaseUntil: now.toISOString() }),
      complete: vi.fn(async (claim: { shopId: string }) => { completed.add(claim.shopId); return true; }), fail: vi.fn(async () => true),
    };
    const reader = { read: vi.fn(async () => "Synthetic") };
    const service = new ShopNameSyncService({ repository, reader, logger, now: () => now, pageSize: 3, maxShopsPerTick: 5, maxSyncsPerTick: 2, concurrency: 2 });
    for (let i = 0; i < 6; i++) expect((await service.reconcileOnce()).claimed).toBeLessThanOrEqual(2);
    expect(completed.size).toBe(12); expect(reader.read).toHaveBeenCalledTimes(12);
    expect(repository.list.mock.calls.every(([, limit]) => limit <= 3)).toBe(true);
  });
  it("persists provider backoff but does not misclassify completion persistence failures", async () => {
    const shop = { id: "s", domain: "s.myshopify.com", installedAt: now };
    const claim = { shopId: shop.id, domain: shop.domain, installedAt: now.toISOString(), leaseOwner: "owner", leaseUntil: now.toISOString() };
    const repository = { list: vi.fn(async () => [shop]), claim: vi.fn(async () => claim), complete: vi.fn(async () => true), fail: vi.fn(async () => true) };
    const reader = { read: vi.fn(async () => { throw new ShopNameReadError("SHOPIFY_THROTTLED", true, 123000); }) };
    const service = new ShopNameSyncService({ repository, reader, logger, now: () => now, maxSyncsPerTick: 1 });
    await service.reconcileOnce(); expect(repository.fail).toHaveBeenCalledWith(claim, "SHOPIFY_THROTTLED", true, 123000, now);
    expect(repository.complete).not.toHaveBeenCalled(); reader.read.mockImplementation(async () => "Known good");
    repository.complete.mockRejectedValue(new Error("Persistence failed"));
    await expect(service.reconcileOnce()).rejects.toBeInstanceOf(AggregateError); expect(repository.fail).toHaveBeenCalledOnce();
  });
  it("retains durable name metadata through existing source observation and media claim", () => {
    const sync = { leaseOwner: "synthetic", attempts: 1 };
    const assetSync = { leaseOwner: "independent-asset-owner", attempts: 4, nextDueAt: "2026-11-13T00:00:00Z" };
    const document = parseBrandDocument({ schemaVersion: 1, roles: {}, shopifyNameSync: sync, shopifySourceSync: assetSync });
    const observed = updateObservedSource(document, { shopId: "s", role: "LOGO", sourceUrl: "https://cdn.example.test/logo.jpg", sourceReference: null, sourceFingerprint: `sha256:${"a".repeat(64)}`, observedAt: now.toISOString() }).document;
    expect(observed).toHaveProperty("shopifyNameSync", sync);
    expect(observed).toHaveProperty("shopifySourceSync", assetSync);
    const claimed = claimRole(observed, "s", "s.myshopify.com", "LOGO", "b".repeat(36), now).document;
    expect(claimed).toHaveProperty("shopifyNameSync", sync);
    expect(claimed).toHaveProperty("shopifySourceSync", assetSync);
  });
});
