import prisma from "../lib/db.js";

export class ShopExecutionEligibilityService {
  async isShopExecutionActive(shopId: string): Promise<boolean> {
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { status: true },
    });
    return shop?.status === "ACTIVE";
  }
}

export const shopExecutionEligibilityService =
  new ShopExecutionEligibilityService();
