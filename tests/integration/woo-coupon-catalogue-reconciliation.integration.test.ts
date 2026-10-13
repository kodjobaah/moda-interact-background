import "dotenv/config";

import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { WooCouponCatalogueService } from "../../src/services/woo-coupon-catalogue.service.js";
import { WooCouponReadError } from "../../src/providers/woo-coupon-transport.js";

const url = process.env.TEST_DATABASE_URL;
const describeWithDatabase = url && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;
const NOW = new Date("2026-10-13T12:00:00Z");
const coupon = (id: number, code: string) => ({
  id, code, discount_type: "percent", amount: "10.00", usage_count: 0,
  usage_limit: null, date_expires_gmt: null,
});

async function fixture(db: PrismaClient): Promise<string> {
  const uuid = randomUUID();
  const shopId = `arch036-woo-${uuid}`;
  const domain = `https://${uuid}.example.test`;
  await db.shop.create({ data: { id: shopId, domain, platform: "WOOCOMMERCE", status: "ACTIVE" } });
  const installation = await db.wooCommerceInstallation.create({
    data: { shopId, canonicalSiteUrl: domain, credentialDigest: randomBytes(32) },
  });
  // ARCH-026's database guards require the attempt to begin PENDING and
  // transition to SUCCEEDED in the SAME transaction that creates the grant.
  await db.$transaction(async (tx) => {
    const attempt = await tx.wooCommerceRestReadAttempt.create({
      data: {
        installationId: installation.id, shopId, tokenDigest: randomBytes(32),
        credentialVersionSnapshot: installation.credentialVersion,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    const succeeded = await tx.wooCommerceRestReadAttempt.update({
      where: { id: attempt.id },
      data: { status: "SUCCEEDED", consumedAt: new Date() },
    });
    await tx.wooCommerceRestReadGrant.create({
      data: {
        installationId: installation.id, shopId, authorizationAttemptId: attempt.id,
        authorizationAttemptSequence: succeeded.attemptSequence,
        credentialVersionSnapshot: installation.credentialVersion,
        credentialCiphertext: randomBytes(64), credentialNonce: randomBytes(12),
        credentialAuthTag: randomBytes(16), encryptionKeyId: "integration-fixture",
        providerKeyId: "integration-fixture", authorizedScope: "read", verifiedAt: new Date(),
      },
    });
  });
  await db.shopifyDiscountCatalogue.create({
    data: { shopId, status: "SYNC_REQUIRED", syncRequestedAt: NOW },
  });
  return shopId;
}

describeWithDatabase("ARCH-036 Woo coupon PostgreSQL reconciliation", () => {
  it("imports two shops independently, preserves selection on code change/removal, and retains Shopify", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const shops: string[] = [];
    try {
      const a = await fixture(db); shops.push(a);
      const b = await fixture(db); shops.push(b);
      const shopifyId = `arch036-shopify-${randomUUID()}`;
      shops.push(shopifyId);
      await db.shop.create({ data: { id: shopifyId, domain: `${shopifyId}.myshopify.com`, platform: "SHOPIFY" } });
      await db.shopifyDiscountCatalogue.create({ data: { shopId: shopifyId, status: "CURRENT" } });
      const runner = new WooCouponCatalogueService(db, async (shopId) => shopId === a
        ? [coupon(100, "SAVE10"), coupon(101, "SAVE15")] : [coupon(200, "OTHER")], () => NOW);
      expect(await runner.reconcile(a, NOW)).toBe("current");
      expect(await runner.reconcile(b, NOW)).toBe("current");
      expect(await runner.reconcile(shopifyId, NOW)).toBe("unavailable");
      expect(await db.shopifyDiscount.count({ where: { shopId: shopifyId } })).toBe(0);
      const discount = await db.shopifyDiscount.findUniqueOrThrow({
        where: { shopId_shopifyDiscountNodeId: { shopId: a, shopifyDiscountNodeId: "woo:coupon:100" } },
      });
      await db.shopifyDiscount.update({ where: { id: discount.id }, data: { isAvailable: true } });
      const next = new Date("2026-10-13T13:00:00Z");
      await db.shopifyDiscountCatalogue.update({ where: { shopId: a }, data: { syncRequestedAt: next } });
      expect(await new WooCouponCatalogueService(db, async () => [coupon(101, "UPDATED")], () => next)
        .reconcile(a, next)).toBe("current");
      const stillSelected = await db.shopifyDiscount.findUniqueOrThrow({ where: { id: discount.id } });
      expect(stillSelected.isAvailable).toBe(true);
      expect(stillSelected.providerStatus).toBe("REMOVED");
      expect(stillSelected.fixedSelectable).toBe(false);
      expect(stillSelected.unavailableAt).not.toBeNull();
      expect(await db.shopifyDiscount.count({ where: { shopId: b } })).toBe(1);
    } finally {
      await db.shop.deleteMany({ where: { id: { in: shops } } });
      await db.$disconnect();
    }
  }, 40_000);

  it("allows only one live scan to claim the same shop across concurrent workers", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const shop = await fixture(db);
    let release!: (coupons: Record<string, unknown>[]) => void;
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<Record<string, unknown>[]>((resolve) => { release = resolve; });
    try {
      const first = new WooCouponCatalogueService(db, async () => { entered(); return pending; }, () => NOW);
      const running = first.reconcile(shop, NOW);
      await reading; // First worker has committed its claim and started the provider read.
      const other = new WooCouponCatalogueService(db, async () => [coupon(99, "OTHER")], () => NOW);
      expect(await other.reconcile(shop, NOW)).toBe("already-running");
      release([coupon(1, "FIRST")]);
      expect(await running).toBe("current");
      expect(await db.shopifyDiscount.count({ where: { shopId: shop } })).toBe(1);
    } finally {
      release?.([]);
      await db.shop.delete({ where: { id: shop } });
      await db.$disconnect();
    }
  }, 40_000);

  it("rolls back an incomplete provider scan and retains all prior rows", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const shop = await fixture(db);
    try {
      expect(await new WooCouponCatalogueService(db, async () => [coupon(1, "FIRST")], () => NOW)
        .reconcile(shop, NOW)).toBe("current");
      const previous = await db.shopifyDiscount.findMany({ where: { shopId: shop } });
      const next = new Date("2026-10-13T13:00:00Z");
      await db.shopifyDiscountCatalogue.update({ where: { shopId: shop }, data: { syncRequestedAt: next } });
      await expect(new WooCouponCatalogueService(db,
        async () => { throw new WooCouponReadError("incomplete_pages"); }, () => next)
        .reconcile(shop, next)).rejects.toThrow("incomplete_pages");
      expect(await db.shopifyDiscount.findMany({ where: { shopId: shop } })).toEqual(previous);
      const catalogue = await db.shopifyDiscountCatalogue.findUniqueOrThrow({ where: { shopId: shop } });
      expect(catalogue.status).toBe("ERROR");
      expect(catalogue.lastSuccessfulSyncAt?.toISOString()).toBe(NOW.toISOString());
    } finally {
      await db.shop.delete({ where: { id: shop } });
      await db.$disconnect();
    }
  }, 40_000);
});
