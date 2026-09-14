import prisma from "../lib/db.js";

export type ShopExecutionRecord = {
  id: string;
  status: "ACTIVE" | "UNINSTALLED" | "SUSPENDED";
  subscription: { status: string } | null;
  settings: { recoveryDelayMinutes: number | null } | null;
};

export class ShopExecutionEligibilityService {
  async resolveShopByDomain(domain: string): Promise<ShopExecutionRecord | null> {
    return prisma.shop.findUnique({
      where: { domain: domain.trim().toLowerCase() },
      select: {
        id: true,
        status: true,
        subscription: { select: { status: true } },
        settings: { select: { recoveryDelayMinutes: true } },
      },
    });
  }

  async resolveShopById(
    shopId: string,
  ): Promise<Pick<ShopExecutionRecord, "id" | "status" | "subscription"> | null> {
    return prisma.shop.findUnique({
      where: { id: shopId },
      select: {
        id: true,
        status: true,
        subscription: { select: { status: true } },
      },
    });
  }

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
