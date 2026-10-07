import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { deriveShopifyProviderContextIdentity } from "@modainteract/moda-interact-shared/billing";

import {
  getSubscriptionReconciliationSnapshot,
  type PartnerUsagePricingSnapshot,
  type ShopifyPartnerBillingProvider,
} from "../../providers/shopify-partner-billing.provider.js";

export type RefundProviderStateInput = {
  billingPeriodIdSnapshot: string;
  providerSubscriptionIdSnapshot: string;
  planHandleSnapshot: string;
  eventHandleSnapshot: string;
  shop: { shopifyShopId: string | null };
};

type UnsafeProviderStateProof = {
  safe: false;
  reason: string;
};

export type RefundProviderStateProof =
  | {
      safe: true;
      quantity: Prisma.Decimal;
      cost: Prisma.Decimal;
      currency: string;
      pricing?: PartnerUsagePricingSnapshot;
    }
  | UnsafeProviderStateProof;

export type RefundProviderPreparationStateProof =
  | {
      safe: true;
      quantity: Prisma.Decimal;
      cost: Prisma.Decimal;
      currency: string;
      pricing: PartnerUsagePricingSnapshot;
    }
  | UnsafeProviderStateProof;

export class RefundProviderStateService {
  constructor(
    private readonly database: PrismaClient,
    private readonly partner: ShopifyPartnerBillingProvider,
  ) {}

  async read(refund: RefundProviderStateInput): Promise<RefundProviderStateProof> {
    const shopifyShopId = refund.shop.shopifyShopId;
    if (!shopifyShopId) return unsafe("shop has no Shopify identifier");

    const snapshot = await getSubscriptionReconciliationSnapshot(
      this.partner,
      shopifyShopId,
    );
    const provider = snapshot.activeSubscription;
    if (!provider) return unsafe("Shopify subscription is unavailable");

    const period = await this.database.billingPeriod.findUnique({
      where: { id: refund.billingPeriodIdSnapshot },
      select: { periodStart: true, periodEnd: true },
    });
    if (!period || !provider.currentPeriodStart || !provider.currentPeriodEnd) {
      return unsafe("Shopify provider period is unavailable");
    }

    let context: string;
    try {
      context = deriveShopifyProviderContextIdentity({
        providerSubscriptionId: provider.providerSubscriptionId,
        planHandle: provider.planHandle,
        currentPeriodStart: provider.currentPeriodStart,
        currentPeriodEnd: provider.currentPeriodEnd,
      });
    } catch {
      return unsafe("Shopify provider context identity is unavailable");
    }

    if (
      context !== refund.providerSubscriptionIdSnapshot
      || provider.planHandle !== refund.planHandleSnapshot
      || provider.currentPeriodStart.getTime() !== period.periodStart.getTime()
      || provider.currentPeriodEnd.getTime() !== period.periodEnd.getTime()
      || !provider.usageEventHandles.includes(refund.eventHandleSnapshot)
    ) {
      return unsafe("Shopify provider context does not match frozen refund provenance");
    }

    const usage = provider.providerUsageSnapshot.find(
      (item) => item.handle === refund.eventHandleSnapshot,
    );
    const quantity = parseDecimal(usage?.quantity);
    const cost = parseDecimal(usage?.costAmount);
    const currency = usage?.costCurrency?.trim().toUpperCase();
    if (!quantity || !cost || cost.lt(0) || !currency) {
      return unsafe("Shopify provider quantity, cost, or currency is unavailable");
    }

    const pricing = provider.providerUsagePricingSnapshot?.find(
      (item) => item.handle === refund.eventHandleSnapshot,
    );
    return {
      safe: true,
      quantity,
      cost,
      currency,
      ...(pricing ? { pricing } : {}),
    };
  }

  async readForPrepare(
    refund: RefundProviderStateInput,
  ): Promise<RefundProviderPreparationStateProof> {
    const state = await this.read(refund);
    if (!state.safe) return state;
    if (!state.pricing || state.pricing.currency?.toUpperCase() !== state.currency) {
      return unsafe("Shopify provider pricing is unavailable or ambiguous");
    }
    return { ...state, pricing: state.pricing };
  }
}

function parseDecimal(
  value: string | number | Prisma.Decimal | null | undefined,
): Prisma.Decimal | null {
  if (value === null || value === undefined) return null;
  try {
    const decimal = new Prisma.Decimal(value);
    return decimal.isFinite() ? decimal : null;
  } catch {
    return null;
  }
}

function unsafe(reason: string): UnsafeProviderStateProof {
  return { safe: false, reason };
}
