import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { ShopifyBrandSourceRepository } from "../../src/services/shop-brand-media-shopify/repository.js";
import { SHOPIFY_BRAND_SYNC_INTERVAL_MS, SHOPIFY_BRAND_SYNC_LEASE_MS } from "../../src/services/shop-brand-media-shopify/contracts.js";
import { ShopNameRepository } from "../../src/services/shopify-shop-name/repository.js";
import { ShopBrandMediaRepository } from "../../src/services/shop-brand-media-orchestration/repository.js";
import { currentReady, parseBrandDocument } from "../../src/services/shop-brand-media-orchestration/state.js";
const suite = process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;
const image = { url: "https://cdn.shopify.com/synthetic.png", reference: `shopify-storefront:sha256:${"a".repeat(64)}`, width: 480, height: 180 };
async function fixture() {
 const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL! }); const now = new Date();
 const id = `arch073asset-${randomUUID()}`;
 const shop = await db.shop.create({ data: { id, domain: `${id}.myshopify.com`, installedAt: now } });
 const repository = new ShopifyBrandSourceRepository(db); const media = new ShopBrandMediaRepository(db, { warn: vi.fn(), error: vi.fn() });
 const snapshot = (at = now, logo: typeof image | null = image) => ({ logo, squareLogo: null, coverImage: null, observedAt: at.toISOString() });
 async function claim(at = now) { const result = await repository.claim(shop, at); if (result.kind !== "claimed") throw new Error("Expected asset claim"); return result.claim; }
 return { db, now, shop, repository, media, snapshot, claim, close: async () => { await db.shop.delete({ where: { id } }); await db.$disconnect(); } };
}
suite("public brand acquisition durable tenant/source boundaries", () => {
 it("creates an absent row, arbitrates competing claims, maps roles and leaves name scheduler independent", async () => {
  const f = await fixture();
  try {
   const names = new ShopNameRepository(f.db); const name = (await names.claim(f.shop, f.now))!;
   expect(await names.complete(name, "Independent name", f.now)).toBe(true);
   const claims = await Promise.all([f.repository.claim(f.shop, f.now), f.repository.claim(f.shop, f.now)]);
   expect(claims.filter(x => x.kind === "claimed")).toHaveLength(1); const result = claims.find(x => x.kind === "claimed")!;
   if (result.kind !== "claimed") throw new Error("No asset claim");
   expect(await f.repository.complete(result.claim, f.snapshot(), new Date(f.now.getTime() + 1))).toBe(true);
   const brand = await f.db.shopBrand.findUniqueOrThrow({ where: { shopId: f.shop.id } });
   expect(brand.brandName).toBe("Independent name"); expect(brand.logoUrl).toBe(image.url); expect(brand.squareLogoUrl).toBeNull();
   expect(brand.whatsAppMedia).toMatchObject({ shopifyNameSync: { attempts: 0, leaseOwner: null }, shopifySourceSync: { attempts: 0, leaseOwner: null }, roles: {
    LOGO: { source: { generation: 1, url: image.url }, work: { status: "PENDING" } }, SQUARE_LOGO: { source: { url: image.url } }, COVER_IMAGE: { work: { status: "MISSING" } },
   } });
   expect(await f.repository.claim(f.shop, new Date(f.now.getTime() + 1000))).toEqual({ kind: "not_due" });
   expect((await f.repository.claim(f.shop, new Date(f.now.getTime() + SHOPIFY_BRAND_SYNC_INTERVAL_MS + 2))).kind).toBe("claimed");
  } finally { await f.close(); }
 }, 120000);
 it("retains current READY/known fields on CHANNEL_LOCKED and transient failure; only validated null removes source", async () => {
  const f = await fixture();
  try {
   const names = new ShopNameRepository(f.db); const nameClaim = (await names.claim(f.shop, f.now))!;
   await names.complete(nameClaim, "Authenticated name retained", f.now);
   const first = await f.claim(); await f.repository.complete(first, f.snapshot(), new Date(f.now.getTime() + 1));
   const media = (await f.media.claim(f.shop.id, "LOGO", new Date(f.now.getTime() + 2)))!;
   const hash = "b".repeat(64);
   expect(await f.media.complete(media, { result: { sourceGeneration: media.generation, sourceFingerprint: media.fingerprint,
    objectKey: `shop-brands/${f.shop.domain}/logo/sha256-${hash}.jpg`, contentType: "image/jpeg", width: 1125, height: 600, sizeBytes: 1000, contentSha256: hash }, verifiedAt: new Date(f.now.getTime() + 3).toISOString() }, new Date(f.now.getTime() + 3))).toBe(true);
   const later = new Date(f.now.getTime() + SHOPIFY_BRAND_SYNC_INTERVAL_MS + 2); const locked = await f.claim(later);
   expect(await f.repository.fail(locked, "CHANNEL_LOCKED", false, null, later)).toBe(true);
   let row = await f.db.shopBrand.findUniqueOrThrow({ where: { shopId: f.shop.id } });
   expect(row.brandName).toBe("Authenticated name retained");
   expect(row.logoUrl).toBe(image.url); expect(currentReady(parseBrandDocument(row.whatsAppMedia).roles.LOGO!)).not.toBeNull();
   const due = new Date(later.getTime() + SHOPIFY_BRAND_SYNC_INTERVAL_MS + 1); const retry = await f.claim(due);
   expect(await f.repository.fail(retry, "SHOPIFY_THROTTLED", true, 123000, due)).toBe(true);
   expect((await f.repository.claim(f.shop, new Date(due.getTime() + 299999))).kind).toBe("not_due");
   const removedAt = new Date(due.getTime() + 300001); const removed = await f.claim(removedAt);
   expect(await f.repository.complete(removed, f.snapshot(removedAt, null), removedAt)).toBe(true);
   row = await f.db.shopBrand.findUniqueOrThrow({ where: { shopId: f.shop.id } });
   expect(row.brandName).toBe("Authenticated name retained");
   expect(row.whatsAppMedia).toHaveProperty("shopifyNameSync.lastSuccessfulAt");
   expect(row.logoUrl).toBeNull(); expect(parseBrandDocument(row.whatsAppMedia).roles.LOGO!.work.status).toBe("MISSING");
  } finally { await f.close(); }
 }, 120000);
 it("rejects expired/replaced leases and preserves newer source observations during network latency", async () => {
  const f = await fixture();
  try {
   const first = await f.claim(); const later = new Date(f.now.getTime() + SHOPIFY_BRAND_SYNC_LEASE_MS + 1);
   expect(await f.repository.complete(first, f.snapshot(), later)).toBe(false); const second = await f.claim(later);
   expect(await f.repository.complete(first, f.snapshot(), later)).toBe(false);
   const newer = new Date(later.getTime() + 2);
   await f.media.observeSource({ shopId: f.shop.id, role: "LOGO", sourceUrl: "https://cdn.shopify.com/newer.png", sourceReference: "newer-public-source", sourceFingerprint: null, observedAt: newer.toISOString() });
   expect(await f.repository.complete(second, f.snapshot(later), new Date(newer.getTime() + 1))).toBe(true);
   const row = await f.db.shopBrand.findUniqueOrThrow({ where: { shopId: f.shop.id } });
   expect(parseBrandDocument(row.whatsAppMedia).roles.LOGO?.source.url).toBe("https://cdn.shopify.com/newer.png");
   expect(parseBrandDocument(row.whatsAppMedia).roles.SQUARE_LOGO?.source.url).toBe("https://cdn.shopify.com/newer.png");
  } finally { await f.close(); }
 }, 120000);
 it.each(["domain", "status", "platform", "uninstalledAt", "installedAt", "reinstallPendingAt"] as const)("rejects changed installation identity under final locks: %s", async field => {
  const f = await fixture();
  try {
   const claim = await f.claim();
   const changes = { domain: `${randomUUID()}.myshopify.com`, status: "UNINSTALLED", platform: "WOOCOMMERCE", uninstalledAt: new Date(), installedAt: new Date(f.now.getTime() + 1), reinstallPendingAt: new Date() };
   await f.db.shop.update({ where: { id: f.shop.id }, data: { [field]: changes[field] } });
   expect(await f.repository.complete(claim, f.snapshot(), new Date(f.now.getTime() + 2))).toBe(false);
   expect((await f.repository.claim(f.shop, new Date(f.now.getTime() + SHOPIFY_BRAND_SYNC_LEASE_MS + 1))).kind).toBe("not_due");
   expect((await f.db.shopBrand.findUniqueOrThrow({ where: { shopId: f.shop.id } })).logoUrl).toBeNull();
  } finally { await f.close(); }
 }, 120000);
 it("serializes concurrent asset completion, name update and media claim without clobbering metadata", async () => {
  const f = await fixture();
  try {
   const asset = await f.claim(); const names = new ShopNameRepository(f.db); const name = (await names.claim(f.shop, f.now))!;
   await Promise.all([f.repository.complete(asset, f.snapshot(), new Date(f.now.getTime() + 1)), names.complete(name, "Concurrent name", new Date(f.now.getTime() + 1))]);
   await f.media.claim(f.shop.id, "LOGO", new Date(f.now.getTime() + 2));
   const row = await f.db.shopBrand.findUniqueOrThrow({ where: { shopId: f.shop.id } });
   expect(row.brandName).toBe("Concurrent name");
   expect(row.whatsAppMedia as Prisma.JsonObject).toMatchObject({ shopifyNameSync: { leaseOwner: null, attempts: 0 }, shopifySourceSync: { leaseOwner: null, attempts: 0 }, roles: { LOGO: { work: { status: "PROCESSING" } } } });
  } finally { await f.close(); }
 }, 120000);
});
