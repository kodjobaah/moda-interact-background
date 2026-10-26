import type { PrismaClient } from "@prisma/client";
import prisma from "../../lib/db.js";
import type {
  CatalogueOfferContext, CheckoutOfferContext, DiscountOfferCandidate,
  RecoveryOfferRepository, ShopOfferContext,
} from "./recovery-offer.types.js";

/** All database reads are restricted to the supplied shop identity. There are
 * deliberately no write ports in the offer decision module. */
export class PrismaRecoveryOfferRepository implements RecoveryOfferRepository {
  constructor(private readonly database: Pick<PrismaClient,
    "shop" | "checkoutRecovery" | "shopifyDiscountCatalogue" | "shopifyDiscount"> = prisma) {}

  async readShop(shopId: string): Promise<ShopOfferContext | null> {
    return this.database.shop.findUnique({
      where: { id: shopId }, select: { id: true, status: true, platform: true },
    });
  }

  async readCheckout(shopId: string, checkoutRecoveryId: string): Promise<CheckoutOfferContext | null> {
    const row = await this.database.checkoutRecovery.findFirst({
      where: { id: checkoutRecoveryId, shopId },
      select: {
        id: true, shopId: true, checkoutToken: true, status: true, currency: true,
        totalPrice: true, lineItems: true, lastExternalActivityAt: true, updatedAt: true,
      },
    });
    if (!row) return null;
    return {
      ...row,
      totalPrice: row.totalPrice?.toString() ?? null,
    };
  }

  async readCatalogue(shopId: string): Promise<CatalogueOfferContext | null> {
    return this.database.shopifyDiscountCatalogue.findUnique({
      where: { shopId },
      select: { shopId: true, status: true, lastSuccessfulSyncAt: true, unavailableAt: true },
    });
  }

  async readDiscounts(shopId: string, ids: readonly string[] | null, limit: number): Promise<readonly DiscountOfferCandidate[]> {
    return this.database.shopifyDiscount.findMany({
      where: {
        shopId,
        isAvailable: true,
        unavailableAt: null,
        ...(ids === null ? {} : { id: { in: [...ids] } }),
      },
      select: {
        id: true, shopId: true, shopifyDiscountNodeId: true, providerType: true,
        method: true, providerStatus: true, title: true, summary: true,
        startsAt: true, endsAt: true, codeCount: true, singleRedeemCode: true,
        fixedSelectable: true, isAvailable: true, unavailableAt: true, providerSnapshot: true,
      },
      orderBy: { id: "asc" },
      take: limit,
    });
  }
}
