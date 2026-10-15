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
      expect(stillSelected.providerStatus).toBe("ACTIVE");
      expect(stillSelected.fixedSelectable).toBe(true);
      expect(stillSelected.unavailableAt).toBeNull();
      const failed = new Date("2026-10-13T14:00:00Z");
      await db.shopifyDiscountCatalogue.update({ where: { shopId: a }, data: { syncRequestedAt: failed } });
      await expect(new WooCouponCatalogueService(db,
        async () => { throw new WooCouponReadError("incomplete_pages"); }, () => failed)
        .reconcile(a, failed)).rejects.toThrow("incomplete_pages");
      const confirmed = new Date("2026-10-13T15:00:00Z");
      await db.shopifyDiscountCatalogue.update({ where: { shopId: a }, data: { syncRequestedAt: confirmed } });
      expect(await new WooCouponCatalogueService(db, async () => [coupon(101, "UPDATED")], () => confirmed)
        .reconcile(a, confirmed)).toBe("current");
      const removed = await db.shopifyDiscount.findUniqueOrThrow({ where: { id: discount.id } });
      expect(removed.isAvailable).toBe(true);
      expect(removed.providerStatus).toBe("REMOVED");
      expect(removed.fixedSelectable).toBe(false);
      expect(removed.unavailableAt).toEqual(confirmed);
      const reappeared = new Date("2026-10-13T16:00:00Z");
      await db.shopifyDiscountCatalogue.update({ where: { shopId: a }, data: { syncRequestedAt: reappeared } });
      expect(await new WooCouponCatalogueService(db, async () => [coupon(100, "RETURNED"), coupon(101, "UPDATED")], () => reappeared)
        .reconcile(a, reappeared)).toBe("current");
      expect(await db.shopifyDiscount.findUniqueOrThrow({ where: { id: discount.id } }))
        .toMatchObject({ isAvailable: true, providerStatus: "ACTIVE", singleRedeemCode: "RETURNED", unavailableAt: null });
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

describeWithDatabase("ARCH-036 persisted stale per-shop generation fence", () => {
  it("lets an expired shop claim be replaced but forbids the old reader from committing", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const shopId = await fixture(db);
    let entered!: () => void;
    let release!: (items: Record<string, unknown>[]) => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const delayed = new Promise<Record<string, unknown>[]>((resolve) => { release = resolve; });
    try {
      const old = new WooCouponCatalogueService(db, async () => { entered(); return delayed; }, () => NOW);
      const oldRun = old.reconcile(shopId, NOW);
      await started;
      const firstClaim = await db.shopifyDiscountCatalogue.findUniqueOrThrow({ where: { shopId } });
      expect(firstClaim.status).toBe("SYNCING");
      const next = new Date(NOW.getTime() + 16 * 60_000);
      await db.shopifyDiscountCatalogue.update({ where: { shopId }, data: { syncRequestedAt: next } });
      const successor = new WooCouponCatalogueService(db, async () => [coupon(2, "SUCCESSOR")], () => next);
      expect(await successor.reconcile(shopId, next)).toBe("current");
      const newer = await db.shopifyDiscountCatalogue.findUniqueOrThrow({ where: { shopId } });
      expect(newer.syncGeneration).toBe(firstClaim.syncGeneration + 1);
      expect(newer.status).toBe("CURRENT");
      release([coupon(1, "STALE")]);
      expect(await oldRun).toBe("superseded");
      expect(await db.shopifyDiscountCatalogue.findUniqueOrThrow({ where: { shopId } }))
        .toMatchObject({ syncGeneration: newer.syncGeneration, status: "CURRENT", activeSyncToken: null });
      const coupons = await db.shopifyDiscount.findMany({ where: { shopId } });
      expect(coupons).toHaveLength(1);
      expect(coupons[0]?.singleRedeemCode).toBe("SUCCESSOR");
    } finally {
      release?.([]);
      await db.shop.delete({ where: { id: shopId } });
      await db.$disconnect();
    }
  }, 60_000);
});

describeWithDatabase("ARCH-036 BACKGROUND-005 merchant-controlled Woo catalogues", () => {
  it("commits mixed provider coupons and >255-code as CURRENT, preserves selection across code loss and recovery", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const shop = await fixture(db);
    const extendedCode = `CUSTOM${"Q".repeat(350)}`;
    const mixed = [
      ...[1, 2, 3, 4, 5].map((id) => coupon(id, `CODE${id}`)),
      { ...coupon(6, extendedCode), discount_type: "plugin-defined-coupon", amount: "0",
        date_expires_gmt: "invalid date", product_ids: ["unexpected"], usage_limit: "many" },
      { ...coupon(7, "HAS-NO-CODE"), code: null },
    ];
    const sync = async (time: Date, rows: Record<string, unknown>[]) => {
      await db.shopifyDiscountCatalogue.update({ where: { shopId: shop }, data: { syncRequestedAt: time } });
      return new WooCouponCatalogueService(db, async () => rows, () => time).reconcile(shop, time);
    };
    try {
      expect(await sync(NOW, mixed)).toBe("current");
      expect(await db.shopifyDiscount.count({ where: { shopId: shop } })).toBe(7);
      const six = await db.shopifyDiscount.findUniqueOrThrow({ where: {
        shopId_shopifyDiscountNodeId: { shopId: shop, shopifyDiscountNodeId: "woo:coupon:6" },
      } });
      expect(six).toMatchObject({
        singleRedeemCode: extendedCode, fixedSelectable: true, providerStatus: "ACTIVE",
        isAvailable: false,
      });
      expect(six.providerSnapshot).toMatchObject({ discountType: "plugin-defined-coupon", amount: "0" });
      const seven = await db.shopifyDiscount.findUniqueOrThrow({ where: {
        shopId_shopifyDiscountNodeId: { shopId: shop, shopifyDiscountNodeId: "woo:coupon:7" },
      } });
      expect(seven).toMatchObject({ singleRedeemCode: null, fixedSelectable: false,
        providerStatus: "UNDELIVERABLE", isAvailable: false });
      await db.shopifyDiscount.update({ where: { id: six.id }, data: { isAvailable: true } });
      const again = new Date("2026-10-13T13:00:00Z");
      expect(await sync(again, [
        ...mixed.slice(0, 5), { ...coupon(6, "UNSAFE\\nHEADER"), code: "UNSAFE\nHEADER" }, mixed[6]!,
      ])).toBe("current");
      expect(await db.shopifyDiscount.findUniqueOrThrow({ where: { id: six.id } })).toMatchObject({
        isAvailable: true, providerStatus: "UNDELIVERABLE", fixedSelectable: false,
        singleRedeemCode: null, unavailableAt: null,
      });
      const twice = new Date("2026-10-13T14:00:00Z");
      expect(await sync(twice, [
        ...mixed.slice(0, 5), { ...coupon(6, ""), code: null }, mixed[6]!,
      ])).toBe("current");
      expect(await db.shopifyDiscount.findUniqueOrThrow({ where: { id: six.id } })).toMatchObject({
        isAvailable: true, providerStatus: "UNDELIVERABLE", unavailableAt: null,
      });
      const recovered = new Date("2026-10-13T15:00:00Z");
      expect(await sync(recovered, mixed)).toBe("current");
      expect(await db.shopifyDiscount.findUniqueOrThrow({ where: { id: six.id } })).toMatchObject({
        singleRedeemCode: extendedCode, isAvailable: true, providerStatus: "ACTIVE",
        unavailableAt: null,
      });
      const catalogue = await db.shopifyDiscountCatalogue.findUniqueOrThrow({ where: { shopId: shop } });
      expect(catalogue.status).toBe("CURRENT");
    } finally {
      await db.shop.delete({ where: { id: shop } });
      await db.$disconnect();
    }
  }, 60_000);

  it("fails ambiguous IDs atomically and recovers ERROR on a later complete scan", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const shop = await fixture(db);
    try {
      expect(await new WooCouponCatalogueService(db, async () => [coupon(1, "GOOD")], () => NOW)
        .reconcile(shop, NOW)).toBe("current");
      const existing = await db.shopifyDiscount.findMany({ where: { shopId: shop } });
      const failure = new Date("2026-10-13T13:00:00Z");
      await db.shopifyDiscountCatalogue.update({ where: { shopId: shop }, data: { syncRequestedAt: failure } });
      await expect(new WooCouponCatalogueService(db, async () => [coupon(1, "GOOD"), coupon(1, "OTHER")], () => failure)
        .reconcile(shop, failure)).rejects.toThrow("provider_identity_invalid");
      expect(await db.shopifyDiscount.findMany({ where: { shopId: shop } })).toEqual(existing);
      expect(await db.shopifyDiscountCatalogue.findUniqueOrThrow({ where: { shopId: shop } }))
        .toMatchObject({ status: "ERROR", lastErrorCode: "provider_identity_invalid" });
      const retry = new Date("2026-10-13T14:00:00Z");
      await db.shopifyDiscountCatalogue.update({ where: { shopId: shop }, data: { syncRequestedAt: retry } });
      expect(await new WooCouponCatalogueService(db, async () => [
        { ...coupon(1, "GOOD"), date_expires_gmt: "bad date" },
      ], () => retry).reconcile(shop, retry)).toBe("current");
      expect(await db.shopifyDiscountCatalogue.findUniqueOrThrow({ where: { shopId: shop } }))
        .toMatchObject({ status: "CURRENT", lastErrorCode: null });
    } finally {
      await db.shop.delete({ where: { id: shop } });
      await db.$disconnect();
    }
  }, 60_000);
});
