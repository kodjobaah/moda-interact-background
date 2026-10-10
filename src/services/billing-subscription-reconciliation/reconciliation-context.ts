import { ShopPlatform, type Prisma, type PrismaClient } from "@prisma/client";

const shopReconciliationSelect = {
  id: true,
  status: true,
  reinstallPendingAt: true,
  shopifyShopId: true,
  onboardingCompleted: true,
  subscription: {
    select: {
      id: true,
      status: true,
      planId: true,
      pendingPlanId: true,
      pendingShopifyPlanHandle: true,
      pendingEffectiveAt: true,
      nextReconcileAt: true,
      billingPeriodId: true,
      currentPeriodStart: true,
      currentPeriodEnd: true,
      cancelAtPeriodEnd: true,
      lastSyncErrorCode: true,
    },
  },
} satisfies Prisma.ShopSelect;

const currentPlanSelect = {
  id: true,
  active: true,
  name: true,
  kind: true,
  shopifyPlanHandle: true,
  recoveryCreditPackEnabled: true,
  shopifyUsageEventHandle: true,
  shopifyRecoveryCreditPackEventHandle: true,
  includedRecoveryConversationAllowance: true,
} satisfies Prisma.BillingPlanSelect;

type ReconciliationContextDatabase = Pick<PrismaClient, "shop" | "billingPlan">;

export class ReconciliationContextService {
  constructor(private readonly database: ReconciliationContextDatabase) {}

  async loadShop(shopId: string) {
    return this.database.shop.findUnique({
      where: { id: shopId, platform: ShopPlatform.SHOPIFY },
      select: shopReconciliationSelect,
    });
  }

  async loadCurrentPlan(planId: string) {
    return this.database.billingPlan.findUnique({
      where: { id: planId },
      select: currentPlanSelect,
    });
  }
}