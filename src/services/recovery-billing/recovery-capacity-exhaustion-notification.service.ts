import {
  ARCH007_BILLING_CONTRACT_SCHEMA_VERSION,
  BILLING_SYSTEM_MESSAGE_CODES,
  createMerchantBillingSystemSourceKey,
} from "@modainteract/moda-interact-shared/billing";
import {
  MerchantSupportMessageKind,
  MerchantSupportMessageState,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import prisma from "../../lib/db.js";
import type { EffectiveBillingPolicy } from "../effective-billing-policy.service.js";

export type RecoveryCapacityExhaustionNotificationDatabase = Pick<
  PrismaClient,
  "$transaction" | "merchantSupportThread" | "merchantSupportMessage"
> &
  Partial<
    Pick<
      PrismaClient,
      "shopEntitlementCounter" | "billingPeriodEntitlementCounter"
    >
  > &
  Partial<Pick<PrismaClient, "merchantPromotionSelection">>;

export class RecoveryCapacityExhaustionNotificationService {
  constructor(
    private readonly database: RecoveryCapacityExhaustionNotificationDatabase = prisma,
  ) {}

  async notify(shopId: string, policy: EffectiveBillingPolicy): Promise<void> {
    const systemCode = BILLING_SYSTEM_MESSAGE_CODES.RECOVERY_CAPACITY_EXHAUSTED;
    const purchasedCounter = this.database.shopEntitlementCounter
      ? await this.database.shopEntitlementCounter.findUnique({
          where: {
            shopId_counter: { shopId, counter: "PURCHASED_RECOVERY_CREDITS" },
          },
          select: {
            grantedQuantity: true,
            committedQuantity: true,
            reservedQuantity: true,
            refundingQuantity: true,
          },
        })
      : null;
    const includedCounter =
      policy.billingPeriod && this.database.billingPeriodEntitlementCounter
        ? await this.database.billingPeriodEntitlementCounter.findUnique({
            where: {
              billingPeriodId_counter: {
                billingPeriodId: policy.billingPeriod.id,
                counter: "INCLUDED_RECOVERY_CREDITS",
              },
            },
            select: {
              grantedQuantity: true,
              currentAllowanceQuantity: true,
              committedQuantity: true,
              reservedQuantity: true,
              forfeitedQuantity: true,
            },
          })
        : null;
    const selectedPromotion = this.database.merchantPromotionSelection
      ? await this.database.merchantPromotionSelection.findUnique({
          where: { shopId },
          select: {
            promotionalCreditGrant: {
              select: {
                id: true,
                version: true,
                quantity: true,
                committedQuantity: true,
                reservedQuantity: true,
              },
            },
          },
        })
      : null;
    const selectedGrant = selectedPromotion?.promotionalCreditGrant;
    const exhaustionLifecycle = [
      policy.planKind,
      policy.subscriptionId,
      policy.billingPeriod?.id ?? "no-period",
      policy.freeAllowance
        ? `${policy.freeAllowance.grant}:${policy.freeAllowance.committed}:${policy.freeAllowance.reserved}`
        : "no-free-allowance",
      includedCounter
        ? `${includedCounter.currentAllowanceQuantity ?? includedCounter.grantedQuantity}:${includedCounter.committedQuantity}:${includedCounter.reservedQuantity}:${includedCounter.forfeitedQuantity}`
        : "no-included-counter",
      purchasedCounter
        ? `${purchasedCounter.grantedQuantity}:${purchasedCounter.committedQuantity}:${purchasedCounter.reservedQuantity}:${purchasedCounter.refundingQuantity}`
        : "no-purchased-counter",
      selectedGrant
        ? `${selectedGrant.id}:${selectedGrant.version}:${selectedGrant.quantity}:${selectedGrant.committedQuantity}:${selectedGrant.reservedQuantity}`
        : "no-selected-promotion",
      policy.recoveryCreditPack?.shopifyEventHandle ?? "no-pack",
    ].join("|");
    const sourceKey = createMerchantBillingSystemSourceKey(
      shopId,
      systemCode,
      exhaustionLifecycle,
      ARCH007_BILLING_CONTRACT_SCHEMA_VERSION,
    );
    const now = new Date();

    await this.database.$transaction(async (transaction) => {
      const thread = await transaction.merchantSupportThread.upsert({
        where: { shopId },
        create: { shopId },
        update: {},
      });

      await transaction.merchantSupportMessage.upsert({
        where: { sourceKey },
        create: {
          threadId: thread.id,
          kind: MerchantSupportMessageKind.SYSTEM,
          state: MerchantSupportMessageState.AVAILABLE,
          originalBody:
            policy.planKind === "FREE"
              ? "Every applicable Free-plan recovery-capacity source is exhausted: promotional credits, purchased credits and shop-lifetime Free. New abandoned-checkout recoveries are paused. Existing conversations continue. You can manage recovery capacity or change plan."
              : "Every applicable recovery-capacity source is exhausted: Paid monthly included where applicable, promotional credits, purchased credits and shop-lifetime Free. New abandoned-checkout recoveries are paused. Existing conversations continue. Capacity returns when any canonical source becomes available again.",
          sourceLanguageTag: "en-GB",
          systemCode,
          systemVersion: String(ARCH007_BILLING_CONTRACT_SCHEMA_VERSION),
          sourceKey,
          availableAt: now,
        },
        update: {},
      });

      await transaction.merchantSupportThread.update({
        where: { id: thread.id },
        data: { lastMessageAt: now },
      });
    });
  }
}
