import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ShopifyBrandSyncError, type ShopifyBrandSnapshot } from "../../../../src/services/shop-brand-media-shopify/contracts.js";
import { ShopifyBrandSourceSyncService, type ShopifyBrandSyncRepository } from "../../../../src/services/shop-brand-media-shopify/service.js";
import type { ShopifyShopScanRow } from "../../../../src/services/shop-brand-media-orchestration/repository.js";
import { parseBrandDocument, claimRole, updateObservedSource } from "../../../../src/services/shop-brand-media-orchestration/state.js";
import type { BrandDocument } from "../../../../src/services/shop-brand-media-orchestration/contracts.js";

const T0 = new Date("2026-10-26T12:00:00.000Z");
const merchant = (i: number): ShopifyShopScanRow => ({
  id: `shop_${i}`, domain: `shop-${i}.myshopify.com`, brand: null,
});
const observation: ShopifyBrandSnapshot = {
  brandName: "Shop Name", logo: null, squareLogo: null, coverImage: null,
  observedAt: T0.toISOString(),
};
const audit = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
function mockRepo(rows: ShopifyShopScanRow[]) {
  const attempts: string[] = [];
  const repo: ShopifyBrandSyncRepository = {
    listShopifyShopsPage: vi.fn(async (cursor, limit) => {
      const start = cursor ? rows.findIndex((r) => r.id === cursor) + 1 : 0;
      return rows.slice(start, start + limit);
    }),
    claimShopifySourceSync: vi.fn(async (id, domain) => {
      attempts.push(id);
      return { shopId: id, shopDomain: domain, leaseOwner: randomUUID(),
        leaseUntil: new Date(T0.getTime() + 120_000).toISOString() };
    }),
    completeShopifySourceSync: vi.fn(async () => ({ applied: true, changedRoles: 3 })),
    failShopifySourceSync: vi.fn(async () => true),
  };
  return { repo, attempts };
}

describe("ARCH-049 BG003 bounded source scheduler", () => {
  it("initiates new shops without ShopBrand, bounds each sweep and cycles fairly", async () => {
    const { repo, attempts } = mockRepo(Array.from({ length: 9 }, (_, i) => merchant(i)));
    const service = new ShopifyBrandSourceSyncService({
      repository: repo, reader: { read: async () => observation }, grantForShop: async () => "GRANTED",
      logger: audit, now: () => T0, pageSize: 2, maxShopsPerTick: 4, maxSyncsPerTick: 2, concurrency: 1,
    });
    expect((await service.reconcileOnce()).claimed).toBe(2);
    expect((await service.reconcileOnce()).claimed).toBe(2);
    expect(attempts).toEqual(["shop_0", "shop_1", "shop_2", "shop_3"]);
    expect(repo.completeShopifySourceSync).toHaveBeenCalledTimes(4);
    expect(repo.failShopifySourceSync).not.toHaveBeenCalled();
  });

  it("skips shops whose persisted nextDue is in the future and never refreshes them too soon", async () => {
    const row = merchant(1);
    row.brand = { whatsAppMedia: { schemaVersion: 1, roles: {}, shopifySourceSync: {
      lastSuccessfulAt: T0.toISOString(), nextDueAt: new Date(T0.getTime() + 86_400_000).toISOString(),
      lastAttemptAt: T0.toISOString(), attempts: 0, failureCode: null, leaseOwner: null, leaseUntil: null,
    } } };
    const { repo } = mockRepo([row]);
    const service = new ShopifyBrandSourceSyncService({
      repository: repo, reader: { read: async () => observation }, grantForShop: async () => "GRANTED",
      logger: audit, now: () => T0,
    });
    expect((await service.reconcileOnce()).claimed).toBe(0);
    expect(repo.claimShopifySourceSync).not.toHaveBeenCalled();
  });

  it("missing read_brand fails closed and never calls Shopify", async () => {
    const { repo } = mockRepo([merchant(1)]);
    const read = vi.fn(async () => observation);
    const service = new ShopifyBrandSourceSyncService({
      repository: repo, reader: { read }, grantForShop: async () => "MISSING_READ_BRAND_SCOPE",
      logger: audit, now: () => T0,
    });
    await service.reconcileOnce();
    expect(read).not.toHaveBeenCalled();
    expect(repo.completeShopifySourceSync).not.toHaveBeenCalled();
    expect(repo.failShopifySourceSync).toHaveBeenCalledWith(expect.anything(),
      "MISSING_READ_BRAND_SCOPE", false, null, T0);
  });

  it("provider throttling persists backoff without ever writing null sources", async () => {
    const { repo } = mockRepo([merchant(1)]);
    const service = new ShopifyBrandSourceSyncService({
      repository: repo, reader: { read: async () => { throw new ShopifyBrandSyncError("SHOPIFY_THROTTLED", true, 10_000); } },
      grantForShop: async () => "GRANTED", logger: audit, now: () => T0,
    });
    await service.reconcileOnce();
    expect(repo.completeShopifySourceSync).not.toHaveBeenCalled();
    expect(repo.failShopifySourceSync).toHaveBeenCalledWith(expect.anything(), "SHOPIFY_THROTTLED", true, 10_000, T0);
  });

  it("does not misclassify a persistence exception as an upstream API error", async () => {
    const { repo } = mockRepo([merchant(1)]);
    vi.mocked(repo.completeShopifySourceSync).mockRejectedValue(new Error("db error"));
    const service = new ShopifyBrandSourceSyncService({ repository: repo,
      reader: { read: async () => observation }, grantForShop: async () => "GRANTED", logger: audit, now: () => T0 });
    await expect(service.reconcileOnce()).rejects.toThrow("SHOPIFY_BRAND_SYNC_CYCLE_FAILED");
    expect(repo.failShopifySourceSync).not.toHaveBeenCalled();
  });

  it("preserves durable Shopify sync metadata across BG002 observations and media claims", () => {
    const sync = { lastSuccessfulAt: T0.toISOString(), nextDueAt: new Date(T0.getTime() + 86_400_000).toISOString(),
      lastAttemptAt: T0.toISOString(), attempts: 0, failureCode: null, leaseOwner: null, leaseUntil: null };
    const document: BrandDocument = { schemaVersion: 1, roles: {}, shopifySourceSync: sync };
    const observed = updateObservedSource(document, { shopId: "shop_1", role: "LOGO",
      sourceUrl: "https://cdn.shopify.com/logo.jpg", sourceReference: "shopify:1", sourceFingerprint: null,
      observedAt: T0.toISOString() }).document;
    expect(observed.shopifySourceSync).toEqual(sync);
    const claim = claimRole(observed, "shop_1", "LOGO", randomUUID(), new Date(T0.getTime() + 1000));
    expect(claim.document.shopifySourceSync).toEqual(sync);
    expect(parseBrandDocument(claim.document).shopifySourceSync).toEqual(sync);
  });
});
