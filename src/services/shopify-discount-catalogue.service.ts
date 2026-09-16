import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../lib/db.js";
import { shopifyDiscountProvider, type ShopifyDiscountRecord } from "../providers/shopify-discount.provider.js";

const ACTIVE = ["ACTIVE", "TRIALING"] as const;

export class ShopifyDiscountCatalogueService {
  async requestSync(shopId: string, requestedAt: Date): Promise<"requested" | "unavailable"> {
    return prisma.$transaction(async (transaction) => {
      const shop = await transaction.shop.findUnique({ where: { id: shopId }, select: { id: true } });
      if (!shop) return "unavailable";
      const catalogue = await this.lockCatalogue(transaction, shopId);
      const syncRequestedAt = maxDate(catalogue?.syncRequestedAt ?? null, requestedAt);
      const eligibility = await this.getEligibility(transaction, shopId);
      if (!eligibility) {
        await this.markCatalogueUnavailable(transaction, shopId, catalogue?.unavailableAt, syncRequestedAt);
        return "unavailable";
      }
      await transaction.shopifyDiscountCatalogue.update({ where: { shopId }, data: { status: "SYNC_REQUIRED", syncRequestedAt, activeSyncToken: null, syncStartedAt: null } });
      return "requested";
    });
  }

  async markUnavailable(shopId: string): Promise<void> {
    await prisma.$transaction(async (transaction) => {
      const shop = await transaction.shop.findUnique({ where: { id: shopId }, select: { id: true } });
      if (!shop) return;
      const catalogue = await this.lockCatalogue(transaction, shopId);
      await this.markCatalogueUnavailable(transaction, shopId, catalogue?.unavailableAt);
    });
  }

  async reconcile(shopId: string, requestedAt: Date): Promise<"current" | "unavailable" | "superseded" | "error"> {
    const claimed = await prisma.$transaction(async (transaction) => {
      const shop = await transaction.shop.findUnique({ where: { id: shopId }, select: { id: true, domain: true } });
      if (!shop) return null;
      const catalogue = await this.lockCatalogue(transaction, shopId);
      if (!catalogue || !(await this.getEligibility(transaction, shopId))) {
        await this.markCatalogueUnavailable(transaction, shopId, catalogue?.unavailableAt, maxDate(catalogue?.syncRequestedAt ?? null, requestedAt));
        return null;
      }
      const activeSyncToken = randomUUID();
      const generation = catalogue.syncGeneration + 1;
      const now = new Date();
      await transaction.shopifyDiscountCatalogue.update({ where: { shopId }, data: { syncGeneration: generation, activeSyncToken, status: "SYNCING", syncStartedAt: now, syncRequestedAt: maxDate(catalogue.syncRequestedAt, requestedAt), lastErrorAt: null, lastErrorCode: null } });
      return { domain: shop.domain, generation, activeSyncToken };
    });
    if (!claimed) return "unavailable";

    let observed: ShopifyDiscountRecord[];
    try {
      observed = await shopifyDiscountProvider.listDiscounts(claimed.domain);
    } catch (error) {
      await prisma.$transaction(async (transaction) => {
        const catalogue = await this.lockCatalogue(transaction, shopId);
        if (catalogue?.activeSyncToken !== claimed.activeSyncToken) return;
        await transaction.shopifyDiscountCatalogue.update({ where: { shopId }, data: { status: "ERROR", activeSyncToken: null, syncStartedAt: null, lastErrorAt: new Date(), lastErrorCode: error instanceof Error ? error.message.slice(0, 128) : "provider-error" } });
      });
      throw error;
    }

    return prisma.$transaction(async (transaction) => {
      const catalogue = await this.lockCatalogue(transaction, shopId);
      if (!catalogue || catalogue.activeSyncToken !== claimed.activeSyncToken) return "superseded";
      if (!(await this.getEligibility(transaction, shopId))) {
        await this.markCatalogueUnavailable(transaction, shopId, catalogue.unavailableAt);
        return "unavailable";
      }
      const now = new Date();
      for (const discount of observed) {
        const providerSnapshot = discount.providerSnapshot as unknown as Prisma.InputJsonValue;
        await transaction.shopifyDiscount.upsert({ where: { shopId_shopifyDiscountNodeId: { shopId, shopifyDiscountNodeId: discount.shopifyDiscountNodeId } }, create: { shopId, ...discount, providerSnapshot, lastSeenSyncGeneration: claimed.generation, lastSyncedAt: now, isAvailable: true, unavailableAt: null }, update: { ...discount, providerSnapshot, lastSeenSyncGeneration: claimed.generation, lastSyncedAt: now, isAvailable: true, unavailableAt: null } });
      }
      await transaction.shopifyDiscount.updateMany({ where: { shopId, lastSeenSyncGeneration: { not: claimed.generation } }, data: { isAvailable: false } });
      await transaction.shopifyDiscount.updateMany({ where: { shopId, lastSeenSyncGeneration: { not: claimed.generation }, unavailableAt: null }, data: { unavailableAt: now } });
      await transaction.shopifyDiscountCatalogue.update({ where: { shopId }, data: { status: "CURRENT", activeSyncToken: null, syncStartedAt: null, lastSuccessfulSyncAt: now, unavailableAt: null } });
      return "current";
    });
  }

  private async lockCatalogue(transaction: Prisma.TransactionClient, shopId: string) {
    await transaction.shopifyDiscountCatalogue.upsert({ where: { shopId }, create: { shopId }, update: {} });
    await transaction.$queryRaw(Prisma.sql`
      SELECT "id"
      FROM "shopify"."ShopifyDiscountCatalogue"
      WHERE "shopId" = ${shopId}
      FOR UPDATE
    `);
    return transaction.shopifyDiscountCatalogue.findUnique({ where: { shopId } });
  }

  private async getEligibility(transaction: Prisma.TransactionClient, shopId: string): Promise<boolean> {
    const shop = await transaction.shop.findUnique({ where: { id: shopId }, select: { domain: true, status: true, settings: { select: { onboardingCompleted: true } }, subscription: { select: { status: true } } } });
    if (!shop) return false;
    const session = await transaction.session.findFirst({ where: { shop: shop.domain, isOnline: false }, select: { scope: true }, orderBy: { expires: "desc" } });
    return shop.status === "ACTIVE"
      && shop.settings?.onboardingCompleted === true
      && ACTIVE.includes(shop.subscription?.status as typeof ACTIVE[number])
      && session?.scope?.split(",").some((scope) => scope.trim() === "read_discounts") === true;
  }

  private async markCatalogueUnavailable(transaction: Prisma.TransactionClient, shopId: string, unavailableAt: Date | null | undefined, syncRequestedAt?: Date): Promise<void> {
    const now = new Date();
    await transaction.shopifyDiscountCatalogue.upsert({ where: { shopId }, create: { shopId, status: "UNAVAILABLE", unavailableAt: now, ...(syncRequestedAt ? { syncRequestedAt } : {}) }, update: { status: "UNAVAILABLE", activeSyncToken: null, syncStartedAt: null, unavailableAt: unavailableAt ?? now, ...(syncRequestedAt ? { syncRequestedAt } : {}) } });
    await transaction.shopifyDiscount.updateMany({ where: { shopId }, data: { isAvailable: false } });
    await transaction.shopifyDiscount.updateMany({ where: { shopId, unavailableAt: null }, data: { unavailableAt: now } });
  }
}

function maxDate(left: Date | null, right: Date): Date {
  return left && left.getTime() > right.getTime() ? left : right;
}

export const shopifyDiscountCatalogueService = new ShopifyDiscountCatalogueService();