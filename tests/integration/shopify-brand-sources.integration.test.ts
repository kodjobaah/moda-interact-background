import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { ShopBrandMediaRepository } from "../../src/services/shop-brand-media-orchestration/repository.js";
import { parseBrandDocument } from "../../src/services/shop-brand-media-orchestration/state.js";
import type { ShopifyBrandSnapshot } from "../../src/services/shop-brand-media-shopify/contracts.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;
const noopLogger = { warn: () => {}, error: () => {} };
const T0 = new Date("2026-10-26T12:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
function image(name: string) {
  return { url: `https://cdn.shopify.com/${name}.png`, reference: `shopify:${name}`, width: 360, height: 190 };
}
function snapshot(minute: number, options: {
  logo?: ReturnType<typeof image> | null;
  squareLogo?: ReturnType<typeof image> | null;
  coverImage?: ReturnType<typeof image> | null;
} = {}): ShopifyBrandSnapshot {
  return { observedAt: at(minute).toISOString(), brandName: "Brand Store",
    logo: options.logo === undefined ? image("logo") : options.logo,
    squareLogo: options.squareLogo ?? null,
    coverImage: options.coverImage === undefined ? image("cover") : options.coverImage };
}
async function createShop(db: PrismaClient, platform: "SHOPIFY" | "WOOCOMMERCE" = "SHOPIFY") {
  const id = `arch049_bg003_${randomUUID()}`;
  const domain = `bg003-${randomUUID().slice(0, 12)}.myshopify.com`;
  await db.shop.create({ data: { id, domain, platform, status: "ACTIVE" } });
  return { id, domain };
}

describeDb("ARCH-049 BG003 durable Shopify source sync in PostgreSQL", () => {
  it("first sync creates one ShopBrand, changes all 3 roles and keeps unrelated role updates", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const shop = await createShop(db);
    try {
      const a = new ShopBrandMediaRepository(db, noopLogger);
      const b = new ShopBrandMediaRepository(db, noopLogger);
      const [first, second] = await Promise.all([
        a.claimShopifySourceSync(shop.id, shop.domain, T0),
        b.claimShopifySourceSync(shop.id, shop.domain, T0),
      ]);
      expect([first, second].filter(Boolean)).toHaveLength(1);
      const claim = (first ?? second)!;
      // Concurrent media update during Shopify network I/O must survive its final commit.
      await b.observeSource({ shopId: shop.id, role: "COVER_IMAGE", sourceUrl: "https://cdn.shopify.com/interim.png",
        sourceReference: "shopify:interim", sourceFingerprint: null, observedAt: at(-1).toISOString() });
      expect(await a.completeShopifySourceSync(claim, snapshot(0), at(0.1))).toEqual({ applied: true, changedRoles: 3 });
      const row = await db.shopBrand.findUniqueOrThrow({ where: { shopId: shop.id } });
      expect(row.brandName).toBe("Brand Store");
      expect(row.logoUrl).toBe(image("logo").url);
      expect(row.logoWidth).toBe(360);
      expect(row.logoHeight).toBe(190);
      expect(row.logoAltText).toBeNull();
      expect(row.squareLogoUrl).toBeNull(); // Actual upstream did not provide a square image.
      expect(row.coverImageUrl).toBe(image("cover").url);
      const document = parseBrandDocument(row.whatsAppMedia);
      expect(document.roles.LOGO?.work.status).toBe("PENDING");
      expect(document.roles.SQUARE_LOGO?.source.url).toBe(image("logo").url);
      expect(document.roles.SQUARE_LOGO?.source.reference).toContain("fallback:");
      expect(document.roles.COVER_IMAGE?.source.generation).toBe(2);
      expect(document.shopifySourceSync?.lastSuccessfulAt).toBe(at(0.1).toISOString());
      expect(await db.shopBrand.count({ where: { shopId: shop.id } })).toBe(1);
      expect(await b.completeShopifySourceSync(claim, snapshot(1), at(1))).toEqual({ applied: false, changedRoles: 0 });
      expect(await b.claimShopifySourceSync(shop.id, shop.domain, at(20))).toBeNull();
      expect(await b.claimShopifySourceSync(shop.id, shop.domain, at(24 * 60 + 1))).not.toBeNull();
    } finally {
      await db.shop.delete({ where: { id: shop.id } });
      await db.$disconnect();
    }
  });

  it("successful removal marks missing; failures never erase fields; stale leases cannot write", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const shop = await createShop(db);
    try {
      const repo = new ShopBrandMediaRepository(db, noopLogger);
      const first = (await repo.claimShopifySourceSync(shop.id, shop.domain, T0))!;
      expect(await repo.completeShopifySourceSync(first, snapshot(0), at(0.1))).toMatchObject({ applied: true });
      const second = (await repo.claimShopifySourceSync(shop.id, shop.domain, at(24 * 60 + 1)))!;
      expect(second).not.toBeNull();
      expect(await repo.failShopifySourceSync(second, "SHOPIFY_THROTTLED", true, null,
        at(24 * 60 + 1.1))).toBe(true);
      const prior = await db.shopBrand.findUniqueOrThrow({ where: { shopId: shop.id } });
      expect(prior.logoUrl).toBe(image("logo").url);
      expect(prior.coverImageUrl).toBe(image("cover").url);
      expect(parseBrandDocument(prior.whatsAppMedia).shopifySourceSync?.failureCode).toBe("SHOPIFY_THROTTLED");
      expect(await repo.completeShopifySourceSync(second, snapshot(24 * 60 + 2), at(24 * 60 + 2)))
        .toMatchObject({ applied: false });
      const third = (await repo.claimShopifySourceSync(shop.id, shop.domain, at(24 * 60 + 3)))!;
      expect(await repo.completeShopifySourceSync(third, snapshot(24 * 60 + 3, {
        logo: null, coverImage: null,
      }), at(24 * 60 + 3.1))).toMatchObject({ applied: true });
      const removed = await db.shopBrand.findUniqueOrThrow({ where: { shopId: shop.id } });
      expect(removed.logoUrl).toBeNull();
      expect(removed.coverImageUrl).toBeNull();
      const doc = parseBrandDocument(removed.whatsAppMedia);
      expect(doc.roles.LOGO?.work.status).toBe("MISSING");
      expect(doc.roles.COVER_IMAGE?.work.status).toBe("MISSING");
      expect(doc.roles.SQUARE_LOGO?.work.status).toBe("MISSING");
    } finally {
      await db.shop.delete({ where: { id: shop.id } });
      await db.$disconnect();
    }
  });

  it("does not leak sources across shops or write to a WooCommerce shop", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const one = await createShop(db);
    const two = await createShop(db);
    const woo = await createShop(db, "WOOCOMMERCE");
    try {
      const repo = new ShopBrandMediaRepository(db, noopLogger);
      expect(await repo.claimShopifySourceSync(one.id, two.domain, T0)).toBeNull();
      expect(await repo.claimShopifySourceSync(woo.id, woo.domain, T0)).toBeNull();
      const claim = (await repo.claimShopifySourceSync(one.id, one.domain, T0))!;
      expect(await repo.completeShopifySourceSync({ ...claim, shopId: two.id }, snapshot(0), at(0.1)))
        .toMatchObject({ applied: false });
      expect(await repo.completeShopifySourceSync(claim, snapshot(0), at(0.1)))
        .toMatchObject({ applied: true });
      expect(await db.shopBrand.findUnique({ where: { shopId: two.id } })).toBeNull();
      expect(await db.shopBrand.findUnique({ where: { shopId: woo.id } })).toBeNull();
    } finally {
      await db.shop.deleteMany({ where: { id: { in: [one.id, two.id, woo.id] } } });
      await db.$disconnect();
    }
  });

  it("preserves newer individual-role observation against stale provider snapshot", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const shop = await createShop(db);
    try {
      const repo = new ShopBrandMediaRepository(db, noopLogger);
      const claim = (await repo.claimShopifySourceSync(shop.id, shop.domain, T0))!;
      // The Shopify request began at T0, but another source writer observed a newer
      // logo during network I/O. Finish while the original two-minute lease is valid;
      // an expired claim is correctly rejected before its observations are applied.
      await repo.observeSource({ shopId: shop.id, role: "LOGO", sourceUrl: "https://cdn.shopify.com/newer.png",
        sourceReference: "shopify:newer", sourceFingerprint: null, observedAt: at(1).toISOString() });
      expect(await repo.completeShopifySourceSync(claim, snapshot(0), at(1.1)))
        .toMatchObject({ applied: true });
      const row = await db.shopBrand.findUniqueOrThrow({ where: { shopId: shop.id } });
      expect(parseBrandDocument(row.whatsAppMedia).roles.LOGO?.source.url)
        .toBe("https://cdn.shopify.com/newer.png");
      expect(row.logoUrl).toBeNull(); // Previous source-only observation did not update legacy fields.
      expect(parseBrandDocument(row.whatsAppMedia).roles.SQUARE_LOGO?.source.url)
        .toBe("https://cdn.shopify.com/newer.png");
    } finally {
      await db.shop.delete({ where: { id: shop.id } });
      await db.$disconnect();
    }
  });

  it("rejects a provider response after its Shopify sync lease expires", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const shop = await createShop(db);
    try {
      const repo = new ShopBrandMediaRepository(db, noopLogger);
      const claim = (await repo.claimShopifySourceSync(shop.id, shop.domain, T0))!;
      expect(await repo.completeShopifySourceSync(claim, snapshot(0), at(3.1)))
        .toEqual({ applied: false, changedRoles: 0 });
      const row = await db.shopBrand.findUniqueOrThrow({ where: { shopId: shop.id } });
      expect(row.logoUrl).toBeNull();
      expect(parseBrandDocument(row.whatsAppMedia).roles).toEqual({});
    } finally {
      await db.shop.delete({ where: { id: shop.id } });
      await db.$disconnect();
    }
  });
});
