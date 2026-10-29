import "dotenv/config";

import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shopifyDiscountProvider, type ShopifyDiscountRecord } from "../../src/providers/shopify-discount.provider.js";
import { ShopifyDiscountCatalogueService } from "../../src/services/shopify-discount-catalogue.service.js";
import { ReinstallReconciliationService } from "../../src/services/billing-subscription-reconciliation/reinstall-reconciliation.service.js";
import type { ReinstallExpected } from "../../src/services/billing-subscription-reconciliation/classification.js";
import { candidateKind } from "../../src/services/recovery-offers/recovery-offer-providers.js";

const url = process.env.TEST_DATABASE_URL;
const describeWithDatabase = url && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;
const NOW = new Date("2026-10-29T12:00:00Z");

const selectedDiscount = {
  shopifyDiscountNodeId: "gid://shopify/DiscountAutomaticNode/1",
  providerType: "DiscountAutomaticBasic",
  method: "AUTOMATIC" as const,
  providerStatus: "ACTIVE",
  title: "Selected automatic discount",
  summary: null,
  startsAt: null,
  endsAt: null,
  codeCount: null,
  singleRedeemCode: null,
  fixedSelectable: true,
  providerSnapshot: { id: "gid://shopify/DiscountAutomaticNode/1", status: "ACTIVE" },
};

afterEach(() => vi.restoreAllMocks());

describeWithDatabase("ARCH-052 Shopify merchant discount selection", () => {
  it("preserves selection across sync, disappearance, unavailable scope, and no-contract reinstall", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const id = randomUUID();
    const shopId = `arch052-shop-${id}`;
    const domain = `${id}.myshopify.com`;
    const nextReconcileAt = new Date("2026-10-29T12:05:00Z");
    const reinstallPendingAt = new Date("2026-10-29T11:30:00Z");

    try {
      await db.shop.create({ data: {
        id: shopId, domain, status: "ACTIVE", onboardingCompleted: true,
      } });
      await db.shopSettings.create({ data: { shopId, onboardingCompleted: true } });
      await db.subscription.create({ data: {
        shopId, status: "ACTIVE", nextReconcileAt,
      } });
      await db.session.create({ data: {
        id: `offline_${domain}`, shop: domain, state: "integration", accessToken: "fixture",
        isOnline: false, scope: "read_discounts",
      } });
      await db.shopifyDiscountCatalogue.create({ data: {
        shopId, status: "SYNC_REQUIRED", syncRequestedAt: NOW,
      } });

      const providerRead = vi.spyOn(shopifyDiscountProvider, "listDiscounts");
      const catalogue = new ShopifyDiscountCatalogueService();
      providerRead.mockResolvedValueOnce([selectedDiscount]);
      expect(await catalogue.reconcile(shopId, NOW)).toBe("current");
      const first = await db.shopifyDiscount.findUniqueOrThrow({ where: {
        shopId_shopifyDiscountNodeId: { shopId, shopifyDiscountNodeId: selectedDiscount.shopifyDiscountNodeId },
      } });
      expect(first.isAvailable).toBe(false);

      await db.shopifyDiscount.update({ where: { id: first.id }, data: { isAvailable: true } });
      const secondDiscount = {
        ...selectedDiscount,
        shopifyDiscountNodeId: "gid://shopify/DiscountAutomaticNode/2",
        title: "New automatic discount",
        providerSnapshot: { id: "gid://shopify/DiscountAutomaticNode/2", status: "ACTIVE" },
      };
      providerRead.mockResolvedValueOnce([selectedDiscount, secondDiscount]);
      expect(await catalogue.reconcile(shopId, new Date(NOW.getTime() + 60_000))).toBe("current");
      expect(await db.shopifyDiscount.findUniqueOrThrow({ where: { id: first.id } }))
        .toMatchObject({ isAvailable: true, unavailableAt: null });
      const second = await db.shopifyDiscount.findUniqueOrThrow({ where: {
        shopId_shopifyDiscountNodeId: { shopId, shopifyDiscountNodeId: secondDiscount.shopifyDiscountNodeId },
      } });
      expect(second.isAvailable).toBe(false);

      providerRead.mockResolvedValueOnce([secondDiscount]);
      const disappearedAt = new Date(NOW.getTime() + 120_000);
      expect(await catalogue.reconcile(shopId, disappearedAt)).toBe("current");
      const disappeared = await db.shopifyDiscount.findUniqueOrThrow({ where: { id: first.id } });
      expect(disappeared).toMatchObject({ isAvailable: true, unavailableAt: disappearedAt });
      expect(candidateKind("SHOPIFY", { ...disappeared, providerStatus: "ACTIVE" }, NOW)).toBeNull();

      await db.session.update({ where: { id: `offline_${domain}` }, data: { scope: "read_products" } });
      expect(await catalogue.reconcile(shopId, new Date(NOW.getTime() + 180_000))).toBe("unavailable");
      const unavailableCatalogue = await db.shopifyDiscountCatalogue.findUniqueOrThrow({ where: { shopId } });
      expect(unavailableCatalogue.status).toBe("UNAVAILABLE");
      expect(await db.shopifyDiscount.findUniqueOrThrow({ where: { id: first.id } }))
        .toMatchObject({ isAvailable: true, unavailableAt: disappearedAt });

      const liveCandidate = { ...disappeared, unavailableAt: null, providerStatus: "ACTIVE" };
      expect(candidateKind("SHOPIFY", liveCandidate, NOW)).toBe("AUTOMATIC_OFFER");
      expect(candidateKind("SHOPIFY", { ...liveCandidate, providerStatus: "EXPIRED" }, NOW)).toBeNull();

      await db.shop.update({ where: { id: shopId }, data: {
        status: "UNINSTALLED", reinstallPendingAt,
      } });
      const expected: ReinstallExpected = {
        subscriptionId: (await db.subscription.findUniqueOrThrow({ where: { shopId } })).id,
        reinstallPendingAt,
        nextReconcileAt,
      };
      const reinstall = new ReinstallReconciliationService(
        db as never,
        { getActiveSubscription: vi.fn().mockResolvedValue(null) } as never,
        { publishNext: vi.fn().mockResolvedValue(undefined) },
        { publishDiscountSync: vi.fn().mockResolvedValue(undefined) },
        { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never,
        () => NOW,
      );
      await reinstall.reconcileReinstall(shopId, expected, `gid://shopify/Shop/${id}`);
      expect(await db.shopifyDiscount.findUniqueOrThrow({ where: { id: first.id } }))
        .toMatchObject({ isAvailable: true, unavailableAt: disappearedAt });
      expect(await db.subscription.findUniqueOrThrow({ where: { shopId } }))
        .toMatchObject({ status: "NO_CONTRACT", planId: null, providerSubscriptionId: null });
    } finally {
      await db.shop.deleteMany({ where: { id: shopId } });
      await db.$disconnect();
    }
  }, 60_000);

  it("does not let a stale concurrent provider read replace the selected catalogue generation", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const id = randomUUID();
    const shopId = `arch052-race-${id}`;
    const domain = `${id}.myshopify.com`;
    let release!: (rows: ShopifyDiscountRecord[]) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const delayed = new Promise<ShopifyDiscountRecord[]>((resolve) => { release = resolve; });

    try {
      await db.shop.create({ data: {
        id: shopId, domain, status: "ACTIVE", onboardingCompleted: true,
      } });
      await db.subscription.create({ data: { shopId, status: "ACTIVE" } });
      await db.session.create({ data: {
        id: `offline_${domain}`, shop: domain, state: "integration", accessToken: "fixture",
        isOnline: false, scope: "read_discounts",
      } });
      await db.shopifyDiscountCatalogue.create({ data: {
        shopId, status: "SYNC_REQUIRED", syncRequestedAt: NOW,
      } });

      const providerRead = vi.spyOn(shopifyDiscountProvider, "listDiscounts");
      providerRead.mockResolvedValueOnce([selectedDiscount]);
      const catalogue = new ShopifyDiscountCatalogueService();
      expect(await catalogue.reconcile(shopId, NOW)).toBe("current");
      const selected = await db.shopifyDiscount.findUniqueOrThrow({ where: {
        shopId_shopifyDiscountNodeId: { shopId, shopifyDiscountNodeId: selectedDiscount.shopifyDiscountNodeId },
      } });
      await db.shopifyDiscount.update({ where: { id: selected.id }, data: { isAvailable: true } });

      providerRead.mockImplementationOnce(async () => {
        entered();
        return delayed;
      });
      const oldRun = catalogue.reconcile(shopId, new Date(NOW.getTime() + 60_000));
      await started;
      providerRead.mockResolvedValueOnce([selectedDiscount]);
      expect(await catalogue.reconcile(shopId, new Date(NOW.getTime() + 120_000))).toBe("current");
      release([{
        ...selectedDiscount,
        shopifyDiscountNodeId: "gid://shopify/DiscountAutomaticNode/stale",
        title: "Stale provider response",
      }]);
      expect(await oldRun).toBe("superseded");
      expect(await db.shopifyDiscount.findUniqueOrThrow({ where: { id: selected.id } }))
        .toMatchObject({ isAvailable: true, unavailableAt: null });
      expect(await db.shopifyDiscount.count({ where: { shopId } })).toBe(1);
    } finally {
      release?.([]);
      await db.shop.deleteMany({ where: { id: shopId } });
      await db.$disconnect();
    }
  }, 60_000);
});
