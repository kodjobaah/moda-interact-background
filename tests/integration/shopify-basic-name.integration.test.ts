import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { ShopNameRepository } from "../../src/services/shopify-shop-name/repository.js";
import { NAME_LEASE_MS, NAME_REFRESH_MS } from "../../src/services/shopify-shop-name/contracts.js";
import { ShopBrandMediaRepository } from "../../src/services/shop-brand-media-orchestration/repository.js";
const suite = process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;
async function fixture() {
 const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL! });
 const id = `arch073-${randomUUID()}`; const now = new Date();
 const shop = await db.shop.create({ data: { id, domain: `${id}.myshopify.com`, status: "ACTIVE", installedAt: now } });
 const repository = new ShopNameRepository(db);
 return { db, shop, now, repository, close: async () => { await db.shop.delete({ where: { id } }); await db.$disconnect(); } };
}
suite("ARCH073 basic Shopify name durable acquisition", () => {
 it("creates absent brand once, arbitrates duplicate claims and refreshes only when due", async () => {
  const f = await fixture();
  try {
   expect(await f.db.shopBrand.findUnique({ where: { shopId: f.shop.id } })).toBeNull();
   const claims = await Promise.all([f.repository.claim(f.shop, f.now), f.repository.claim(f.shop, f.now)]);
   expect(claims.filter(Boolean)).toHaveLength(1); const claim = claims.find(Boolean)!;
   expect(await f.repository.complete(claim, "Synthetic Shop", new Date(f.now.getTime() + 1))).toBe(true);
   const row = await f.db.shopBrand.findUniqueOrThrow({ where: { shopId: f.shop.id } });
   expect(row.brandName).toBe("Synthetic Shop"); expect(row.logoUrl).toBeNull();
   expect(await f.repository.complete(claim, "Late overwrite", new Date(f.now.getTime() + 2))).toBe(false);
   expect(await f.repository.claim(f.shop, new Date(f.now.getTime() + 1000))).toBeNull();
   expect(await f.repository.claim(f.shop, new Date(f.now.getTime() + NAME_REFRESH_MS + 2))).not.toBeNull();
  } finally { await f.close(); }
 }, 120000);
 it("rejects expired/replaced leases and retains known names while durable failures back off", async () => {
  const f = await fixture();
  try {
   await f.db.shopBrand.create({ data: { shopId: f.shop.id, brandName: "Known name" } });
   const first = (await f.repository.claim(f.shop, f.now))!;
   expect(await f.repository.complete(first, "Expired", new Date(f.now.getTime() + NAME_LEASE_MS))).toBe(false);
   const later = new Date(f.now.getTime() + NAME_LEASE_MS + 1);
   const next = (await f.repository.claim(f.shop, later))!;
   expect(await f.repository.complete(first, "Stale", later)).toBe(false);
   expect(await f.repository.fail(next, "SHOPIFY_THROTTLED", true, 123000, later)).toBe(true);
   expect(await f.repository.claim(f.shop, new Date(later.getTime() + 122999))).toBeNull();
   expect(await f.repository.claim(f.shop, new Date(later.getTime() + 123001))).not.toBeNull();
   expect((await f.db.shopBrand.findUniqueOrThrow({ where: { shopId: f.shop.id } })).brandName).toBe("Known name");
  } finally { await f.close(); }
 }, 120000);
 it.each(["domain", "status", "platform", "uninstalledAt", "installedAt", "reinstallPendingAt"] as const)("rejects installation identity changed during read: %s", async field => {
  const f = await fixture();
  try {
   const claim = (await f.repository.claim(f.shop, f.now))!;
   const changes = { domain: `${randomUUID()}.myshopify.com`, status: "UNINSTALLED", platform: "WOOCOMMERCE", uninstalledAt: new Date(), installedAt: new Date(f.now.getTime() + 1), reinstallPendingAt: new Date() };
   await f.db.shop.update({ where: { id: f.shop.id }, data: { [field]: changes[field] } });
   expect(await f.repository.complete(claim, "Wrong installation", new Date(f.now.getTime() + 2))).toBe(false);
   expect(await f.repository.claim(f.shop, new Date(f.now.getTime() + NAME_LEASE_MS + 1))).toBeNull();
   expect((await f.db.shopBrand.findUniqueOrThrow({ where: { shopId: f.shop.id } })).brandName).toBeNull();
  } finally { await f.close(); }
 }, 120000);
 it("preserves concurrent media updates and name lease across both locking paths", async () => {
  const f = await fixture(); const media = new ShopBrandMediaRepository(f.db, { warn: vi.fn(), error: vi.fn() });
  try {
   const claim = (await f.repository.claim(f.shop, f.now))!;
   const claimedBrand = await f.db.shopBrand.findUniqueOrThrow({ where: { shopId: f.shop.id } });
   const assetSync = { leaseOwner: "independent-asset-owner", attempts: 4, nextDueAt: "2026-11-13T00:00:00Z" };
   await f.db.shopBrand.update({ where: { shopId: f.shop.id }, data: {
    whatsAppMedia: { ...(claimedBrand.whatsAppMedia as Prisma.JsonObject), shopifySourceSync: assetSync },
   } });
   await Promise.all([
    media.observeSource({ shopId: f.shop.id, role: "LOGO", sourceUrl: "https://cdn.example.test/logo.jpg", sourceReference: "provider-logo", sourceFingerprint: `sha256:${"a".repeat(64)}`, observedAt: f.now.toISOString() }),
    f.repository.complete(claim, "Synthetic Concurrent Shop", new Date(f.now.getTime() + 1)),
   ]);
   const row = await f.db.shopBrand.findUniqueOrThrow({ where: { shopId: f.shop.id } });
   expect(row.brandName).toBe("Synthetic Concurrent Shop");
   expect(row.whatsAppMedia).toMatchObject({ roles: { LOGO: { source: { reference: "provider-logo", generation: 1 } } }, shopifyNameSync: { attempts: 0, leaseOwner: null } });
   const mediaClaim = await media.claim(f.shop.id, "LOGO", new Date(f.now.getTime() + 2));
   expect(mediaClaim).not.toBeNull();
   const after = await f.db.shopBrand.findUniqueOrThrow({ where: { shopId: f.shop.id } });
   expect(after.whatsAppMedia).toHaveProperty("shopifyNameSync.nextDueAt");
   expect(after.whatsAppMedia).toHaveProperty("shopifySourceSync", assetSync);
  } finally { await f.close(); }
 }, 120000);
});
