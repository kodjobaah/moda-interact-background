import {
  Prisma,
  type RecoveryCreditPurchaseStatus,
  type RecoveryCreditRefundStatus,
  type ShopifyReportState,
} from "@prisma/client";

export type RefundRow = {
  id: string;
  createdAt: Date;
  shopId: string;
  status: RecoveryCreditRefundStatus;
  reason: string | null;
  purchaseId: string;
  billingPeriodIdSnapshot: string;
  providerSubscriptionIdSnapshot: string;
  planHandleSnapshot: string;
  eventHandleSnapshot: string;
  shopifyPartnerDevelopmentSnapshot: boolean;
  purchaseProviderAmountSnapshot: Prisma.Decimal;
  purchaseProviderCurrencySnapshot: string;
  finalCreditQuantity: number | null;
  expectedProviderAmount: Prisma.Decimal | null;
  expectedProviderCurrency: string | null;
  automaticCorrectionUsageEventId: string | null;
  providerUsageQuantityBeforeCorrection: Prisma.Decimal | null;
  providerUsageCostBeforeCorrection: Prisma.Decimal | null;
  expectedProviderUsageQuantityAfterCorrection: Prisma.Decimal | null;
  expectedProviderUsageCostAfterCorrection: Prisma.Decimal | null;
  version: number;
  purchase: {
    usageEventId: string;
    status: RecoveryCreditPurchaseStatus;
    currentAmount: number;
    reservedAmount: number;
    creditsGranted: number;
  };
  shop: { shopifyShopId: string | null };
  automaticCorrectionUsageEvent: {
    id: string;
    quantity: Prisma.Decimal;
    correctionOfUsageEventId: string | null;
    sourceType: string | null;
    sourceId: string | null;
    shopifyEventHandle: string | null;
    shopifyIdempotencyKey: string | null;
    shopifyReportState: ShopifyReportState;
  } | null;
};

export const refundSelect = {
  id: true,
  shopId: true,
  status: true,
  reason: true,
  purchaseId: true,
  createdAt: true,
  billingPeriodIdSnapshot: true,
  providerSubscriptionIdSnapshot: true,
  planHandleSnapshot: true,
  eventHandleSnapshot: true,
  shopifyPartnerDevelopmentSnapshot: true,
  purchaseProviderAmountSnapshot: true,
  purchaseProviderCurrencySnapshot: true,
  finalCreditQuantity: true,
  expectedProviderAmount: true,
  expectedProviderCurrency: true,
  automaticCorrectionUsageEventId: true,
  providerUsageQuantityBeforeCorrection: true,
  providerUsageCostBeforeCorrection: true,
  expectedProviderUsageQuantityAfterCorrection: true,
  expectedProviderUsageCostAfterCorrection: true,
  version: true,
  purchase: {
    select: {
      usageEventId: true,
      status: true,
      currentAmount: true,
      reservedAmount: true,
      creditsGranted: true,
    },
  },
  shop: { select: { shopifyShopId: true } },
  automaticCorrectionUsageEvent: {
    select: {
      id: true,
      quantity: true,
      correctionOfUsageEventId: true,
      sourceType: true,
      sourceId: true,
      shopifyEventHandle: true,
      shopifyIdempotencyKey: true,
      shopifyReportState: true,
    },
  },
} as const;
