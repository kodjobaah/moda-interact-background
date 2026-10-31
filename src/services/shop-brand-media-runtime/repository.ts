import type { PrismaClient } from "@prisma/client";
import prisma from "../../lib/db.js";
import type { ShopBrandMediaReader } from "./contracts.js";

/** Never enumerate brands or accept an object ID/asset URL from a request. */
export class PrismaShopBrandMediaReader implements ShopBrandMediaReader {
  constructor(private readonly database: Pick<PrismaClient, "shopBrand"> = prisma) {}

  async readForShop(shopId: string) {
    const brand = await this.database.shopBrand.findUnique({
      where: { shopId },
      select: { shopId: true, whatsAppMedia: true, shop: { select: { domain: true } } },
    });
    return brand ? { shopId: brand.shopId, domain: brand.shop.domain, whatsAppMedia: brand.whatsAppMedia } : null;
  }
}
