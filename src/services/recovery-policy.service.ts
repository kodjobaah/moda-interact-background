import { RecoveryOfferMode } from "@prisma/client";
import { parseEffectiveRecoveryPolicy } from "@modainteract/moda-interact-shared/recovery-policy";
import prisma from "../lib/db.js";

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
    const fixedUsable = configuredOfferMode === "FIXED" && discount !== null &&
      discount.fixedSelectable && discount.isAvailable &&
        discount.providerStatus === "ACTIVE" &&
      discount.catalogue.status === "CURRENT" &&
      (discount.startsAt === null || discount.startsAt <= now) &&
      (discount.endsAt === null || discount.endsAt > now);
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