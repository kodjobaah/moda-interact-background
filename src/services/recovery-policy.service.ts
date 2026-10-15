import { RecoveryOfferMode } from "@prisma/client";
import { parseEffectiveRecoveryPolicy } from "@modainteract/moda-interact-shared/recovery-policy";
import prisma from "../lib/db.js";
import { deliverableWooCode } from "../providers/woo-coupon-normalization.js";

export type RecoveryPolicySnapshot = ReturnType<typeof parseEffectiveRecoveryPolicy> & {
  offerSnapshot: Record<string, unknown> | null;
};

export class RecoveryPolicyService {
  constructor(private readonly database = prisma) {}

  async resolve(shopId: string, now = new Date()): Promise<RecoveryPolicySnapshot> {
    if (!this.database.shopSettings || !this.database.shopRecoveryPolicyOverride) {
      return {
        recoveryDelayMinutes: 30,
        recoveryOfferMode: "NONE",
        fixedShopifyDiscountId: null,
        followUpEnabled: false,
        followUpDelayMinutes: null,
        source: "MERCHANT",
        offerSnapshot: null,
      };
    }
    const [settings, override] = await Promise.all([
      this.database.shopSettings.findUnique({
        where: { shopId },
        include: { fixedShopifyDiscount: { include: { catalogue: true } } },
      }),
      this.database.shopRecoveryPolicyOverride.findUnique({
        where: { shopId },
        include: { fixedShopifyDiscount: { include: { catalogue: true } } },
      }),
    ]);
      const source = override && (!override.expiresAt || override.expiresAt > now)
      ? override
      : settings;
    if (!source) {
      return {
        recoveryDelayMinutes: 30,
        recoveryOfferMode: "NONE",
        fixedShopifyDiscountId: null,
        followUpEnabled: false,
        followUpDelayMinutes: null,
        source: "MERCHANT",
        offerSnapshot: null,
      };
    }

    const configuredOfferMode = source.recoveryOfferMode as RecoveryOfferMode;
    const discount = source.fixedShopifyDiscount;
    // Resolve the trusted Shop platform, never infer it from coupon metadata.
    // Shopify's established eligibility checks must remain unchanged.
    const shop = configuredOfferMode === "FIXED" && discount !== null
      ? await this.database.shop.findUnique({ where: { id: shopId }, select: { platform: true } })
      : null;
    const wooSelectedCode = shop?.platform === "WOOCOMMERCE" && discount !== null &&
      discount.shopId === shopId &&
      discount.shopifyDiscountNodeId.startsWith("woo:coupon:") &&
      discount.method === "CODE" && discount.isAvailable &&
      discount.providerStatus !== "REMOVED" && discount.unavailableAt === null &&
      discount.catalogue.lastSuccessfulSyncAt !== null &&
      deliverableWooCode(discount.singleRedeemCode);
    const shopifyFixedUsable = shop?.platform === "SHOPIFY" && discount !== null &&
      discount.fixedSelectable && discount.isAvailable &&
      discount.providerStatus === "ACTIVE" &&
      discount.catalogue.status === "CURRENT" &&
      (discount.startsAt === null || discount.startsAt <= now) &&
      (discount.endsAt === null || discount.endsAt > now);
    const fixedUsable = configuredOfferMode === "FIXED" &&
      (wooSelectedCode || shopifyFixedUsable);
    const policy = parseEffectiveRecoveryPolicy({
      recoveryDelayMinutes: source.recoveryDelayMinutes,
      recoveryOfferMode: configuredOfferMode,
      fixedShopifyDiscountId: configuredOfferMode === "FIXED" && discount ? discount.id : null,
      followUpEnabled: source.followUpEnabled,
      followUpDelayMinutes: source.followUpEnabled ? source.followUpDelayMinutes : null,
      source: source === override ? "ADMIN_OVERRIDE" : "MERCHANT",
    });

    return {
      ...policy,
      offerSnapshot: fixedUsable && discount
        ? {
            id: discount.id,
            shopifyDiscountNodeId: discount.shopifyDiscountNodeId,
            method: discount.method,
            title: discount.title,
            summary: discount.summary,
            startsAt: discount.startsAt?.toISOString() ?? null,
            endsAt: discount.endsAt?.toISOString() ?? null,
            singleRedeemCode: discount.singleRedeemCode,
            providerSnapshot: discount.providerSnapshot,
          }
        : null,
    };
  }
}

export const recoveryPolicyService = new RecoveryPolicyService();