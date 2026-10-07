import {
  Prisma,
  RecoveryCreditPurchaseStatus,
  RecoveryCreditRefundStatus,
} from "@prisma/client";
import { vi } from "vitest";

import type { RefundRow } from "../../../../src/services/recovery-credit-refund-correction/refund-correction.types.js";
import { RefundPreparationService } from "../../../../src/services/recovery-credit-refund-correction/refund-preparation.service.js";
import type { RefundProviderPreparationStateProof } from "../../../../src/services/recovery-credit-refund-correction/refund-provider-state.service.js";

type SafeProviderProof = Extract<RefundProviderPreparationStateProof, { safe: true }>;

export function refundRow(overrides: Partial<RefundRow> = {}): RefundRow {
  return {
    id: "refund-1",
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    shopId: "shop-1",
    status: RecoveryCreditRefundStatus.REQUESTED,
    reason: null,
    purchaseId: "purchase-1",
    billingPeriodIdSnapshot: "period-1",
    providerSubscriptionIdSnapshot: "provider-context-1",
    planHandleSnapshot: "pro-2026",
    eventHandleSnapshot: "pack-meter",
    shopifyPartnerDevelopmentSnapshot: false,
    purchaseProviderAmountSnapshot: new Prisma.Decimal("1.00"),
    purchaseProviderCurrencySnapshot: "USD",
    finalCreditQuantity: null,
    expectedProviderAmount: null,
    expectedProviderCurrency: null,
    automaticCorrectionUsageEventId: null,
    providerUsageQuantityBeforeCorrection: null,
    providerUsageCostBeforeCorrection: null,
    expectedProviderUsageQuantityAfterCorrection: null,
    expectedProviderUsageCostAfterCorrection: null,
    version: 0,
    purchase: {
      usageEventId: "purchase-event-1",
      status: RecoveryCreditPurchaseStatus.WITHDRAWN,
      currentAmount: 1,
      reservedAmount: 0,
      creditsGranted: 1,
    },
    shop: { shopifyShopId: "gid://shopify/Shop/1" },
    automaticCorrectionUsageEvent: null,
    ...overrides,
  };
}

export function providerProof(overrides: Partial<SafeProviderProof> = {}): SafeProviderProof {
  return {
    safe: true as const,
    quantity: new Prisma.Decimal("1"),
    cost: new Prisma.Decimal("1.00"),
    currency: "USD",
    pricing: {
      handle: "pack-meter",
      currency: "USD",
      tiersMode: "VOLUME",
      tiers: [{ upTo: null, amountPerUnit: "1.00", amount: "0.00" }],
    },
    ...overrides,
  };
}

export function preparationHarness(
  row = refundRow(),
  proof: RefundProviderPreparationStateProof = providerProof(),
) {
  const refundUpdate = vi.fn().mockResolvedValue({ count: 1 });
  const usageUpsert = vi.fn().mockResolvedValue({ id: "correction-event-1" });
  const database = {
    recoveryCreditRefund: {
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: refundUpdate,
    },
    usageEvent: { upsert: usageUpsert },
    $transaction: vi.fn().mockImplementation(
      async (callback: (transaction: unknown) => unknown) => callback(database),
    ),
  };
  const providerState = {
    readForPrepare: vi.fn().mockResolvedValue(proof),
  };
  const now = vi.fn(() => new Date("2026-09-15T12:00:00.000Z"));
  const service = new RefundPreparationService(
    database as never,
    providerState as never,
    now,
  );
  return { row, database, providerState, now, service };
}
