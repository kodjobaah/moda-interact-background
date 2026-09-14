import prisma from "../lib/db.js";
import { SubscriptionProjectionStatus } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

type ShopExecutionClient = Partial<Pick<PrismaClient, "shop">> &
  Partial<Pick<PrismaClient, "subscription">>;

export type ShopExecutionRecord = {
  id: string;
  status: "ACTIVE" | "UNINSTALLED" | "SUSPENDED";
  subscription: { status: string } | null;
  settings: { recoveryDelayMinutes: number | null } | null;
};

export type ShopExecutionDenialReason =
  | "CONTRACT_REQUIRED"
  | "SUBSCRIPTION_FROZEN"
  | "UNMAPPED_PLAN"
  | "SYNC_ERROR"
  | "SHOP_UNAVAILABLE";

export type ShopExecutionDecision =
  | { allowed: true; shopId: string }
  | { allowed: false; shopId: string; reason: ShopExecutionDenialReason };

export class ShopExecutionEligibilityService {
  constructor(private readonly client: ShopExecutionClient = prisma) {}

  async resolveShopByDomain(domain: string): Promise<ShopExecutionRecord | null> {
    const shop = this.client.shop;
    if (!shop) return null;
    return shop.findUnique({
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
    const decision = await this.evaluate(shopId);
    return decision.allowed;
  }

  async evaluate(
    shopId: string,
    knownShopStatus?: string,
  ): Promise<ShopExecutionDecision> {
    if (!this.client.subscription) {
      if (knownShopStatus !== undefined) {
        return knownShopStatus === "ACTIVE"
          ? { allowed: true, shopId }
          : { allowed: false, shopId, reason: "SHOP_UNAVAILABLE" };
      }
      if (!this.client.shop) return { allowed: true, shopId };
      const shop = await this.client.shop.findUnique({
        where: { id: shopId },
        select: { status: true },
      });
      return shop?.status === "ACTIVE"
        ? { allowed: true, shopId }
        : { allowed: false, shopId, reason: "SHOP_UNAVAILABLE" };
    }
    const subscription = await this.client.subscription.findUnique({
      where: { shopId },
      select: {
        status: true,
        shop: { select: { status: true } },
      },
    });
    if (!subscription || subscription.shop.status !== "ACTIVE") {
      return { allowed: false, shopId, reason: "SHOP_UNAVAILABLE" };
    }
    const status = subscription.status;
    if (status === SubscriptionProjectionStatus.NO_CONTRACT) {
      return { allowed: false, shopId, reason: "CONTRACT_REQUIRED" };
    }
    if (status === SubscriptionProjectionStatus.FROZEN) {
      return { allowed: false, shopId, reason: "SUBSCRIPTION_FROZEN" };
    }
    if (status === SubscriptionProjectionStatus.SYNC_ERROR) {
      return { allowed: false, shopId, reason: "SYNC_ERROR" };
    }
    if (status === SubscriptionProjectionStatus.UNMAPPED) {
      return { allowed: false, shopId, reason: "UNMAPPED_PLAN" };
    }
    return { allowed: true, shopId };
  }
}

export const shopExecutionEligibilityService =
  new ShopExecutionEligibilityService();
