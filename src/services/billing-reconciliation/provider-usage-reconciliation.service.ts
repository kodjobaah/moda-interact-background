import {
  BillingPlanKind,
  Prisma,
  ShopifyReportState,
  UsageMetric,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { deriveShopifyProviderContextIdentity } from "@modainteract/moda-interact-shared/billing";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";

import type { PartnerSubscription } from "../../providers/shopify-partner-billing.provider.js";
import type { RecoveryCreditPurchaseService } from "../recovery-credit-purchase.service.js";

type ProviderUsageDatabase = Pick<PrismaClient, "subscription" | "usageEvent">;
type PurchaseReconciler = Pick<RecoveryCreditPurchaseService, "reconcileProviderConfirmed">;

export type UsageDiscrepancy = {
  shopId: string;
  billingPeriodId: string;
  meterHandle: string;
  modaQuantity: number;
  shopifyQuantity: number;
  kind?: "under" | "over" | "ambiguous" | "invalid-provider-units" | "invalid-scope";
  detail?: string;
};

export type SubscriptionUsageProjection = {
  billingPeriodId: string | null;
  packMeterHandle: string | null;
};

export type ProviderUsageReconciliationResult = {
  purchasesActivated: number;
  discrepancies: UsageDiscrepancy[];
};

export class ProviderUsageReconciliationService {
  constructor(
    private readonly database: ProviderUsageDatabase,
    private readonly purchases: PurchaseReconciler,
    private readonly logger: StructuredLogger,
  ) {}

  async reconcile(
    shopId: string,
    provider: PartnerSubscription | null,
    projection: SubscriptionUsageProjection,
  ): Promise<ProviderUsageReconciliationResult> {
    const discrepancies: UsageDiscrepancy[] = [];
    const purchaseReconciliation = await this.reconcilePackPurchases(shopId, provider, projection);
    if (purchaseReconciliation.discrepancy) {
      const discrepancy: UsageDiscrepancy = {
        shopId,
        billingPeriodId: purchaseReconciliation.discrepancy.billingPeriodId,
        meterHandle: purchaseReconciliation.discrepancy.packMeterHandle,
        modaQuantity: Number(purchaseReconciliation.discrepancy.alreadyMatchedUnits)
          + purchaseReconciliation.discrepancy.eligibleCandidateCount,
        shopifyQuantity: Number(purchaseReconciliation.discrepancy.providerUnits),
        kind: purchaseReconciliation.discrepancy.kind,
        ...(purchaseReconciliation.discrepancy.detail
          ? { detail: purchaseReconciliation.discrepancy.detail }
          : {}),
      };
      discrepancies.push(discrepancy);
      this.logger.warn("billing.recovery_credit_reconciliation.discrepancy", purchaseReconciliation.discrepancy);
    }

    const usageDiscrepancy = await this.compareUsage(shopId, provider);
    if (usageDiscrepancy) discrepancies.push(usageDiscrepancy);

    return {
      purchasesActivated: purchaseReconciliation.activatedCount,
      discrepancies,
    };
  }

  private async reconcilePackPurchases(
    shopId: string,
    provider: PartnerSubscription | null,
    projection: SubscriptionUsageProjection,
  ) {
    if (!provider) {
      return { activatedCount: 0, discrepancy: null };
    }
    if (!provider.currentPeriodStart
      || !provider.currentPeriodEnd
      || provider.currentPeriodEnd.getTime() <= provider.currentPeriodStart.getTime()) {
      return {
        activatedCount: 0,
        discrepancy: {
          kind: "invalid-scope" as const,
          shopId,
          billingPeriodId: projection.billingPeriodId ?? "",
          providerPlanHandle: provider.planHandle,
          packMeterHandle: projection.packMeterHandle ?? "",
          providerUnits: 0,
          alreadyMatchedUnits: 0,
          eligibleCandidateCount: 0,
          confirmedDelta: 0,
          detail: "Present Partner subscription has no exact current billing cycle",
        },
      };
    }
    if (!projection.billingPeriodId) {
      return {
        activatedCount: 0,
        discrepancy: {
          kind: "invalid-scope" as const,
          shopId,
          billingPeriodId: "",
          providerPlanHandle: provider.planHandle,
          packMeterHandle: projection.packMeterHandle ?? "",
          providerUnits: 0,
          alreadyMatchedUnits: 0,
          eligibleCandidateCount: 0,
          confirmedDelta: 0,
          detail: "Exact current billing period is required",
        },
      };
    }
    const providerContextIdentity = deriveShopifyProviderContextIdentity({
      providerSubscriptionId: provider.providerSubscriptionId,
      planHandle: provider.planHandle,
      currentPeriodStart: provider.currentPeriodStart,
      currentPeriodEnd: provider.currentPeriodEnd,
    });
    return this.purchases.reconcileProviderConfirmed({
      shopId,
      billingPeriodId: projection.billingPeriodId,
      providerPlanHandle: provider.planHandle,
      packMeterHandle: projection.packMeterHandle ?? "",
      providerContextIdentity,
      providerUnits: Number.NaN,
      providerCostAmount: null,
      providerCostCurrency: null,
      providerUsageSnapshot: provider.providerUsageSnapshot,
      currentPeriodStart: provider.currentPeriodStart,
      currentPeriodEnd: provider.currentPeriodEnd,
    });
  }

  private async compareUsage(
    shopId: string,
    provider: PartnerSubscription | null,
  ): Promise<UsageDiscrepancy | null> {
    if (!provider?.currentPeriodStart || !provider.currentPeriodEnd) return null;
    const subscription = await this.database.subscription.findUnique({
      where: { shopId },
      select: { billingPeriodId: true, plan: { select: { kind: true, shopifyUsageEventHandle: true } } },
    });
    const meterHandle = subscription?.plan?.kind === BillingPlanKind.PAID_METERED
      ? subscription.plan.shopifyUsageEventHandle
      : null;
    if (!subscription?.billingPeriodId || !meterHandle) return null;
    const shopifyQuantity = provider.providerUsageSnapshot.find((usage) => usage.handle === meterHandle)?.quantity;
    if (shopifyQuantity === null || shopifyQuantity === undefined) return null;
    const modaQuantity = Number((await this.database.usageEvent.aggregate({
      where: {
        shopId,
        billingPeriodId: subscription.billingPeriodId,
        metric: UsageMetric.RECOVERY_CONVERSATION,
        shopifyEventHandle: meterHandle,
        shopifyReportState: ShopifyReportState.REPORTED,
      },
      _sum: { quantity: true },
    }))._sum.quantity ?? 0);
    if (new Prisma.Decimal(modaQuantity).equals(new Prisma.Decimal(shopifyQuantity))) return null;
    const discrepancy = {
      shopId,
      billingPeriodId: subscription.billingPeriodId,
      meterHandle,
      modaQuantity,
      shopifyQuantity: Number(shopifyQuantity),
    };
    this.logger.warn("billing.usage_reconciliation.discrepancy", discrepancy);
    return discrepancy;
  }
}
