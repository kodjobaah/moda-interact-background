import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../lib/db.js";
import { shopifyDiscountProvider, type ShopifyDiscountRecord } from "../providers/shopify-discount.provider.js";

const ACTIVE = ["ACTIVE", "TRIALING"] as const;

export class ShopifyDiscountCatalogueService {
  async reconcile(shopId: string): Promise<"current" | "unavailable" | "superseded" | "error"> {
    const claimed = await prisma.$transaction(async (transaction) => {
      const shop = await transaction.shop.findUnique({ where: { id: shopId }, select: { id: true, domain: true, status: true, settings: { select: { onboardingCompleted: true } }, subscription: { select: { status: true } } } });
      if (!shop) return null;
      const session = await transaction.session.findFirst({ where: { shop: shop.domain, isOnline: false }, select: { scope: true }, orderBy: { expires: "desc" } });
      const eligible = shop.status === "ACTIVE" && shop.settings?.onboardingCompleted === true && ACTIVE.includes(shop.subscription?.status as typeof ACTIVE[number]) && session?.scope?.split(",").some((scope) => scope.trim() === "read_discounts");
      const catalogue = await transaction.shopifyDiscountCatalogue.upsert({ where: { shopId }, create: { shopId }, update: {} });
      if (!eligible) {
        await transaction.shopifyDiscountCatalogue.update({ where: { shopId }, data: { status: "UNAVAILABLE", activeSyncToken: null, syncStartedAt: null, unavailableAt: new Date() } });
        await transaction.shopifyDiscount.updateMany({ where: { shopId }, data: { isAvailable: false } });
        return null;
      }
      const activeSyncToken = randomUUID();
      const generation = catalogue.syncGeneration + 1;
      await transaction.shopifyDiscountCatalogue.update({ where: { shopId }, data: { syncGeneration: generation, activeSyncToken, status: "SYNCING", syncStartedAt: new Date(), syncRequestedAt: new Date(), lastErrorAt: null, lastErrorCode: null } });
      return { domain: shop.domain, generation, activeSyncToken };
    });
    if (!claimed) return "unavailable";

    let observed: ShopifyDiscountRecord[];
    try {
      observed = await shopifyDiscountProvider.listDiscounts(claimed.domain);
    } catch (error) {
      await prisma.shopifyDiscountCatalogue.updateMany({ where: { shopId, activeSyncToken: claimed.activeSyncToken }, data: { status: "ERROR", activeSyncToken: null, lastErrorAt: new Date(), lastErrorCode: error instanceof Error ? error.message.slice(0, 128) : "provider-error" } });
      throw error;
    }

    return prisma.$transaction(async (transaction) => {
      const catalogue = await transaction.shopifyDiscountCatalogue.findUnique({ where: { shopId } });
      if (!catalogue || catalogue.activeSyncToken !== claimed.activeSyncToken) return "superseded";
      for (const discount of observed) {
        const providerSnapshot = discount.providerSnapshot as unknown as Prisma.InputJsonValue;
        await transaction.shopifyDiscount.upsert({ where: { shopId_shopifyDiscountNodeId: { shopId, shopifyDiscountNodeId: discount.shopifyDiscountNodeId } }, create: { shopId, ...discount, providerSnapshot, lastSeenSyncGeneration: claimed.generation, lastSyncedAt: new Date(), isAvailable: true, unavailableAt: null }, update: { ...discount, providerSnapshot, lastSeenSyncGeneration: claimed.generation, lastSyncedAt: new Date(), isAvailable: true, unavailableAt: null } });
      }
      await transaction.shopifyDiscount.updateMany({ where: { shopId, lastSeenSyncGeneration: { not: claimed.generation } }, data: { isAvailable: false, unavailableAt: new Date() } });
      await transaction.shopifyDiscountCatalogue.update({ where: { shopId }, data: { status: "CURRENT", activeSyncToken: null, syncStartedAt: null, lastSuccessfulSyncAt: new Date(), unavailableAt: null } });
      return "current";
    });
  }
}

export const shopifyDiscountCatalogueService = new ShopifyDiscountCatalogueService();