import prisma from "../lib/db.js";
import { SubscriptionProjectionStatus } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { isVerifiedEndedSubscription } from "./post-contract-recovery-policy.service.js";

type ShopExecutionClient = Partial<Pick<PrismaClient, "shop">> &
  Partial<Pick<PrismaClient, "subscription">>;

export type ShopExecutionRecord = {
  id: string;
  status: "ACTIVE" | "UNINSTALLED" | "SUSPENDED";
  onboardingCompleted?: boolean;
  subscription: {
    status: string;
    lastProviderLifecycleState?: string | null;
  } | null;
  settings: { recoveryDelayMinutes: number | null } | null;
};

export type ShopExecutionScope = "general" | "recovery";

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
        onboardingCompleted: true,
        subscription: {
          select: {
            status: true,
            lastProviderLifecycleState: true,
          },
        },
        settings: { select: { recoveryDelayMinutes: true } },
      },
    });
  }

  async resolveShopById(
    shopId: string,
  ): Promise<Pick<ShopExecutionRecord, "id" | "status" | "onboardingCompleted" | "subscription"> | null> {
    if (!this.client.shop) return null;
    return this.client.shop.findUnique({
      where: { id: shopId },
      select: {
        id: true,
        status: true,
        onboardingCompleted: true,
        subscription: {
          select: {
            status: true,
            lastProviderLifecycleState: true,
          },
        },
      },
    });
  }

  async isShopExecutionActive(
    shopId: string,
    scope: ShopExecutionScope = "general",
  ): Promise<boolean> {
    const decision = await this.evaluate(shopId, undefined, scope);
    return decision.allowed;
  }

  async evaluate(
    shopId: string,
    knownShopStatus?: string,
    scope: ShopExecutionScope = "general",
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
        lastProviderLifecycleState: true,
        shop: {
          select: {
            status: true,
            onboardingCompleted: true,
          },
        },
      },
    });
    if (!subscription || subscription.shop.status !== "ACTIVE") {
      return { allowed: false, shopId, reason: "SHOP_UNAVAILABLE" };
    }
    return this.evaluateResolvedShop(
      {
        id: shopId,
        status: subscription.shop.status,
        onboardingCompleted: subscription.shop.onboardingCompleted,
        subscription: {
          status: subscription.status,
          lastProviderLifecycleState: subscription.lastProviderLifecycleState,
        },
      },
      scope,
    );
  }

  evaluateResolvedShop(
    shop: Pick<
      ShopExecutionRecord,
      "id" | "status" | "onboardingCompleted" | "subscription"
    >,
    scope: ShopExecutionScope = "general",
  ): ShopExecutionDecision {
    if (shop.status !== "ACTIVE" || !shop.subscription) {
      return { allowed: false, shopId: shop.id, reason: "SHOP_UNAVAILABLE" };
    }
    if (shop.subscription.status === SubscriptionProjectionStatus.NO_CONTRACT) {
      if (
        scope === "recovery" &&
        isVerifiedEndedSubscription({
          status: shop.subscription.status,
          lastProviderLifecycleState:
            shop.subscription.lastProviderLifecycleState,
          onboardingCompleted: shop.onboardingCompleted,
        })
      ) {
        return { allowed: true, shopId: shop.id };
      }
      return { allowed: false, shopId: shop.id, reason: "CONTRACT_REQUIRED" };
    }
    if (shop.subscription.status === SubscriptionProjectionStatus.FROZEN) {
      return { allowed: false, shopId: shop.id, reason: "SUBSCRIPTION_FROZEN" };
    }
    if (shop.subscription.status === SubscriptionProjectionStatus.SYNC_ERROR) {
      return { allowed: false, shopId: shop.id, reason: "SYNC_ERROR" };
    }
    if (shop.subscription.status === SubscriptionProjectionStatus.UNMAPPED) {
      return { allowed: false, shopId: shop.id, reason: "UNMAPPED_PLAN" };
    }
    return { allowed: true, shopId: shop.id };
  }
}

export const shopExecutionEligibilityService =
  new ShopExecutionEligibilityService();
